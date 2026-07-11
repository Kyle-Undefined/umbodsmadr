import type { AuditLogStore } from '../db/audit-log.ts';
import { readSessionToolCalls } from '../sessions/index.ts';
import type { SessionLogSource, SessionToolCall } from '../sessions/types.ts';
import type { CoverageAuditRow, CoverageBreakdown, CoverageQuery, CoverageReport } from './types.ts';

const DEFAULT_HEURISTIC_WINDOW_MS = 15_000;
const DEFAULT_GAP_LIMIT = 200;
const SEPARATOR = '\u0000';

function key(...parts: Array<string | undefined>): string {
	return parts.map((part) => part ?? '').join(SEPARATOR);
}

function timestampMs(timestamp: string): number {
	const parsed = Date.parse(timestamp);
	return Number.isNaN(parsed) ? 0 : parsed;
}

function nearestUnconsumed(
	candidates: CoverageAuditRow[] | undefined,
	call: SessionToolCall,
	consumed: Set<number>,
	windowMs?: number
): CoverageAuditRow | undefined {
	if (!candidates) return undefined;
	const callTime = timestampMs(call.timestamp);
	let best: CoverageAuditRow | undefined;
	let bestDelta = Number.POSITIVE_INFINITY;
	for (const candidate of candidates) {
		if (consumed.has(candidate.id)) continue;
		if (call.cwd && candidate.workingDirectory && call.cwd !== candidate.workingDirectory) continue;
		const delta = Math.abs(timestampMs(candidate.timestamp) - callTime);
		if (windowMs !== undefined && delta > windowMs) continue;
		if (delta < bestDelta) {
			best = candidate;
			bestDelta = delta;
		}
	}
	return best;
}

function makeBreakdown(counts: Map<string, { sessionCalls: number; matched: number }>): CoverageBreakdown[] {
	return [...counts.entries()]
		.map(([key, count]) => ({
			key,
			...count,
			coverageRatio: count.sessionCalls === 0 ? 0 : count.matched / count.sessionCalls,
		}))
		.sort((a, b) => b.sessionCalls - a.sessionCalls || a.key.localeCompare(b.key));
}

/**
 * Cross-references retained hook evaluations with on-disk agent transcripts.
 * Each audit entry can match at most one transcript call, avoiding inflated
 * coverage in repeated commands such as polling or status checks.
 */
export async function computeCoverage(
	auditLog: AuditLogStore,
	sources: SessionLogSource[],
	query: CoverageQuery = {}
): Promise<CoverageReport> {
	const { heuristicWindowMs = DEFAULT_HEURISTIC_WINDOW_MS, gapLimit = DEFAULT_GAP_LIMIT, ...filter } = query;
	const entries = auditLog.entriesForCoverage(filter);
	const byToolUseId = new Map<string, CoverageAuditRow[]>();
	const bySessionCommand = new Map<string, CoverageAuditRow[]>();
	const byCommand = new Map<string, CoverageAuditRow[]>();
	for (const entry of entries) {
		if (entry.toolUseId) {
			const entriesForId = byToolUseId.get(key(entry.agent, entry.toolUseId)) ?? [];
			entriesForId.push(entry);
			byToolUseId.set(key(entry.agent, entry.toolUseId), entriesForId);
		}
		if (entry.sessionId) {
			const entriesForSession =
				bySessionCommand.get(key(entry.agent, entry.sessionId, entry.tool, entry.command)) ?? [];
			entriesForSession.push(entry);
			bySessionCommand.set(key(entry.agent, entry.sessionId, entry.tool, entry.command), entriesForSession);
		}
		const entriesForCommand = byCommand.get(key(entry.agent, entry.tool, entry.command)) ?? [];
		entriesForCommand.push(entry);
		byCommand.set(key(entry.agent, entry.tool, entry.command), entriesForCommand);
	}

	const consumed = new Set<number>();
	const gaps: SessionToolCall[] = [];
	const agentCounts = new Map<string, { sessionCalls: number; matched: number }>();
	const toolCounts = new Map<string, { sessionCalls: number; matched: number }>();
	let sessionCalls = 0;
	let matched = 0;

	for await (const call of readSessionToolCalls(sources)) {
		sessionCalls += 1;
		const agentCount = agentCounts.get(call.agent) ?? { sessionCalls: 0, matched: 0 };
		agentCount.sessionCalls += 1;
		agentCounts.set(call.agent, agentCount);
		const toolCount = toolCounts.get(call.tool) ?? { sessionCalls: 0, matched: 0 };
		toolCount.sessionCalls += 1;
		toolCounts.set(call.tool, toolCount);

		let entry = call.toolUseId
			? nearestUnconsumed(byToolUseId.get(key(call.agent, call.toolUseId)), call, consumed)
			: undefined;
		entry ??= nearestUnconsumed(
			bySessionCommand.get(key(call.agent, call.sessionId, call.tool, call.command)),
			call,
			consumed
		);
		entry ??= nearestUnconsumed(
			byCommand.get(key(call.agent, call.tool, call.command)),
			call,
			consumed,
			heuristicWindowMs
		);

		if (entry) {
			consumed.add(entry.id);
			matched += 1;
			agentCount.matched += 1;
			toolCount.matched += 1;
		} else if (gaps.length < gapLimit) {
			gaps.push(call);
		}
	}

	const orphanAuditIds = entries.filter((entry) => !consumed.has(entry.id)).map((entry) => entry.id);
	const missingSessionIdentity = entries.filter((entry) => !entry.sessionId).length;
	const notes: string[] = [];
	if (entries.length > 0 && missingSessionIdentity / entries.length > 0.5) {
		notes.push('Most audit entries lack session identity, so older data can only use heuristic matching.');
	}
	if (sessionCalls > gaps.length + matched) {
		notes.push(`Only the first ${gapLimit} unmatched transcript calls are retained in gaps.`);
	}

	return {
		window: { since: query.since, until: query.until },
		totals: {
			sessionCalls,
			auditEntries: entries.length,
			matched,
			gaps: sessionCalls - matched,
			orphans: orphanAuditIds.length,
		},
		coverageRatio: sessionCalls === 0 ? 0 : matched / sessionCalls,
		byAgent: makeBreakdown(agentCounts),
		byTool: makeBreakdown(toolCounts),
		gaps,
		orphanAuditIds,
		notes,
	};
}
