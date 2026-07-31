import type { Manifest, WorkspaceConfig } from '../core/types.ts';
import type { AuditLogReader } from '../db/audit-log.ts';
import { isPathWithinWorkspaceRoot, normalizeWorkspaceRoot } from '../policy/workspace.ts';
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

function candidateDelta(
	candidate: CoverageAuditRow,
	call: SessionToolCall,
	callTime: number,
	consumed: Set<number>,
	windowMs: number | undefined
): number | undefined {
	if (consumed.has(candidate.id)) return undefined;
	if (call.cwd && candidate.workingDirectory && call.cwd !== candidate.workingDirectory) return undefined;
	const delta = Math.abs(timestampMs(candidate.timestamp) - callTime);
	return windowMs !== undefined && delta > windowMs ? undefined : delta;
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
		const delta = candidateDelta(candidate, call, callTime, consumed, windowMs);
		if (delta === undefined) continue;
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

function uniqueRoots(roots: string[]): string[] {
	const seen = new Set<string>();
	return roots.filter((root) => {
		const normalized = normalizeWorkspaceRoot(root);
		if (seen.has(normalized)) return false;
		seen.add(normalized);
		return true;
	});
}

function rootSetsOverlap(sourceRoots: string[] | undefined, workspaceRoots: string[]): boolean {
	if (!sourceRoots || sourceRoots.length === 0) return true;
	return sourceRoots.some((sourceRoot) =>
		workspaceRoots.some(
			(workspaceRoot) =>
				isPathWithinWorkspaceRoot(sourceRoot, workspaceRoot) || isPathWithinWorkspaceRoot(workspaceRoot, sourceRoot)
		)
	);
}

type CoverageSourceQuery = Pick<CoverageQuery, 'agent' | 'project' | 'workspace' | 'since' | 'until'>;

function sourceWithWindow(source: SessionLogSource, query: CoverageSourceQuery): SessionLogSource {
	return {
		...source,
		since: query.since ?? source.since,
		until: query.until ?? source.until,
	};
}

function scopeCoverageSource(
	source: SessionLogSource,
	query: CoverageSourceQuery,
	workspace: WorkspaceConfig | undefined,
	workspaces: WorkspaceConfig[]
): SessionLogSource | undefined {
	const withWindow = sourceWithWindow(source, query);
	if (query.project !== undefined) {
		if (source.project !== undefined && source.project !== query.project) return undefined;
		return { ...withWindow, project: query.project };
	}
	if (!workspace) return withWindow;
	if (!rootSetsOverlap(source.projectRoots, workspace.roots)) return undefined;
	return {
		...withWindow,
		scopeProjectRoots: workspace.roots,
		competingProjectRoots: uniqueRoots([
			...(source.competingProjectRoots ?? []),
			...workspaces.filter((entry) => entry.id !== workspace.id).flatMap((entry) => entry.roots),
		]),
	};
}

export function scopeCoverageSources(
	manifest: Manifest,
	sources: SessionLogSource[],
	query: CoverageSourceQuery
): SessionLogSource[] {
	const workspaces = manifest.workspaces ?? [];
	const workspace =
		query.workspace === undefined ? undefined : workspaces.find((entry) => entry.id === query.workspace);
	if (query.workspace !== undefined && workspace === undefined) {
		throw new Error(`workspace "${query.workspace}" is not configured`);
	}
	if (workspace && query.project === undefined && workspace.roots.length === 0) {
		throw new Error(
			`workspace "${workspace.id}" has no roots; coverage requires an exact project because transcripts do not record workspace IDs`
		);
	}

	const scoped: SessionLogSource[] = [];
	for (const source of sources) {
		if (query.agent !== undefined && source.agent !== query.agent) continue;
		const candidate = scopeCoverageSource(source, query, workspace, workspaces);
		if (candidate) scoped.push(candidate);
	}
	return scoped;
}

interface CoverageIndexes {
	byToolUseId: Map<string, CoverageAuditRow[]>;
	bySessionCommand: Map<string, CoverageAuditRow[]>;
	byCommand: Map<string, CoverageAuditRow[]>;
}

type BreakdownCounts = Map<string, { sessionCalls: number; matched: number }>;

function addIndexedRow(index: Map<string, CoverageAuditRow[]>, rowKey: string, entry: CoverageAuditRow): void {
	const rows = index.get(rowKey) ?? [];
	rows.push(entry);
	index.set(rowKey, rows);
}

function buildCoverageIndexes(entries: CoverageAuditRow[]): CoverageIndexes {
	const indexes: CoverageIndexes = {
		byToolUseId: new Map(),
		bySessionCommand: new Map(),
		byCommand: new Map(),
	};
	for (const entry of entries) {
		if (entry.toolUseId) addIndexedRow(indexes.byToolUseId, key(entry.agent, entry.toolUseId), entry);
		if (entry.sessionId) {
			addIndexedRow(indexes.bySessionCommand, key(entry.agent, entry.sessionId, entry.tool, entry.command), entry);
		}
		addIndexedRow(indexes.byCommand, key(entry.agent, entry.tool, entry.command), entry);
	}
	return indexes;
}

function incrementBreakdown(counts: BreakdownCounts, countKey: string): { sessionCalls: number; matched: number } {
	const count = counts.get(countKey) ?? { sessionCalls: 0, matched: 0 };
	count.sessionCalls += 1;
	counts.set(countKey, count);
	return count;
}

function matchingEntry(
	call: SessionToolCall,
	indexes: CoverageIndexes,
	consumed: Set<number>,
	heuristicWindowMs: number
): CoverageAuditRow | undefined {
	const exact = call.toolUseId
		? nearestUnconsumed(indexes.byToolUseId.get(key(call.agent, call.toolUseId)), call, consumed)
		: undefined;
	return (
		exact ??
		nearestUnconsumed(
			indexes.bySessionCommand.get(key(call.agent, call.sessionId, call.tool, call.command)),
			call,
			consumed
		) ??
		nearestUnconsumed(
			indexes.byCommand.get(key(call.agent, call.tool, call.command)),
			call,
			consumed,
			heuristicWindowMs
		)
	);
}

function coverageNotes(
	entries: CoverageAuditRow[],
	sessionCalls: number,
	matched: number,
	retainedGaps: number,
	gapLimit: number
): string[] {
	const notes: string[] = [];
	const missingSessionIdentity = entries.filter((entry) => !entry.sessionId).length;
	if (entries.length > 0 && missingSessionIdentity / entries.length > 0.5) {
		notes.push('Most audit entries lack session identity, so older data can only use heuristic matching.');
	}
	if (sessionCalls > retainedGaps + matched) {
		notes.push(`Only the first ${gapLimit} unmatched transcript calls are retained in gaps.`);
	}
	return notes;
}

/**
 * Cross-references retained hook evaluations with on-disk agent transcripts.
 * Each audit entry can match at most one transcript call, avoiding inflated
 * coverage in repeated commands such as polling or status checks.
 */
export async function computeCoverage(
	auditLog: AuditLogReader,
	sources: SessionLogSource[],
	query: CoverageQuery = {}
): Promise<CoverageReport> {
	const { heuristicWindowMs = DEFAULT_HEURISTIC_WINDOW_MS, gapLimit = DEFAULT_GAP_LIMIT, ...filter } = query;
	if (
		query.workspace !== undefined &&
		sources.some(
			(source) =>
				source.project === undefined &&
				(!source.projectRoots || source.projectRoots.length === 0) &&
				(!source.scopeProjectRoots || source.scopeProjectRoots.length === 0)
		)
	) {
		throw new Error('workspace coverage requires transcript sources scoped by project or projectRoots');
	}
	const entries = auditLog.entriesForCoverage(filter);
	const indexes = buildCoverageIndexes(entries);
	const consumed = new Set<number>();
	const gaps: SessionToolCall[] = [];
	const agentCounts: BreakdownCounts = new Map();
	const toolCounts: BreakdownCounts = new Map();
	let sessionCalls = 0;
	let matched = 0;

	for await (const call of readSessionToolCalls(sources)) {
		sessionCalls += 1;
		const agentCount = incrementBreakdown(agentCounts, call.agent);
		const toolCount = incrementBreakdown(toolCounts, call.tool);
		const entry = matchingEntry(call, indexes, consumed, heuristicWindowMs);
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
		notes: coverageNotes(entries, sessionCalls, matched, gaps.length, gapLimit),
	};
}
