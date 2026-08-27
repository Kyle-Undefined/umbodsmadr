import { expect, test } from 'bun:test';
import { performance } from 'node:perf_hooks';
import { PolicyEngine } from '../../src/policy/engine.ts';
import { makeCall, makeManifest } from '../helpers.ts';

test('policy evaluation remains bounded with derived shell and path facts', () => {
	const engine = new PolicyEngine(
		makeManifest({
			guards: [
				{ id: 'commit', decision: 'block', componentsAny: ['git commit *'] },
				{ id: 'credentials', decision: 'block', paths: ['**/.env'] },
			],
			structuredRules: [
				{ id: 'reads', decision: 'allow', componentsAll: ['git diff *', 'git status'] },
				{ id: 'repo-edits', decision: 'approve', pathsAll: ['/work/repo/**'] },
			],
		})
	);
	const calls = Array.from({ length: 20_000 }, (_, index) =>
		makeCall({
			command: index % 2 === 0 ? 'git diff --check && git status' : 'printf ok > /work/repo/out.txt',
			inputs: { tool_input: { path: `/work/repo/file-${index}.ts` } },
		})
	);
	const started = performance.now();
	for (const call of calls) engine.evaluateWithTrace(call);
	const elapsed = performance.now() - started;
	// A generous ceiling catches accidental quadratic work without making ordinary CI variance flaky.
	expect(elapsed).toBeLessThan(5_000);
});
