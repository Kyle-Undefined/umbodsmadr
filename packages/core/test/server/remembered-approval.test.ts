import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { adapters } from '../../src/adapters/index.ts';
import { createUmbod } from '../../src/server/api.ts';
import { makeCall, makeManifest } from '../helpers.ts';

const manifest = makeManifest({
	policy: { default_unknown: 'approve', approval_method: 'cli', defaults: { readonly: 'approve' } },
});
const timingCall = makeCall({
	tool: 'clock.sleep',
	command: 'clock.sleep',
	workingDirectory: '/repo',
	inputs: { duration_ms: 1 },
});
const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('shared remembered approvals', () => {
	test('recovers older commands and retains them after audit cleanup', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'umbod-command-'));
		directories.push(directory);
		const dbPath = join(directory, 'audit.db');
		let umbod = createUmbod({
			manifest,
			dbPath,
			approvalPrompt: async () => ({ decision: 'allow', persist: 'always' }),
		});
		const command = 'clock.sleep {"duration_ms":10}';
		const saved = await umbod.authorize(
			makeCall({
				tool: 'clock.sleep',
				command,
				workingDirectory: '/repo',
				inputs: { cmd: command },
			}),
			{
				approvalPrompt: async () => ({ decision: 'allow', persist: 'always' }),
			}
		);
		expect(saved.userFeedback).toBeUndefined();
		expect(saved.decision).toBe('allow');
		expect(umbod.auditLog.listRememberedApprovals()).toHaveLength(1);
		umbod.close();
		const db = new Database(dbPath);
		db.exec('DROP TABLE remembered_approval_details; PRAGMA user_version = 9');
		db.close();
		umbod = createUmbod({ manifest, dbPath });
		expect(umbod.auditLog.listRememberedApprovals()[0].command).toBe(command);
		umbod.close();
		const cleanup = new Database(dbPath);
		cleanup.exec('DELETE FROM approval_requests; DELETE FROM audit_log');
		cleanup.close();
		umbod = createUmbod({ manifest, dbPath });
		expect(umbod.auditLog.listRememberedApprovals()[0].command).toBe(command);
		expect(umbod.auditLog.forgetApproval(umbod.auditLog.listRememberedApprovals()[0].grant_key)).toBe(true);
		umbod.close();
	});
	test('configured workspace roots share clock grants across Windows and WSL aliases', async () => {
		const umbod = createUmbod({
			manifest: makeManifest({
				policy: { default_unknown: 'approve', approval_method: 'cli', defaults: { readonly: 'approve' } },
				workspaces: [{ id: 'shared', roots: ['C:/Project', '/mnt/c/Project'], rules: {} }],
			}),
			dbPath: ':memory:',
			approvalPrompt: async () => 'block',
		});
		try {
			await umbod.authorize(
				{
					...timingCall,
					workingDirectory: 'C:\\PROJECT',
					tool: 'clock__sleep',
				},
				{
					approvalPrompt: async () => ({
						decision: 'allow',
						persist: 'always',
					}),
				}
			);
			const result = await umbod.authorize({
				...timingCall,
				workingDirectory: '/mnt/c/Project',
				tool: 'mcp__clock__sleep',
				agent: 'other',
				inputs: { duration_ms: 100 },
			});
			expect(result.decision).toBe('allow');
			expect(result.entry.reason).toContain('remembered Umbod approval');
			expect(result.entry.approvalRequestId).toBeUndefined();
			expect(result.policyDecision).toBe('approve');
			expect(umbod.auditLog.listRememberedApprovals()[0].command).toBe(timingCall.command);
		} finally {
			umbod.close();
		}
	});

	test('persists across restart, provider/session changes and both HTTP/direct routes', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'umbod-grants-'));
		directories.push(directory);
		const dbPath = join(directory, 'audit.db');
		let prompted = 0;
		let umbod = createUmbod({
			manifest,
			dbPath,
			approvalPrompt: async () => {
				prompted++;
				return { decision: 'allow', persist: 'always' };
			},
		});
		expect((await umbod.authorize({ ...timingCall, tool: 'clocksleep' })).decision).toBe('allow');
		umbod.close();
		umbod = createUmbod({
			manifest,
			dbPath,
			approvalPrompt: async () => {
				prompted++;
				return 'block';
			},
		});
		try {
			for (const adapter of adapters) {
				const response = await umbod.fetch(
					new Request(`http://localhost/api/hooks?agent=${adapter.id}`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							tool_name: 'clock.sleep',
							toolName: 'clock.sleep',
							tool: 'clock.sleep',
							name: 'clock.sleep',
							cwd: '/repo',
							working_directory: '/repo',
							directory: '/repo',
							tool_input: { duration_ms: 50 },
							session_id: adapter.id,
							tool_use_id: adapter.id,
						}),
					})
				);
				expect(response?.status).toBe(200);
				expect(await response?.json()).toMatchObject({
					permissionDecision: 'allow',
				});
			}
			expect(
				(
					await umbod.authorize({
						...timingCall,
						agent: 'different',
						sessionId: 'new',
						inputs: { duration_ms: 400 },
					})
				).decision
			).toBe('allow');
			expect(prompted).toBe(1);
			expect(umbod.auditLog.listRememberedApprovals()).toHaveLength(1);
			const grant = umbod.auditLog.listRememberedApprovals()[0];
			expect(umbod.auditLog.forgetApproval(grant.grant_key)).toBe(true);
			expect((await umbod.authorize(timingCall)).decision).toBe('block');
		} finally {
			umbod.close();
		}
	});

	test('workspace, tool and request boundaries; explicit blocks still win', async () => {
		const umbod = createUmbod({
			manifest,
			dbPath: ':memory:',
			approvalPrompt: async () => 'block',
		});
		try {
			expect(
				(
					await umbod.authorize(timingCall, {
						approvalPrompt: async () => ({
							decision: 'allow',
							persist: 'always',
						}),
					})
				).decision
			).toBe('allow');
			for (const call of [
				{ ...timingCall, workingDirectory: '/other' },
				{ ...timingCall, tool: 'clock.curr_time' },
			]) {
				expect((await umbod.authorize(call)).decision).toBe('block');
			}
			manifest.guards = [{ id: 'block-clock', tools: ['clock.sleep'], decision: 'block' }];
			// A separate service using the same store may apply a stricter policy.
			const blocked = createUmbod({
				manifest,
				auditLog: umbod.auditLog,
				approvalPrompt: async () => {
					throw new Error('must not prompt');
				},
			});
			expect((await blocked.authorize(timingCall)).decision).toBe('block');
		} finally {
			manifest.guards = undefined;
			umbod.close();
		}
	});

	test('shell Always remembers the exact request, and never another command', async () => {
		const umbod = createUmbod({
			manifest,
			dbPath: ':memory:',
			approvalPrompt: async () => 'block',
		});
		try {
			const call = makeCall({
				workingDirectory: '/repo',
				inputs: { cmd: 'git status' },
			});
			await umbod.authorize(call, {
				approvalPrompt: async () => ({ decision: 'allow', persist: 'always' }),
			});
			expect(umbod.auditLog.listRememberedApprovals()[0].command).toBe(call.command);
			expect((await umbod.authorize({ ...call, agent: 'other' })).decision).toBe('allow');
			expect(
				(
					await umbod.authorize({
						...call,
						agent: 'codex',
						inputs: {
							tool_input: { command: 'git status' },
							session_id: 'different',
						},
					})
				).decision
			).toBe('allow');
			expect(
				(
					await umbod.authorize({
						...call,
						command: 'git push',
						inputs: { cmd: 'git push' },
					})
				).decision
			).toBe('block');
		} finally {
			umbod.close();
		}
	});

	test('missing scope and storage failure deny and report the failed save', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'umbod-fail-'));
		directories.push(directory);
		const dbPath = join(directory, 'audit.db');
		const umbod = createUmbod({
			manifest,
			dbPath,
			approvalPrompt: async () => ({ decision: 'allow', persist: 'always' }),
		});
		try {
			const noScope = await umbod.authorize({
				...timingCall,
				workingDirectory: undefined,
			});
			expect(noScope.decision).toBe('block');
			expect(noScope.userFeedback).toContain('could not be saved');
			const connection = new Database(dbPath);
			connection.exec('DROP TABLE remembered_approvals');
			connection.close();
			// Restore lookup but fail insertion to exercise the atomic resolution path.
			const failing = new Database(dbPath);
			failing.exec(
				"CREATE TABLE remembered_approvals (grant_key TEXT PRIMARY KEY, tool TEXT, working_directory TEXT, created_at TEXT); CREATE TRIGGER fail_save BEFORE INSERT ON remembered_approvals BEGIN SELECT RAISE(ABORT, 'disk failure'); END;"
			);
			failing.close();
			const result = await umbod.authorize(timingCall);
			expect(result.decision).toBe('block');
			expect(result.userFeedback).toContain('disk failure');
			const approvalId = result.entry.approvalRequestId;
			if (approvalId === undefined) throw new Error('Missing approval record');
			expect(umbod.auditLog.getApprovalStatus(approvalId)).toBe('denied');
			expect(umbod.auditLog.listRememberedApprovals()).toHaveLength(0);
		} finally {
			umbod.close();
		}
	});
});
