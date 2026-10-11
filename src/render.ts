import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { relative, isAbsolute, sep } from "node:path";
import { parseFooterStatuses, type FooterStatuses } from "./statuses.ts";
import {
	labelForWindow,
	type ProviderUsage,
	type UsageProvider,
	type UsageStatus,
	type UsageWindow,
} from "./usage.ts";

const STALE_AFTER_MS = 15 * 60 * 1000;

export interface RenderState {
	cwd: string;
	home: string;
	branch: string | null;
	sessionName?: string;
	modelName: string;
	reasoning: boolean;
	thinkingLevel: string;
	contextPercent: number | null;
	cost: number;
	usageProvider?: UsageProvider;
	usage?: ProviderUsage;
	now: number;
	statuses: ReadonlyMap<string, string>;
}

interface Segment {
	plain: string;
	styled: string;
}

function segment(plain: string, color: Parameters<Theme["fg"]>[0], theme: Theme): Segment {
	return { plain, styled: theme.fg(color, plain) };
}

function homePath(cwd: string, home: string): string {
	if (!home) return cwd;
	const fromHome = relative(home, cwd);
	const insideHome =
		fromHome === "" ||
		(fromHome !== ".." && !fromHome.startsWith(`..${sep}`) && !isAbsolute(fromHome));
	if (!insideHome) return cwd;
	return fromHome === "" ? "~" : `~${sep}${fromHome}`;
}

function clipSessionName(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const chars = Array.from(value);
	return chars.length > 50 ? `${chars.slice(0, 49).join("")}…` : value;
}

function widthOf(segments: Segment[]): number {
	return segments.reduce(
		(width, item, index) => width + visibleWidth(item.styled) + (index ? 2 : 0),
		0,
	);
}

function joinSegments(segments: Segment[]): string {
	return segments.map((item) => item.styled).join("  ");
}

function boundedStatusRight(statuses: Segment[], width: number): string {
	if (statuses.length === 0) return "";
	const joined = joinSegments(statuses);
	return visibleWidth(joined) > width ? truncateToWidth(joined, width, "…") : joined;
}

function fitFirstLineLeft(
	cwd: Segment,
	branch: Segment | undefined,
	session: Segment | undefined,
	maxWidth: number,
	theme: Theme,
): string {
	const later = [branch, session].filter((item): item is Segment => item !== undefined);
	let laterWidth = widthOf(later);
	if (laterWidth > maxWidth && session) {
		later.pop();
		laterWidth = widthOf(later);
	}
	if (laterWidth > maxWidth && later.length > 0) {
		const onlyBranch = later[0];
		const clipped = truncateToWidth(onlyBranch.plain, maxWidth, "…");
		later.splice(0, later.length, { plain: clipped, styled: theme.fg("accent", clipped) });
		laterWidth = visibleWidth(later[0].styled);
	}
	const gaps = later.length ? 2 : 0;
	const cwdBudget = Math.max(0, maxWidth - laterWidth - gaps);
	const cwdText =
		visibleWidth(cwd.styled) > cwdBudget ? truncateToWidth(cwd.plain, cwdBudget, "…") : cwd.plain;
	const left = [{ plain: cwdText, styled: theme.fg("muted", cwdText) }, ...later].filter(
		(item) => item.plain !== "",
	);
	return joinSegments(left);
}

function makeOpenVikingSegments(
	statuses: FooterStatuses,
	theme: Theme,
	withCount: boolean,
): Segment[] {
	const openviking = statuses.openviking;
	if (!openviking) return [];
	if (openviking.state === "connected") {
		const count = withCount && openviking.count ? ` ${openviking.count}` : "";
		const main: Segment = {
			plain: `OV ✓${count}`,
			styled: `${theme.fg("dim", "OV")} ${theme.fg("success", "✓")}${count ? ` ${theme.fg("dim", openviking.count as string)}` : ""}`,
		};
		const parts = [main];
		if (openviking.toolsFailed) parts.push(segment("tools ✗", "warning", theme));
		return parts;
	}
	if (openviking.state === "down") {
		const parts = [
			{
				plain: "OV ✗",
				styled: `${theme.fg("dim", "OV")} ${theme.fg("error", "✗")}`,
			},
		];
		if (openviking.toolsFailed) parts.push(segment("tools ✗", "warning", theme));
		return parts;
	}
	return openviking.fallback ? [segment(openviking.fallback, "dim", theme)] : [];
}

