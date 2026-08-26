import { adapters } from '../adapters/index.ts';
import type { Manifest } from '../core/types.ts';
import type { AuditLogReader } from '../db/audit-log.ts';
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

function lastSeenByTool(rows: ReturnType<AuditLogReader['aggregateToolUsage']>): Map<string, string> {
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
	const workspace = workspaceId ? manifest.workspaces?.find((entry) => entry.id === workspaceId) : undefined;
	const globalStructured = [...(manifest.structuredRules ?? []), ...(manifest.guards ?? [])];
	const workspaceStructured = workspace ? [...(workspace.structuredRules ?? []), ...(workspace.guards ?? [])] : [];
	const structuredTools = [...globalStructured, ...workspaceStructured].flatMap((rule) => rule.tools ?? []);
	return [
		...Object.keys(manifest.rules),
		...Object.keys(workspace?.rules ?? {}),
		...structuredTools.map((tool) => `${tool} *`),
	];
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

function historicalUnusedTools(lastSeen: Map<string, string>, recentTools: Set<string>): UnusedTool[] {
	return [...lastSeen]
		.filter(([tool]) => !recentTools.has(tool))
		.map(([tool, seen]) => ({ tool, source: 'history', lastSeen: seen }));
}

function ruleOnlyTools(references: Map<string, string[]>, everSeen: Map<string, string>): UnusedTool[] {
	return [...references]
		.filter(([tool]) => !everSeen.has(tool))
		.map(([tool, patterns]) => ({ tool, source: 'rules', referencedByRules: patterns }));
}

function adapterOnlyTools(
	adapterTools: Set<string>,
	everSeen: Map<string, string>,
	ruleReferences: Map<string, string[]>
): UnusedTool[] {
	return [...adapterTools]
		.filter((tool) => !everSeen.has(tool) && !ruleReferences.has(tool))
		.map((tool) => ({ tool, source: 'adapter' }));
}

function unusedToolDetails(
	auditLog: AuditLogReader,
	manifest: Manifest,
	query: ToolUsageQuery,
	usageRows: ReturnType<AuditLogReader['aggregateToolUsage']>,
	recentWindowDays: number
): UnusedTool[] {
	const allTimeFilter = {
		agent: query.agent,
		project: query.project,
		workspace: query.workspace,
	};
	const windowIsAllTime = query.since === undefined && query.until === undefined;
	const allTime = windowIsAllTime ? usageRows : auditLog.aggregateToolUsage(allTimeFilter);
	const recentSince = new Date(Date.now() - recentWindowDays * 86_400_000).toISOString();
	const recentTools = new Set(auditLog.distinctTools({ ...allTimeFilter, since: recentSince }));
	const everSeen = lastSeenByTool(allTime);
	const adapterTools = supportedAdapterTools();
	const knownTools = new Set([...adapterTools, ...everSeen.keys()]);
	const ruleReferences = referencedRules(configuredRulePatterns(manifest, query.workspace), knownTools);

	return [
		...historicalUnusedTools(everSeen, recentTools),
		...ruleOnlyTools(ruleReferences, everSeen),
		...adapterOnlyTools(adapterTools, everSeen, ruleReferences),
	];
}

export function computeToolUsage(
	auditLog: AuditLogReader,
	manifest: Manifest,
	query: ToolUsageQuery = {}
): ToolUsageStats {
	const recentWindowDays = query.recentWindowDays ?? DEFAULT_RECENT_WINDOW_DAYS;
	const topCommandsPerTool = query.topCommandsPerTool ?? DEFAULT_TOP_COMMANDS;
	const window = { since: query.since, until: query.until };
	const filter = { ...window, agent: query.agent, project: query.project, workspace: query.workspace };
	const summary = query.projection === 'summary';
	const projection = summary ? 'summary' : 'full';

	const totals = auditLog.usageTotals(filter);
	const usageRows = auditLog.aggregateToolUsage(filter);
	const topCommands = summary
		? new Map<string, Array<{ command: string; count: number }>>()
		: auditLog.topCommandsByTool(filter, topCommandsPerTool);
	const byTaskType = summary ? [] : auditLog.aggregateTaskTypes(filter);

	const byTool = usageRows.map((row) => ({
		...row,
		topCommands: topCommands.get(row.tool) ?? [],
	}));
	if (summary) return { projection, window, totals, byTool, byTaskType, unusedTools: [] };

	// Compare all-time history with recent use, then include tools known only
	// from configured rules or adapter declarations.
	const unusedTools = unusedToolDetails(auditLog, manifest, query, usageRows, recentWindowDays);

	return { projection, window, totals, byTool, byTaskType, unusedTools };
}
