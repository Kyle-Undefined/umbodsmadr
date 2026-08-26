import {
	defaultDatabasePath,
	loadManifest,
	openAuditLogReader,
	resolveEnvPath,
	resolveTimeParam,
	simulatePolicy,
	runManifestTests,
	type PolicySimulation,
} from '@umbod/core';
import { resolve } from 'node:path';

export type SimulationFailure =
	| 'blocked-to-allow'
	| 'approve-to-allow'
	| 'previously-denied-to-allow'
	| 'unresolved-workspace'
	| 'truncated';

export interface PolicySimulateOptions {
	baselinePath?: string;
	databasePath?: string;
	since?: string;
	until?: string;
	project?: string;
	workspace?: string;
	agent?: string;
	limit?: number;
	all?: boolean;
	json?: boolean;
	failOn?: SimulationFailure[];
}

export async function runPolicyTestCommand(manifestPath: string): Promise<ReturnType<typeof runManifestTests>> {
	const report = runManifestTests(await loadManifest(resolve(manifestPath)));
	for (const result of report.results) {
		console.log(`${result.passed ? 'pass' : 'FAIL'} ${result.id}: expected ${result.expected}, got ${result.actual}`);
	}
	console.log(`Policy tests: ${report.passed} passed, ${report.failed} failed`);
	return report;
}

function printSimulation(result: PolicySimulation): void {
	console.log(
		`Policy simulation: ${result.dataset.evaluated}/${result.dataset.eligible} calls${result.dataset.truncated ? ' (truncated)' : ''}`
	);
	for (const [transition, count] of Object.entries(result.transitions)) {
		console.log(`${transition.padEnd(18)} ${String(count).padStart(6)}`);
	}
	console.log(
		`Safety: ${result.safety.blockedToAllow} block->allow, ${result.safety.approveToAllow} approve->allow, ${result.safety.previouslyDeniedToAllow} previously denied->allow, ${result.safety.unresolvedWorkspace} unresolved workspace`
	);
	console.log(
		`Coverage: ${result.newlyCovered} newly covered, ${result.stillUnmatched} still unmatched; ${result.policyChanges} policy-result changes; candidate rules: ${result.candidateRules.filter((rule) => rule.status === 'never_observed').length} never observed`
	);
}

function failedChecks(result: PolicySimulation, checks: SimulationFailure[]): SimulationFailure[] {
	return checks.filter((check) => {
		if (check === 'blocked-to-allow') return result.safety.blockedToAllow > 0;
		if (check === 'approve-to-allow') return result.safety.approveToAllow > 0;
		if (check === 'previously-denied-to-allow') return result.safety.previouslyDeniedToAllow > 0;
		if (check === 'unresolved-workspace') return result.safety.unresolvedWorkspace > 0;
		return result.dataset.truncated;
	});
}

export async function runPolicySimulateCommand(
	candidatePath: string,
	options: PolicySimulateOptions
): Promise<{ result: PolicySimulation; failed: SimulationFailure[] }> {
	if (options.all && options.limit !== undefined)
		throw new Error('policy simulation accepts either --all or --limit, not both');
	const baselinePath = resolveEnvPath(options.baselinePath);
	const baseline = await loadManifest(baselinePath);
	const candidate = await loadManifest(resolve(candidatePath));
	const databasePath = options.databasePath
		? resolve(options.databasePath)
		: defaultDatabasePath(baselinePath, baseline.env.name);
	const auditLog = openAuditLogReader(databasePath);
	try {
		const result = simulatePolicy(baseline, candidate, auditLog, {
			since: resolveTimeParam(options.since),
			until: resolveTimeParam(options.until),
			project: options.project,
			workspace: options.workspace,
			agent: options.agent,
			limit: options.limit,
			all: options.all,
		});
		if (options.json) console.log(JSON.stringify(result, null, 2));
		else printSimulation(result);
		return { result, failed: failedChecks(result, options.failOn ?? []) };
	} finally {
		auditLog.close();
	}
}
