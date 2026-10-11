// Adapted from @mtrojnar/pi-usage and @tian.zuo/pi-usage (MIT).
import { labelForWindow, type ProviderUsage, type UsageWindow } from "./usage.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function eventWindow(
	value: unknown,
	blocked: boolean,
	observedAt: number,
): UsageWindow | undefined {
	if (!isRecord(value)) return undefined;
	const minutes = numberValue(value.window_minutes);
	if (minutes === undefined || minutes <= 0) return undefined;
	const label = labelForWindow(minutes);
	if (!label) return undefined;
	const usedPctValue = numberValue(value.used_percent);
	const usedPct =
		usedPctValue !== undefined && usedPctValue >= 0 && usedPctValue <= 100
			? usedPctValue
			: undefined;
	const resetValue = numberValue(value.reset_at);
	const resetAfter = numberValue(value.reset_after_seconds);
	const resetAt =
		resetValue !== undefined && resetValue > 0
			? resetValue
			: resetAfter !== undefined && resetAfter >= 0
				? observedAt / 1000 + resetAfter
				: undefined;
	if (usedPct === undefined && resetAt === undefined && !blocked) return undefined;
	return {
		label,
		minutes,
		...(usedPct !== undefined ? { usedPct } : {}),
		...(resetAt !== undefined ? { resetAt } : {}),
		...(blocked ? { status: "rejected" as const } : {}),
	};
}

export function parseCodexEvent(data: unknown, observedAt = Date.now()): ProviderUsage | undefined {
	try {
		if (!isRecord(data) || data.type !== "codex.rate_limits") return undefined;
		const limits = isRecord(data.rate_limits) ? data.rate_limits : undefined;
		const blocked =
			data.allowed === false ||
			data.limit_reached === true ||
			limits?.allowed === false ||
			limits?.limit_reached === true;
		const primary = eventWindow(limits?.primary, blocked, observedAt);
		const secondary = eventWindow(limits?.secondary, blocked, observedAt);
		const windows = [primary, secondary].filter(
			(window): window is UsageWindow => window !== undefined,
		);
		if (windows.length === 0 && !blocked) return undefined;
		return {
			observedAt,
			source: "stream",
			...(blocked ? { status: "rejected" as const } : {}),
			windows,
		};
	} catch {
		return undefined;
	}
}

function headerNumber(headers: Map<string, string>, name: string): number | undefined {
	const value = headers.get(name);
	if (value === undefined || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseCodexHeaders(
	headers: Record<string, string>,
	observedAt = Date.now(),
): ProviderUsage | undefined {
	try {
		const values = new Map<string, string>();
		for (const [name, value] of Object.entries(headers)) {
			const lowerName = name.toLowerCase();
			if (lowerName.startsWith("x-codex-primary-") || lowerName.startsWith("x-codex-secondary-")) {
				values.set(lowerName, value);
			}
		}

		const windows: UsageWindow[] = [];
		for (const family of ["primary", "secondary"] as const) {
			const prefix = `x-codex-${family}-`;
			const usedPct = headerNumber(values, `${prefix}used-percent`);
			const minutes = headerNumber(values, `${prefix}window-minutes`);
			const resetAt = headerNumber(values, `${prefix}reset-at`);
			if (
				usedPct === undefined ||
				usedPct < 0 ||
				usedPct > 100 ||
				minutes === undefined ||
				minutes <= 0
			) {
				continue;
			}
			const label = labelForWindow(minutes);
			if (!label) continue;
			windows.push({
				label,
				minutes,
				usedPct,
				...(resetAt !== undefined && resetAt > 0 ? { resetAt } : {}),
			});
		}
		if (windows.length === 0) return undefined;
		return { observedAt, source: "headers", windows };
	} catch {
		return undefined;
	}
}
