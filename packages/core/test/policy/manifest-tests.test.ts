import { expect, test } from 'bun:test';
import { runManifestTests } from '../../src/policy/manifest-tests.ts';
import { makeManifest } from '../helpers.ts';

test('runs embedded policy fixtures in manifest order', () => {
	const report = runManifestTests(
		makeManifest({
			rules: { 'git status': 'allow' },
			tests: [
				{ id: 'status', call: { agent: 'test', tool: 'bash', command: 'git status' }, expect: 'allow' },
				{ id: 'build', call: { agent: 'test', tool: 'bash', command: 'cargo build' }, expect: 'allow' },
			],
		})
	);
	expect(report).toMatchObject({ passed: 1, failed: 1 });
	expect(report.results[1]).toMatchObject({ id: 'build', expected: 'allow', actual: 'block', passed: false });
});