function renderFirstLine(state: RenderState, width: number, theme: Theme): string {
	const parsed = parseFooterStatuses(state.statuses);
	const cwd = segment(homePath(state.cwd, state.home), "muted", theme);
	const branch = state.branch ? segment(state.branch, "accent", theme) : undefined;
	const clippedSession = clipSessionName(state.sessionName);
	const session = clippedSession ? segment(`· ${clippedSession}`, "dim", theme) : undefined;
	const lf = parsed.langfuseOff ? segment("LF off", "dim", theme) : undefined;
	let ov = makeOpenVikingSegments(parsed, theme, true);
	let hasSession = session !== undefined;
	let hasLf = lf !== undefined;
	let hasOv = ov.length > 0;

	const statusParts = (): Segment[] => [...(hasOv ? ov : []), ...(hasLf && lf ? [lf] : [])];
	const leftParts = (): Segment[] => [
		cwd,
		...(branch ? [branch] : []),
		...(hasSession && session ? [session] : []),
	];
	const tooWide = (): boolean => {
		const right = boundedStatusRight(statusParts(), width);
		const rightWidth = visibleWidth(right);
		const leftWidth = widthOf(leftParts());
		return leftWidth + rightWidth + (right ? 2 : 0) > width;
	};

	if (tooWide() && hasSession) hasSession = false;
	if (tooWide() && hasLf) hasLf = false;
	if (tooWide() && hasOv) {
		ov = makeOpenVikingSegments(parsed, theme, false);
	}
	if (tooWide() && hasOv) hasOv = false;

	let right = boundedStatusRight(statusParts(), width);
	let rightWidth = visibleWidth(right);
	const rightGap = right ? 2 : 0;
	const allowedLeft = Math.max(0, width - rightWidth - rightGap);
	let left = fitFirstLineLeft(cwd, branch, hasSession ? session : undefined, allowedLeft, theme);
	if (visibleWidth(left) + rightWidth + rightGap > width) {
		right = truncateToWidth(right, Math.max(0, width - visibleWidth(left) - 1), "…");
		rightWidth = visibleWidth(right);
	}
	const padding = right ? Math.max(1, width - visibleWidth(left) - rightWidth) : 0;
	const result = `${left}${" ".repeat(padding)}${right}`;
	return visibleWidth(result) > width ? truncateToWidth(result, width, "…") : result;
}

function percentColor(
	percent: number,
	forcedStatus: UsageStatus | undefined,
): "text" | "warning" | "error" {
	if (forcedStatus === "rejected" || percent >= 90) return "error";
	if (forcedStatus === "allowed_warning" || percent >= 70) return "warning";
	return "text";
}

function countdown(resetAt: number, now: number): string {
	const minutes = Math.max(1, Math.ceil((resetAt * 1000 - now) / 60000));
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const rest = minutes % 60;
	if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
	if (hours > 0) return rest > 0 ? `${hours}h${rest}` : `${hours}h`;
	return `${minutes}m`;
}

function effectivePercent(
	window: UsageWindow,
	usage: ProviderUsage | undefined,
	now: number,
): { percent?: number; stale: boolean; status?: UsageStatus; reset: boolean } {
	// Parsers put the status on each window it applies to.
	const status = window.status;
	const reset = window.resetAt !== undefined && now >= window.resetAt * 1000;
	const stale = !reset && usage !== undefined && now - usage.observedAt > STALE_AFTER_MS;
	if (reset) return { percent: 0, stale: false, reset: true };
	if (status === "rejected") return { percent: 100, stale, status, reset: false };
	const percent =
		typeof window.usedPct === "number" && Number.isFinite(window.usedPct)
			? Math.min(100, Math.max(0, Math.floor(window.usedPct)))
			: undefined;
	return { ...(percent !== undefined ? { percent } : {}), stale, status, reset: false };
}

function renderWindow(
	window: UsageWindow,
	usage: ProviderUsage | undefined,
	now: number,
	theme: Theme,
): string {
	const label = labelForWindow(window.minutes) ?? window.label;
	const value = effectivePercent(window, usage, now);
	const labelText = label ? `${theme.fg("dim", label)} ` : "";
	if (value.percent === undefined) return `${labelText}${theme.fg("dim", "–")}`;
	const percentText = `${value.percent}%`;
	const color = value.stale ? "dim" : percentColor(value.percent, value.status);
	let output = `${labelText}${theme.fg(color, percentText)}`;
	const alarm =
		value.status === "rejected" || value.status === "allowed_warning" || value.percent >= 70;
	if (
		!value.stale &&
		!value.reset &&
		alarm &&
		window.resetAt !== undefined &&
		window.resetAt * 1000 > now
	) {
		output += ` ${theme.fg("dim", `↻${countdown(window.resetAt, now)}`)}`;
	}
	return output;
}

