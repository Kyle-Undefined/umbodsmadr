import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AuditLogStore, PolicyEngine, type Manifest, type ToolCall } from '@umbod/core';
import { runPolicySimulateCommand } from '../src/commands/policy.ts';

let tempDir: string;

const manifestSource = (decision: 'allow' | 'block' | 'approve') => `
[env]
name = "test"
version = "1.0.0"
timeout = 5
[policy]
default_unknown = "block"
approval_method = "web"
[rules]
"cargo build" = "${decision}"
`;

function manifest(decision: 'allow' | 'block' | 'approve'): Manifest {
	return {
		env: { name: 'test', version: '1.0.0', timeout: 5 },
		policy: { default_unknown: 'block', approval_method: 'web' },
		rules: { 'cargo build': decision },
		workspaces: [],
		server: { host: '127.0.0.1', port: 9090 },
	};
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'umbod-policy-cli-'));
});

afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

test('policy simulate command uses a read-only database and returns failed safety checks', async () => {
	const baselinePath = join(tempDir, 'baseline.toml');
	const candidatePath = join(tempDir, 'candidate.toml');
	const databasePath = join(tempDir, 'audit.db');
	writeFileSync(baselinePath, manifestSource('block'));
	writeFileSync(candidatePath, manifestSource('allow'));
	const baseline = manifest('block');
	const call: ToolCall = {
		agent: 'codex',
		tool: 'bash',
		command: 'cargo build',
		timestamp: '2026-01-01T00:00:00.000Z',
	};
	const writer = new AuditLogStore(databasePath);
	writer.append(call, new PolicyEngine(baseline).evaluate(call));
	writer.close();

	const originalLog = console.log;
	console.log = () => undefined;
	try {
		const { result, failed } = await runPolicySimulateCommand(candidatePath, {
			baselinePath,
			databasePath,
			json: true,
			failOn: ['blocked-to-allow'],
		});
		expect(result.transitions).toEqual({ 'block->allow': 1 });
		expect(failed).toEqual(['blocked-to-allow']);
	} finally {
		console.log = originalLog;
	}

	const verifier = new AuditLogStore(databasePath);
	expect(verifier.countFiltered()).toBe(1);
	verifier.close();

	const cli = Bun.spawnSync([
		process.execPath,
		'run',
		'packages/cli/src/cli.ts',
		'policy',
		'simulate',
		candidatePath,
		'--env',
		baselinePath,
		'--database',
		databasePath,
		'--json',
		'--fail-on',
		'blocked-to-allow',
	]);
	expect(cli.exitCode).toBe(2);
	expect(JSON.parse(cli.stdout.toString()).transitions).toEqual({ 'block->allow': 1 });
	expect(cli.stderr.toString()).toContain('Policy simulation failed checks: blocked-to-allow');

	for (const invalidArgs of [['--unknown'], ['--limit', '1', '--limit', '2']]) {
		const invalid = Bun.spawnSync([
			process.execPath,
			'run',
			'packages/cli/src/cli.ts',
			'policy',
			'simulate',
			candidatePath,
			...invalidArgs,
		]);
		expect(invalid.exitCode).toBe(1);
		expect(invalid.stderr.toString()).toContain('umbod failed');
	}
});
