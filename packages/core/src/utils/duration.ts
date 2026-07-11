const RELATIVE_RE = /^(\d+)([mhdw])$/;

const UNIT_MS: Record<string, number> = {
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
	w: 604_800_000,
};

/** Parses a relative duration like "30m", "24h", "7d", "2w" into milliseconds. */
function parseDuration(value: string): number | undefined {
	const match = RELATIVE_RE.exec(value.trim());
	if (!match) return undefined;
	return Number(match[1]) * (UNIT_MS[match[2]] as number);
}

/**
 * Resolves a time parameter that is either an ISO timestamp (passed through)
 * or a relative duration ("7d" -> now minus seven days) into an ISO string.
 */
export function resolveTimeParam(value: string | undefined, now: Date = new Date()): string | undefined {
	if (value === undefined || value.trim().length === 0) {
		return undefined;
	}

	const relative = parseDuration(value);
	if (relative !== undefined) {
		return new Date(now.getTime() - relative).toISOString();
	}

	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		throw new Error(`invalid time parameter: ${value} (expected ISO timestamp or relative duration like "7d")`);
	}

	return parsed.toISOString();
}
