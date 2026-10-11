// Adapted from @mtrojnar/pi-usage and @tian.zuo/pi-usage (MIT).
import { type ProviderUsage, type UsageStatus, type UsageWindow } from "./usage.ts";

const HEADER_PREFIX = "anthropic-ratelimit-unified-";

function asStatus(value: string | undefined): UsageStatus | undefined {
	const status = value?.toLowerCase();
	return status === "allowed" || status === "allowed_warning" || status === "rejected"
		? status
		: undefined;
}

const SEVERITY: Record<UsageStatus, number> = { allowed: 0, allowed_warning: 1, rejected: 2 };

function worst(a: UsageStatus | undefined, b: UsageStatus | undefined): UsageStatus | undefined {
	if (!a || !b) return a ?? b;
	return SEVERITY[b] > SEVERITY[a] ? b : a;
}

function asNumber(value: string | undefined): number | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const number = Number(value);
	return Number.isFinite(number) ? number : undefined;
}

function makeWindow(
	label: string,
	minutes: number,
	usedPct: number | undefined,
	resetAt: number | undefined,
	status: UsageStatus | undefined,
): UsageWindow | undefined {
	if (usedPct === undefined && resetAt === undefined && status === undefined) return undefined;
	return {
		label,
		minutes,
		...(usedPct !== undefined ? { usedPct } : {}),
		...(resetAt !== undefined ? { resetAt } : {}),
		...(status ? { status } : {}),
	};
}

export function parseAnthropicHeaders(
	headers: Record<string, string>,
	observedAt = Date.now(),
): ProviderUsage | undefined {
	try {
		const values = new Map<string, string>();
		for (const [name, value] of Object.entries(headers)) {
			const lowerName = name.toLowerCase();
			if (lowerName.startsWith(HEADER_PREFIX))
				values.set(lowerName.slice(HEADER_PREFIX.length), value);
		}
		if (values.size === 0) return undefined;

		const fiveHourUsed = asNumber(values.get("5h-utilization"));
		const weeklyUsed = asNumber(values.get("7d-utilization"));
		const genericReset = asNumber(values.get("reset"));
		const claim = values.get("representative-claim");
		const fiveHourReset =
			asNumber(values.get("5h-reset")) ?? (claim === "five_hour" ? genericReset : undefined);
		const weeklyReset =
			asNumber(values.get("7d-reset")) ??
			(claim?.startsWith("seven_day") ? genericReset : undefined);
		const globalStatus = asStatus(values.get("status"));
		// The overall status belongs to the window in representative-claim (model caps count as
		// weekly). Without a claim it applies to both windows.
		const fiveHourStatus = worst(
			asStatus(values.get("5h-status")),
			!claim || claim === "five_hour" ? globalStatus : undefined,
		);
		const weeklyStatus = worst(
			asStatus(values.get("7d-status")),
			!claim || claim.startsWith("seven_day") ? globalStatus : undefined,
		);

		const fiveHour = makeWindow(
			"5h",
			300,
			fiveHourUsed !== undefined && fiveHourUsed >= 0 && fiveHourUsed <= 1
				? fiveHourUsed * 100
				: undefined,
			fiveHourReset !== undefined && fiveHourReset > 0 ? fiveHourReset : undefined,
			fiveHourStatus,
		);
		const weekly = makeWindow(
			"w",
			10080,
			weeklyUsed !== undefined && weeklyUsed >= 0 && weeklyUsed <= 1 ? weeklyUsed * 100 : undefined,
			weeklyReset !== undefined && weeklyReset > 0 ? weeklyReset : undefined,
			weeklyStatus,
		);

		if (!globalStatus && !fiveHour && !weekly && !claim) return undefined;
		return {
			observedAt,
			source: "headers",
			...(globalStatus ? { status: globalStatus } : {}),
			...(claim ? { claim } : {}),
			windows: [fiveHour, weekly].filter((window): window is UsageWindow => window !== undefined),
		};
	} catch {
		return undefined;
	}
}
