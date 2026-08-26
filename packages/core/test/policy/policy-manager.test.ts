import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PolicyManager } from '../../src/policy/policy-manager.ts';
import { createUmbod } from '../../src/server/api.ts';
import { makeCall } from '../helpers.ts';

let tempDir: string;
let manifestPath: string;

function source(defaultUnknown: 'allow' | 'block'): string {
	return `[env]
name = "test"
version = "1.0.0"
timeout = 5
[policy]
default_unknown = "${defaultUnknown}"
approval_method = "web"
`;
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'umbod-policy-manager-'));
	manifestPath = join(tempDir, 'umbod.toml');
	writeFileSync(manifestPath, source('block'));
});

afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

describe('PolicyManager', () => {
	test('atomically activates a compiled policy and increments its generation', async () => {
		const manager = await PolicyManager.load(manifestPath);
		const initial = manager.status();
		expect(initial).toMatchObject({ generation: 1, reloadStatus: 'active' });
		expect(initial.sourceHash).toBe(initial.activeHash);

		writeFileSync(manifestPath, source('allow'));
		const reloaded = await manager.reload(manifestPath);
		expect(reloaded).toMatchObject({ generation: 2, reloadStatus: 'active' });
		expect(reloaded.sourceHash).toBe(reloaded.activeHash);
		expect(reloaded.activeHash).not.toBe(initial.activeHash);
		expect(manager.evaluate(makeCall({ command: 'cargo build' })).result.decision).toBe('allow');
	});

	test('does not churn generations for unchanged source and rejects bootstrap changes', async () => {
		const manager = await PolicyManager.load(manifestPath);
		const initial = manager.status();
		expect((await manager.reload(manifestPath)).generation).toBe(1);

		writeFileSync(manifestPath, source('block').replace('name = "test"', 'name = "other"'));
		const failed = await manager.reload(manifestPath);
		expect(failed).toMatchObject({
			activeHash: initial.activeHash,
			generation: 1,
			reloadStatus: 'error',
		});
		expect(failed.reloadError).toContain('require a restart');
	});

	test('retains the prior active policy and generation when reload fails', async () => {
		const manager = await PolicyManager.load(manifestPath);
		const initial = manager.status();
		writeFileSync(manifestPath, 'not valid [[[');

		const failed = await manager.reload(manifestPath);
		expect(failed).toMatchObject({
			activeHash: initial.activeHash,
			generation: initial.generation,
			reloadStatus: 'error',
		});
		expect(failed.sourceHash).not.toBe(initial.sourceHash);
		expect(failed.reloadError).toContain('failed to parse');
		expect(manager.evaluate(makeCall({ command: 'cargo build' })).result.decision).toBe('block');
	});

	test('attributes historical audit rows to the exact active generation', async () => {
		const manager = await PolicyManager.load(manifestPath);
		const umbod = createUmbod({
			manifest: manager.manifest,
			policyManager: manager,
			dbPath: join(tempDir, 'audit.db'),
		});
		await umbod.authorize(makeCall({ command: 'cargo build' }));
		const firstStatus = manager.status();

		writeFileSync(manifestPath, source('allow'));
		await manager.reload(manifestPath);
		await umbod.authorize(makeCall({ command: 'cargo build' }));
		const secondStatus = manager.status();

		writeFileSync(manifestPath, 'invalid [[[');
		await manager.reload(manifestPath);
		await umbod.authorize(makeCall({ command: 'cargo build' }));
		const [afterFailure, afterSuccess, beforeReload] = umbod.auditLog.listRecent(3);
		expect(beforeReload).toMatchObject({ policyHash: firstStatus.activeHash, policyGeneration: 1 });
		expect(afterSuccess).toMatchObject({ policyHash: secondStatus.activeHash, policyGeneration: 2 });
		expect(afterFailure).toMatchObject({ policyHash: secondStatus.activeHash, policyGeneration: 2 });
		umbod.close();
	});
});