function usageParts(state: RenderState, theme: Theme): string[] {
	if (state.usageProvider) {
		let windows = state.usage?.windows ?? [];
		if (state.usageProvider === "anthropic") {
			windows = [
				windows.find((window) => window.minutes === 300) ?? { label: "5h", minutes: 300 },
				windows.find((window) => window.minutes === 10080) ?? { label: "w", minutes: 10080 },
			];
		}
		if (windows.length === 0) return [theme.fg("dim", "–")];
		return windows.map((window) => renderWindow(window, state.usage, state.now, theme));
	}
	return [theme.fg("text", `$${Math.max(0, state.cost).toFixed(2)}`)];
}

function renderSecondLine(state: RenderState, width: number, theme: Theme): string {
	let usage = usageParts(state, theme);
	const isTwoWindowUsage = Boolean(state.usageProvider && usage.length === 2);
	const usageText = (): string => usage.join("  ");
	const contextPercent = state.contextPercent;
	const roundedContext =
		typeof contextPercent === "number" && Number.isFinite(contextPercent)
			? Math.min(100, Math.max(0, Math.floor(contextPercent)))
			: undefined;
	const contextValue = roundedContext === undefined ? "?" : `${roundedContext}%`;
	const contextColor =
		roundedContext === undefined ? "dim" : percentColor(roundedContext, undefined);
	const context = `${theme.fg("dim", "ctx")} ${theme.fg(contextColor, contextValue)}`;
	let model = state.modelName || "no model";
	let showThinking = state.reasoning;
	let thinkingLevel = state.thinkingLevel.toLowerCase();
	const thinkingColors: Record<string, Parameters<Theme["fg"]>[0]> = {
		off: "thinkingOff",
		minimal: "thinkingMinimal",
		low: "thinkingLow",
		medium: "thinkingMedium",
		high: "thinkingHigh",
		xhigh: "thinkingXhigh",
		max: "thinkingMax",
	};
	if (!thinkingColors[thinkingLevel]) thinkingLevel = "off";
	let right = usageText();
	const leftWidth = (modelText: string, includeThinking: boolean): number => {
		const modelWidth = visibleWidth(theme.fg("text", modelText));
		const thinkingWidth = includeThinking
			? 1 + visibleWidth(theme.fg(thinkingColors[thinkingLevel], thinkingLevel))
			: 0;
		return modelWidth + thinkingWidth + 2 + visibleWidth(context);
	};
	const rightGap = 2;

	if (isTwoWindowUsage && leftWidth(model, showThinking) + visibleWidth(right) + rightGap > width) {
		let longWindowIndex = 1;
		if (state.usageProvider === "openai-codex" && state.usage?.windows.length === 2) {
			longWindowIndex = state.usage.windows[0].minutes > state.usage.windows[1].minutes ? 0 : 1;
		}
		usage.splice(longWindowIndex, 1);
		right = usageText();
	}
	if (leftWidth(model, showThinking) + visibleWidth(right) + rightGap > width && showThinking) {
		showThinking = false;
	}
	const thinkingWidth = showThinking
		? 1 + visibleWidth(theme.fg(thinkingColors[thinkingLevel], thinkingLevel))
		: 0;
	let modelBudget = width - visibleWidth(context) - visibleWidth(right) - 4 - thinkingWidth;
	if (modelBudget < 1) {
		const rightBudget = Math.max(1, width - visibleWidth(context) - thinkingWidth - 5);
		right = truncateToWidth(right, rightBudget, "…");
		modelBudget = width - visibleWidth(context) - visibleWidth(right) - 4 - thinkingWidth;
	}
	if (visibleWidth(theme.fg("text", model)) > Math.max(1, modelBudget)) {
		model = truncateToWidth(model, Math.max(1, modelBudget), "…");
	}
	const modelPart = [
		theme.fg("text", model),
		...(showThinking ? [theme.fg(thinkingColors[thinkingLevel], thinkingLevel)] : []),
	].join(" ");
	const left = `${modelPart}  ${context}`;
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	const result = `${left}${" ".repeat(gap)}${right}`;
	return visibleWidth(result) > width ? truncateToWidth(result, width, "…") : result;
}

export function renderFooter(state: RenderState, width: number, theme: Theme): string[] {
	const safeWidth = Math.max(0, Math.floor(width));
	const firstLine = renderFirstLine(state, safeWidth, theme);
	const secondLine = renderSecondLine(state, safeWidth, theme);
	return [firstLine, secondLine];
}
