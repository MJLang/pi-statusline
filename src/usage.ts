// Adapted from @mtrojnar/pi-usage and @tian.zuo/pi-usage (MIT).
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type UsageStatus = "allowed" | "allowed_warning" | "rejected";
export type UsageSource = "headers" | "stream";
export type UsageProvider = "anthropic" | "openai-codex";

export interface UsageWindow {
	label: string;
	minutes: number;
	usedPct?: number;
	resetAt?: number;
	status?: UsageStatus;
}

export interface ProviderUsage {
	observedAt: number;
	source: UsageSource;
	status?: UsageStatus;
	claim?: string;
	windows: UsageWindow[];
}

export interface UsageCache {
	version: 1;
	anthropic?: ProviderUsage;
	"openai-codex"?: ProviderUsage;
}

const usageCachePath = join(homedir(), ".pi", "agent", "cache", "pi-statusline-usage.json");

// Round provider windows to hours or days; use w for every rounded seven-day window.
export function labelForWindow(minutes: number): string | undefined {
	if (!Number.isFinite(minutes) || minutes <= 0) return undefined;
	if (minutes < 1440) return `${Math.max(1, Math.round(minutes / 60))}h`;
	const days = Math.round(minutes / 1440);
	return days === 7 ? "w" : `${days}d`;
}

function emptyUsageCache(): UsageCache {
	return { version: 1 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is UsageStatus {
	return value === "allowed" || value === "allowed_warning" || value === "rejected";
}

function readWindow(value: unknown): UsageWindow | undefined {
	if (!isRecord(value) || typeof value.label !== "string") return undefined;
	if (typeof value.minutes !== "number" || !Number.isFinite(value.minutes) || value.minutes <= 0) {
		return undefined;
	}
	if (
		value.usedPct !== undefined &&
		(typeof value.usedPct !== "number" || !Number.isFinite(value.usedPct))
	) {
		return undefined;
	}
	if (
		value.resetAt !== undefined &&
		(typeof value.resetAt !== "number" || !Number.isFinite(value.resetAt))
	) {
		return undefined;
	}
	return {
		label: value.label,
		minutes: value.minutes,
		...(typeof value.usedPct === "number" ? { usedPct: value.usedPct } : {}),
		...(typeof value.resetAt === "number" ? { resetAt: value.resetAt } : {}),
		...(isStatus(value.status) ? { status: value.status } : {}),
	};
}

function readProvider(value: unknown): ProviderUsage | undefined {
	if (
		!isRecord(value) ||
		typeof value.observedAt !== "number" ||
		!Number.isFinite(value.observedAt)
	) {
		return undefined;
	}
	if (value.source !== "headers" && value.source !== "stream") return undefined;
	if (!Array.isArray(value.windows)) return undefined;
	const windows = value.windows.map(readWindow);
	if (windows.some((window) => window === undefined)) return undefined;
	return {
		observedAt: value.observedAt,
		source: value.source,
		...(isStatus(value.status) ? { status: value.status } : {}),
		...(typeof value.claim === "string" ? { claim: value.claim } : {}),
		windows: windows as UsageWindow[],
	};
}

function parseCache(value: unknown): UsageCache {
	if (!isRecord(value) || value.version !== 1) return emptyUsageCache();
	const anthropic = readProvider(value.anthropic);
	const codex = readProvider(value["openai-codex"]);
	return {
		version: 1,
		...(anthropic ? { anthropic } : {}),
		...(codex ? { "openai-codex": codex } : {}),
	};
}

export async function readUsageCache(): Promise<UsageCache> {
	try {
		return parseCache(JSON.parse(await readFile(usageCachePath, "utf8")) as unknown);
	} catch {
		return emptyUsageCache();
	}
}

export async function mergeUsage(
	provider: UsageProvider,
	observation: ProviderUsage,
): Promise<boolean> {
	let temporaryPath: string | undefined;
	try {
		const cache = await readUsageCache();
		const previous = cache[provider];
		if (previous && observation.observedAt <= previous.observedAt) return false;

		// Skip the write when only the time changed and the saved value is less than a minute old.
		const sameValues =
			previous &&
			JSON.stringify({ ...previous, observedAt: 0 }) ===
				JSON.stringify({ ...observation, observedAt: 0 });
		if (sameValues && observation.observedAt - previous.observedAt < 60_000) return false;

		const next: UsageCache = { ...cache, [provider]: observation };

		await mkdir(dirname(usageCachePath), { recursive: true });
		temporaryPath = `${usageCachePath}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
		await rename(temporaryPath, usageCachePath);
		return true;
	} catch {
		if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined);
		return false;
	}
}
