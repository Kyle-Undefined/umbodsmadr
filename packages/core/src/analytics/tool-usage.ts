import { adapters } from '../adapters/index.ts';
import type { Manifest } from '../core/types.ts';
import type { AuditLogStore } from '../db/audit-log.ts';
import type { ToolUsageQuery, ToolUsageStats, UnusedTool } from './types.ts';

const DEFAULT_RECENT_WINDOW_DAYS = 14;
const DEFAULT_TOP_COMMANDS = 5;

/**
 * Extracts the tool a rule pattern targets. Patterns shaped like
 * "<tool> <path>" reference that tool directly; everything else is treated
 * as a bash command pattern (regex patterns can't be attributed).
 */
function ruleToolReference(pattern: string, knownTools: Set<string>): string | undefined {
	if (/^\/(.+)\/([gimsuy]*)$/.test(pattern)) {
		return undefined;
	}

	const firstToken = pattern.split(' ', 1)[0]?.toLowerCase() ?? '';
	if (knownTools.has(firstToken)) {
		return firstToken;
	}

	return 'bash';
}

function lastSeenByTool(rows: ReturnType<AuditLogStore['aggregateToolUsage']>): Map<string, string> {
	const lastSeen = new Map<string, string>();
	for (const row of rows) {
		const existing = lastSeen.get(row.tool);
		if (existing === undefined || row.lastSeen > existing) lastSeen.set(row.tool, row.lastSeen);
	}
	return lastSeen;
}

function supportedAdapterTools(): Set<string> {
	const tools = new Set<string>();
	for (const adapter of adapters) {
		for (const tool of adapter.supportedTools) tools.add(tool.toLowerCase());
	}
	return tools;
}

function configuredRulePatterns(manifest: Manifest, workspaceId: string | undefined): string[] {
	const workspaceRules = workspaceId
		? (manifest.workspaces?.find((workspace) => workspace.id === workspaceId)?.rules ?? {})
		: {};
	return [...Object.keys(manifest.rules), ...Object.keys(workspaceRules)];
}

function referencedRules(patterns: string[], knownTools: Set<string>): Map<string, string[]> {
	const references = new Map<string, string[]>();
	for (const pattern of patterns) {
		const tool = ruleToolReference(pattern, knownTools);
		if (tool === undefined) continue;
		const existing = references.get(tool) ?? [];
		existing.push(pattern);
		references.set(tool, existing);
	}
	return references;
}

export function computeToolUsage(
	auditLog: AuditLogStore,
	manifest: Manifest,
	query: ToolUsageQuery = {}
): ToolUsageStats {
	const recentWindowDays = query.recentWindowDays ?? DEFAULT_RECENT_WINDOW_DAYS;
	const topCommandsPerTool = query.topCommandsPerTool ?? DEFAULT_TOP_COMMANDS;
	const window = { since: query.since, until: query.until };
	const filter = { ...window, agent: query.agent, project: query.project, workspace: query.workspace };

	const totals = auditLog.usageTotals(filter);
	const usageRows = auditLog.aggregateToolUsage(filter);
	const topCommands = auditLog.topCommandsByTool(filter, topCommandsPerTool);
	const byTaskType = auditLog.aggregateTaskTypes(filter);

	const byTool = usageRows.map((row) => ({
		...row,
		topCommands: topCommands.get(row.tool) ?? [],
	}));

	// Unused tools: compare all-time history against a recent window, then
	// fold in tools referenced by rules or declared by adapters but never seen.
	const allTime = auditLog.aggregateToolUsage({
		agent: query.agent,
		project: query.project,
		workspace: query.workspace,
	});
	const recentSince = new Date(Date.now() - recentWindowDays * 86_400_000).toISOString();
	const recentTools = new Set(
		auditLog
			.aggregateToolUsage({
				since: recentSince,
				agent: query.agent,
				project: query.project,
				workspace: query.workspace,
			})
			.map((row) => row.tool)
	);
	const everSeen = lastSeenByTool(allTime);

	const unusedTools: UnusedTool[] = [];
	for (const [tool, lastSeen] of everSeen) {
		if (!recentTools.has(tool)) {
			unusedTools.push({ tool, source: 'history', lastSeen });
		}
	}

	const adapterTools = supportedAdapterTools();
	const knownTools = new Set([...adapterTools, ...everSeen.keys()]);
	const ruleRefs = referencedRules(configuredRulePatterns(manifest, query.workspace), knownTools);

	for (const [tool, patterns] of ruleRefs) {
		if (!everSeen.has(tool)) {
			unusedTools.push({ tool, source: 'rules', referencedByRules: patterns });
		}
	}

	for (const tool of adapterTools) {
		if (!everSeen.has(tool) && !ruleRefs.has(tool)) {
			unusedTools.push({ tool, source: 'adapter' });
		}
	}

	return { window, totals, byTool, byTaskType, unusedTools };
}
