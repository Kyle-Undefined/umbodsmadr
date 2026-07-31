import {
	analyzeRules,
	computeCoverage,
	computeToolUsage,
	defaultDatabasePath,
	loadManifest,
	resolveEnvPath,
	resolveTimeParam,
	scopeCoverageSources,
	AuditLogStore,
	type AuditFilter,
	type Manifest,
} from '@umbod/core';

export type AnalyzeTarget = 'tools' | 'rules' | 'coverage';

export interface AnalyzeOptions extends AuditFilter {
	envPath?: string;
	minOccurrences?: number;
	json?: boolean;
}

function printTools(result: ReturnType<typeof computeToolUsage>): void {
	console.log(`Tool usage: ${result.totals.entries} calls across ${result.totals.sessions} sessions`);
	for (const row of result.byTool) {
		console.log(`${row.agent.padEnd(8)} ${row.tool.padEnd(12)} ${String(row.count).padStart(5)} calls`);
	}
}

function printCoverage(result: Awaited<ReturnType<typeof computeCoverage>>): void {
	console.log(
		`Coverage: ${(result.coverageRatio * 100).toFixed(1)}% (${result.totals.matched}/${result.totals.sessionCalls} transcript calls)`
	);
	console.log(`Gaps: ${result.totals.gaps}; orphan audit entries: ${result.totals.orphans}`);
	for (const note of result.notes) console.log(`Note: ${note}`);
}

function printRules(result: ReturnType<typeof analyzeRules>): void {
	console.log(`Rule analysis: ${result.rules.length} rules, ${result.suggestions.length} suggestions`);
	if (result.tomlSnippet) console.log(result.tomlSnippet);
}

function outputResult<T>(result: T, json: boolean | undefined, print: (value: T) => void): void {
	if (json) console.log(JSON.stringify(result, null, 2));
	else print(result);
}

async function analyzeCoverageTarget(
	manifest: Manifest,
	auditLog: AuditLogStore,
	filter: AuditFilter,
	json: boolean | undefined
): Promise<void> {
	const since = filter.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	const sources = scopeCoverageSources(manifest, [{ agent: 'claude' }, { agent: 'codex' }], {
		...filter,
		since,
	});
	const result = await computeCoverage(auditLog, sources, { ...filter, since });
	outputResult(result, json, printCoverage);
}

async function analyzeTarget(
	target: AnalyzeTarget,
	manifest: Manifest,
	auditLog: AuditLogStore,
	filter: AuditFilter,
	options: AnalyzeOptions
): Promise<void> {
	if (target === 'tools') {
		outputResult(computeToolUsage(auditLog, manifest, filter), options.json, printTools);
		return;
	}
	if (target === 'rules') {
		const result = analyzeRules(manifest, auditLog, { ...filter, minOccurrences: options.minOccurrences });
		outputResult(result, options.json, printRules);
		return;
	}
	await analyzeCoverageTarget(manifest, auditLog, filter, options.json);
}

export async function runAnalyzeCommand(target: AnalyzeTarget, options: AnalyzeOptions): Promise<void> {
	const manifestPath = resolveEnvPath(options.envPath);
	const manifest = await loadManifest(manifestPath);
	const auditLog = new AuditLogStore(defaultDatabasePath(manifestPath, manifest.env.name));
	const filter = {
		since: resolveTimeParam(options.since),
		until: resolveTimeParam(options.until),
		agent: options.agent,
		project: options.project,
		workspace: options.workspace,
	};

	try {
		await analyzeTarget(target, manifest, auditLog, filter, options);
	} finally {
		auditLog.close();
	}
}
