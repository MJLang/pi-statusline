import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// Pi owns runtime modules; use coding-agent types, pure TUI helpers, and callback-provided themes.
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseAnthropicHeaders } from "./anthropic.ts";
import { parseCodexEvent, parseCodexHeaders } from "./codex.ts";
import { renderFooter, type RenderState } from "./render.ts";
import {
	mergeUsage,
	readUsageCache,
	type ProviderUsage,
	type UsageCache,
	type UsageProvider,
} from "./usage.ts";

const errorLogPath = join(homedir(), ".pi", "agent", "cache", "pi-statusline-error.log");
const errorLogMarker = Symbol.for("@mjlang/pi-statusline/render-error-logged");
const processState = globalThis as unknown as { [key: symbol]: boolean | undefined };

function safeHandler(action: () => void | Promise<void>): void | Promise<void> {
	try {
		const result = action();
		if (result) return result.catch(() => undefined);
	} catch {
		return undefined;
	}
}

function logFirstRenderError(error: unknown): void {
	if (processState[errorLogMarker]) return;
	processState[errorLogMarker] = true;
	try {
		const message = error instanceof Error ? error.message : String(error);
		const stack = error instanceof Error ? (error.stack ?? "") : "";
		mkdirSync(join(homedir(), ".pi", "agent", "cache"), { recursive: true });
		appendFileSync(errorLogPath, `${message}\n${stack}\n`, "utf8");
	} catch {
		// A broken cache directory must not break the footer.
	}
}

function paidCost(ctx: ExtensionContext): number {
	let total = 0;
	const include = (provider: unknown, modelId: unknown): boolean => {
		if (typeof provider !== "string" || typeof modelId !== "string") return true;
		if (provider !== "anthropic" && provider !== "openai-codex") return true;
		const model = ctx.modelRegistry.find(provider, modelId);
		return !model || !ctx.modelRegistry.isUsingOAuth(model);
	};
	const add = (usage: unknown, provider?: unknown, modelId?: unknown): void => {
		if (!include(provider, modelId) || typeof usage !== "object" || usage === null) return;
		const cost = (usage as { cost?: { total?: unknown } }).cost?.total;
		if (typeof cost === "number" && Number.isFinite(cost)) total += cost;
	};

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "assistant") add(message.usage, message.provider, message.model);
			else if (message.role === "toolResult") {
				const details = message as typeof message & { provider?: string; model?: string };
				add(message.usage, details.provider, details.model);
			}
		} else if (entry.type === "usage") {
			add(entry.usage, entry.provider, entry.model);
		} else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
			const details = entry as typeof entry & { provider?: string; model?: string };
			add(entry.usage, details.provider, details.model);
		}
	}
	return total;
}

function currentProvider(ctx: ExtensionContext, model = ctx.model): UsageProvider | undefined {
	if (!model || (model.provider !== "anthropic" && model.provider !== "openai-codex"))
		return undefined;
	return ctx.modelRegistry.isUsingOAuth(model) ? model.provider : undefined;
}

function makeRenderState(
	ctx: ExtensionContext,
	usageCache: UsageCache,
	model = ctx.model,
	thinkingLevel?: string,
	costOverride?: number,
): RenderState {
	const usageProvider = currentProvider(ctx, model);
	const context = ctx.getContextUsage();
	const modelName = model?.name?.replace(/^Claude\s+/i, "") || model?.id || "no model";
	return {
		cwd: ctx.sessionManager.getCwd(),
		home: homedir(),
		branch: null,
		sessionName: ctx.sessionManager.getSessionName(),
		modelName,
		reasoning: Boolean(model?.reasoning),
		thinkingLevel: thinkingLevel ?? ctx.thinkingLevel ?? "off",
		contextPercent: context?.percent ?? null,
		cost: costOverride ?? paidCost(ctx),
		...(usageProvider ? { usageProvider } : {}),
		...(usageProvider && usageCache[usageProvider] ? { usage: usageCache[usageProvider] } : {}),
		now: Date.now(),
		statuses: new Map(),
	};
}

