export interface FooterStatuses {
	openviking?: {
		state: "connected" | "down" | "other";
		count?: string;
		toolsFailed: boolean;
		fallback?: string;
	};
	langfuseOff: boolean;
}

function cleanSegment(value: string): string {
	return Array.from(value, (character) => {
		const code = character.charCodeAt(0);
		return code < 32 || code === 127 ? " " : character;
	})
		.join("")
		.trim();
}

export function parseFooterStatuses(statuses: ReadonlyMap<string, string>): FooterStatuses {
	try {
		const rawOpenViking = statuses.get("openviking");
		const segments = rawOpenViking?.split(" · ").map(cleanSegment).filter(Boolean) ?? [];
		const first = segments[0];
		let openviking: FooterStatuses["openviking"];

		if (first === "OV ✓") {
			openviking = {
				state: "connected",
				count: segments.find((segment) => /^↩\d+$/.test(segment)),
				toolsFailed: segments.some((segment) => segment.startsWith("tools ✗")),
			};
		} else if (first === "OV ✗") {
			openviking = {
				state: "down",
				toolsFailed: segments.some((segment) => segment.startsWith("tools ✗")),
			};
		} else if (first) {
			openviking = { state: "other", toolsFailed: false, fallback: first };
		}

		const langfuseOff = statuses.get("langfuse")?.startsWith("langfuse: off") ?? false;
		return { ...(openviking ? { openviking } : {}), langfuseOff };
	} catch {
		return { langfuseOff: false };
	}
}
