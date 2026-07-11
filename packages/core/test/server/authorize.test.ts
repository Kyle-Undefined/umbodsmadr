import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUmbod } from '../../src/server/api.ts';
import { makeManifest } from '../helpers.ts';

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeUmbod(rules: Record<string, 'allow' | 'block' | 'approve'>) {
	const dir = mkdtempSync(join(tmpdir(), 'umbod-authorize-'));
	dirs.push(dir);
	return createUmbod({
		manifest: { ...makeManifest(), rules },
		dbPath: join(dir, 'audit.db'),
	});
}

const call = {
	agent: 'hlid',
	tool: 'bash',
	command: 'git push origin main',
	timestamp: '2026-07-11T12:00:00.000Z',
	sessionId: 'session-1',
	toolUseId: 'tool-1',
};

describe('in-process authorization', () => {
	test('audits explicit blocks without prompting', async () => {
		const umbod = makeUmbod({ 'git push *': 'block' });
		const result = await umbod.authorize(call);
		expect(result.decision).toBe('block');
		expect(umbod.auditLog.listRecent(1)[0]).toMatchObject({ sessionId: 'session-1', toolUseId: 'tool-1' });
		umbod.close();
	});

	test('records host approval outcomes', async () => {
		const umbod = makeUmbod({ 'git push *': 'approve' });
		const result = await umbod.authorize(call, { approvalPrompt: async () => 'allow' });
		expect(result).toMatchObject({ policyDecision: 'approve', decision: 'allow' });
		expect(umbod.auditLog.listRecent(1)[0].approvalStatus).toBe('approved');
		umbod.close();
	});

	test('bypass resolves approve but never overrides block', async () => {
		const approval = makeUmbod({ 'git push *': 'approve' });
		expect((await approval.authorize(call, { bypassApproval: true })).decision).toBe('allow');
		expect(approval.auditLog.listRecent(1)[0].approvalStatus).toBe('approved');
		approval.close();

		const blocked = makeUmbod({ 'git push *': 'block' });
		expect((await blocked.authorize(call, { bypassApproval: true })).decision).toBe('block');
		blocked.close();
	});
});
