import {
	analyzeRules,
	computeCoverage,
	computeToolUsage,
	defaultDatabasePath,
	loadManifest,
	resolveEnvPath,
	resolveTimeParam,
	AuditLogStore,
	type AuditFilter,
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

export async function runAnalyzeCommand(target: AnalyzeTarget, options: AnalyzeOptions): Promise<void> {
	const manifestPath = resolveEnvPath(options.envPath);
	const manifest = await loadManifest(manifestPath);
	const auditLog = new AuditLogStore(defaultDatabasePath(manifestPath, manifest.env.name));
	const filter = {
		since: resolveTimeParam(options.since),
		until: resolveTimeParam(options.until),
		agent: options.agent,
		project: options.project,
	};

	try {
		if (target === 'tools') {
			const result = computeToolUsage(auditLog, manifest, filter);
			if (options.json) console.log(JSON.stringify(result, null, 2));
			else printTools(result);
			return;
		}

		if (target === 'rules') {
			const result = analyzeRules(manifest, auditLog, { ...filter, minOccurrences: options.minOccurrences });
			if (options.json) console.log(JSON.stringify(result, null, 2));
			else {
				console.log(`Rule analysis: ${result.rules.length} rules, ${result.suggestions.length} suggestions`);
				if (result.tomlSnippet) console.log(result.tomlSnippet);
			}
			return;
		}

		const since = filter.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
		const sources = ([{ agent: 'claude' }, { agent: 'codex' }] as const)
			.filter((source) => filter.agent === undefined || source.agent === filter.agent)
			.map((source) => ({ ...source, project: filter.project, since, until: filter.until }));
		const result = await computeCoverage(auditLog, sources, {
			...filter,
			since,
		});
		if (options.json) console.log(JSON.stringify(result, null, 2));
		else printCoverage(result);
	} finally {
		auditLog.close();
	}
}