export default function (pi: ExtensionAPI): void {
	let usageCache: UsageCache = { version: 1 };
	let latestState: RenderState | undefined;
	let activeTui: { requestRender(): void } | undefined;
	let rereadTimer: ReturnType<typeof setInterval> | undefined;
	let unsubscribeBranch: (() => void) | undefined;

	function requestRender(): void {
		try {
			activeTui?.requestRender();
		} catch {
			// Pi can dispose the TUI while an event is still running.
		}
	}

	function updateState(
		ctx: ExtensionContext,
		model = ctx.model,
		thinkingLevel?: string,
		recomputeCost = true,
	): void {
		if (ctx.mode !== "tui") return;
		latestState = makeRenderState(
			ctx,
			usageCache,
			model,
			thinkingLevel ?? pi.getThinkingLevel(),
			recomputeCost ? undefined : (latestState?.cost ?? 0),
		);
		requestRender();
	}

	async function saveObservation(
		provider: UsageProvider,
		observation: ProviderUsage,
		ctx: ExtensionContext,
	): Promise<void> {
		const current = usageCache[provider];
		if (!current || observation.observedAt > current.observedAt) {
			usageCache = { ...usageCache, [provider]: observation };
		}
		await mergeUsage(provider, observation);
		const latest = await readUsageCache();
		const saved = latest[provider];
		const local = usageCache[provider];
		if (saved && (!local || saved.observedAt > local.observedAt)) {
			usageCache = { ...usageCache, [provider]: saved };
		}
		updateState(ctx);
	}

	pi.on("session_start", (_event, ctx) =>
		safeHandler(async () => {
			usageCache = await readUsageCache();
			if (ctx.mode !== "tui") return;
			latestState = makeRenderState(ctx, usageCache, ctx.model, pi.getThinkingLevel());
			ctx.ui.setFooter((tui, theme, footerData) => {
				activeTui = tui;
				unsubscribeBranch?.();
				unsubscribeBranch = footerData.onBranchChange(() =>
					safeHandler(() => {
						requestRender();
					}),
				);
				return {
					dispose: () => {
						try {
							unsubscribeBranch?.();
						} finally {
							unsubscribeBranch = undefined;
							if (activeTui === tui) activeTui = undefined;
						}
					},
					invalidate() {},
					render(width: number): string[] {
						try {
							if (!latestState) throw new Error("Footer state is not ready");
							const state = latestState;
							return renderFooter(
								{
									...state,
									branch: footerData.getGitBranch(),
									statuses: footerData.getExtensionStatuses(),
								},
								width,
								theme,
							);
						} catch (error) {
							logFirstRenderError(error);
							const message = "footer error · /reload";
							try {
								return [truncateToWidth(theme.fg("dim", message), width, "")];
							} catch {
								return [truncateToWidth(message, width, "")];
							}
						}
					},
				};
			});
			if (!rereadTimer) {
				rereadTimer = setInterval(
					() =>
						safeHandler(async () => {
							usageCache = await readUsageCache();
							updateState(ctx);
						}),
					60_000,
				);
			}
		}),
	);

	pi.on("model_select", (event, ctx) =>
		safeHandler(async () => {
			usageCache = await readUsageCache();
			updateState(ctx, event.model, pi.getThinkingLevel());
		}),
	);

	pi.on("thinking_level_select", (event, ctx) =>
		safeHandler(() => {
			updateState(ctx, ctx.model, event.level);
		}),
	);

	pi.on("session_info_changed", (_event, ctx) => safeHandler(() => updateState(ctx)));
	pi.on("message_update", (_event, ctx) =>
		safeHandler(() => updateState(ctx, ctx.model, pi.getThinkingLevel(), false)),
	);
	pi.on("message_end", (_event, ctx) =>
		safeHandler(() => updateState(ctx, ctx.model, pi.getThinkingLevel())),
	);
	pi.on("turn_end", (_event, ctx) =>
		safeHandler(() => updateState(ctx, ctx.model, pi.getThinkingLevel())),
	);

	// Pi awaits these two handlers on the stream path, so do not wait for the cache write.
	function saveInBackground(
		provider: UsageProvider,
		observation: ProviderUsage,
		ctx: ExtensionContext,
	): void {
		saveObservation(provider, observation, ctx).catch(() => undefined);
	}

	pi.on("after_provider_response", (event, ctx) =>
		safeHandler(() => {
			const anthropic = parseAnthropicHeaders(event.headers);
			if (anthropic) saveInBackground("anthropic", anthropic, ctx);
			const codex = parseCodexHeaders(event.headers);
			if (codex) saveInBackground("openai-codex", codex, ctx);
		}),
	);

	pi.on("provider_stream_event", (event, ctx) =>
		safeHandler(() => {
			if (event.provider !== "openai-codex") return;
			const codex = parseCodexEvent(event.data);
			if (codex) saveInBackground("openai-codex", codex, ctx);
		}),
	);

	pi.on("session_shutdown", (_event, ctx) =>
		safeHandler(() => {
			if (rereadTimer) clearInterval(rereadTimer);
			rereadTimer = undefined;
			unsubscribeBranch?.();
			unsubscribeBranch = undefined;
			activeTui = undefined;
			if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
		}),
	);
}
