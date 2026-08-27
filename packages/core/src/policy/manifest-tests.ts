import type { ApprovalDecision, Manifest } from '../core/types.ts';
import { PolicyEngine } from './engine.ts';
import { lintPolicy, type PolicyLintFinding } from './policy-lint.ts';

export interface ManifestTestResult {
	id: string;
	expected: ApprovalDecision;
	actual: ApprovalDecision;
	passed: boolean;
	reason: string;
}

export interface ManifestTestReport {
	passed: number;
	failed: number;
	results: ManifestTestResult[];
	lint: PolicyLintFinding[];
}

export function runManifestTests(manifest: Manifest): ManifestTestReport {
	const engine = new PolicyEngine(manifest);
	const results = (manifest.tests ?? []).map((test, index) => {
		const evaluated = engine.evaluate({ ...test.call, timestamp: test.call.timestamp ?? new Date().toISOString() });
		return {
			id: test.id ?? `test-${index + 1}`,
			expected: test.expect,
			actual: evaluated.decision,
			passed: evaluated.decision === test.expect,
			reason: evaluated.reason,
		};
	});
	return {
		passed: results.filter((result) => result.passed).length,
		failed: results.filter((result) => !result.passed).length,
		results,
		lint: lintPolicy(manifest),
	};
}
