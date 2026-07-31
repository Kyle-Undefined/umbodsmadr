import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readClaudeSessionToolCalls } from '../../src/sessions/claude-reader.ts';
import { readCodexSessionToolCalls } from '../../src/sessions/codex-reader.ts';
import { jsonlRecords } from '../../src/sessions/jsonl.ts';
import { sessionSourceMatchesCwd } from '../../src/sessions/source-filter.ts';

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(path.join(tmpdir(), 'umbod-sessions-test-'));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
	const result: T[] = [];
	for await (const item of items) result.push(item);
	return result;
}

describe('session JSONL reader', () => {
	test('skips malformed and oversized records while reading later lines', async () => {
		const file = path.join(tempDir, 'records.jsonl');
		writeFileSync(
			file,
			`${JSON.stringify({ ok: 1 })}\nnot json\n${'x'.repeat(16 * 1024 * 1024 + 1)}\n${JSON.stringify({ ok: 2 })}\n`
		);

		expect(await collect(jsonlRecords(file))).toEqual([{ ok: 1 }, { ok: 2 }]);
	});
});

describe('session source filtering', () => {
	test('uses the most specific inclusion or exclusion for nested workspace roots', () => {
		const source = {
			agent: 'claude' as const,
			scopeProjectRoots: ['/work/repo', '/work/repo/packages/owned'],
			competingProjectRoots: ['/work/repo/packages'],
		};

		expect(sessionSourceMatchesCwd(source, '/work/repo/src')).toBe(true);
		expect(sessionSourceMatchesCwd(source, '/work/repo/packages/other')).toBe(false);
		expect(sessionSourceMatchesCwd(source, '/work/repo/packages/owned/src')).toBe(true);
	});

	test('host root specificity cannot override a nested competing scope', () => {
		const source = {
			agent: 'claude' as const,
			projectRoots: ['/work/repo/packages/owned'],
			scopeProjectRoots: ['/work/repo'],
			competingProjectRoots: ['/work/repo/packages'],
		};

		expect(sessionSourceMatchesCwd(source, '/work/repo/packages/owned/src')).toBe(false);
	});

	test('host exclusions remain hard boundaries beneath more-specific included roots', () => {
		const source = {
			agent: 'claude' as const,
			projectRoots: ['/work/repo', '/work/repo/private/owned'],
			projectRootExclusions: ['/work/repo/private'],
		};

		expect(sessionSourceMatchesCwd(source, '/work/repo/src')).toBe(true);
		expect(sessionSourceMatchesCwd(source, '/work/repo/private/owned/src')).toBe(false);
	});
});

describe('Claude session reader', () => {
	test('normalizes tool calls and includes subagents by default', async () => {
		const root = path.join(tempDir, 'claude');
		const project = '/work/example.app';
		const projectDir = path.join(root, '-work-example-app');
		const subagents = path.join(projectDir, 'session-a', 'subagents');
		mkdirSync(subagents, { recursive: true });
		writeFileSync(
			path.join(projectDir, 'session-a.jsonl'),
			[
				'{malformed',
				JSON.stringify({
					type: 'assistant',
					timestamp: '2026-07-10T10:00:00.000Z',
					sessionId: 'claude-main',
					cwd: project,
					message: {
						content: [{ type: 'tool_use', id: 'toolu-main', name: 'Bash', input: { command: 'git status' } }],
					},
				}),
			].join('\n')
		);
		writeFileSync(
			path.join(subagents, 'agent.jsonl'),
			JSON.stringify({
				type: 'assistant',
				timestamp: '2026-07-10T10:01:00.000Z',
				sessionId: 'claude-subagent',
				cwd: project,
				message: { content: [{ type: 'tool_use', id: 'toolu-sub', name: 'Read', input: { file_path: '/tmp/a' } }] },
			})
		);

		const calls = await collect(
			readClaudeSessionToolCalls({
				agent: 'claude',
				rootDir: root,
				project,
				until: '2026-07-10T10:02:00.000Z',
			})
		);
		expect(calls).toEqual([
			expect.objectContaining({
				sessionId: 'claude-main',
				toolUseId: 'toolu-main',
				tool: 'bash',
				command: 'git status',
				isSubagent: false,
			}),
			expect.objectContaining({
				sessionId: 'claude-subagent',
				toolUseId: 'toolu-sub',
				tool: 'read',
				command: 'read /tmp/a',
				isSubagent: true,
			}),
		]);
	});

	test('can exclude subagent transcripts', async () => {
		const root = path.join(tempDir, 'claude');
		const projectDir = path.join(root, '-work-example');
		mkdirSync(path.join(projectDir, 'session-a', 'subagents'), { recursive: true });
		writeFileSync(path.join(projectDir, 'session-a', 'subagents', 'agent.jsonl'), '');

		expect(
			await collect(
				readClaudeSessionToolCalls({
					agent: 'claude',
					rootDir: root,
					project: '/work/example',
					includeSubagents: false,
				})
			)
		).toEqual([]);
	});

	test('filters transcript calls by workspace-style project roots', async () => {
		const root = path.join(tempDir, 'claude');
		for (const [project, sessionId] of [
			['/work/client/app', 'client-session'],
			['/work/personal/app', 'personal-session'],
		] as const) {
			const projectDir = path.join(root, project.replaceAll(/[/.]/g, '-'));
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(
				path.join(projectDir, `${sessionId}.jsonl`),
				JSON.stringify({
					type: 'assistant',
					timestamp: '2026-07-10T10:00:00.000Z',
					sessionId,
					cwd: project,
					message: {
						content: [{ type: 'tool_use', id: `${sessionId}-tool`, name: 'Bash', input: { command: 'pwd' } }],
					},
				})
			);
		}

		const calls = await collect(
			readClaudeSessionToolCalls({
				agent: 'claude',
				rootDir: root,
				projectRoots: ['/work/client'],
			})
		);

		expect(calls.map((call) => call.sessionId)).toEqual(['client-session']);
	});
});

describe('Codex session reader', () => {
	test('reads function/custom calls and patch completion with canonical tools', async () => {
		const dayDir = path.join(tempDir, 'codex', '2026', '07', '10');
		mkdirSync(dayDir, { recursive: true });
		writeFileSync(
			path.join(dayDir, 'rollout-test.jsonl'),
			[
				JSON.stringify({
					type: 'session_meta',
					timestamp: '2026-07-10T10:00:00.000Z',
					payload: { id: 'codex-1', cwd: '/work/example' },
				}),
				JSON.stringify({
					type: 'response_item',
					timestamp: '2026-07-10T10:00:01.000Z',
					payload: {
						type: 'function_call',
						name: 'exec_command',
						call_id: 'call-1',
						arguments: JSON.stringify({ cmd: 'git status' }),
					},
				}),
				JSON.stringify({
					type: 'response_item',
					timestamp: '2026-07-10T10:00:02.000Z',
					payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'call-2', input: '*** Begin Patch' },
				}),
				JSON.stringify({
					type: 'event_msg',
					timestamp: '2026-07-10T10:00:03.000Z',
					payload: { type: 'patch_apply_end', call_id: 'call-2' },
				}),
				JSON.stringify({
					type: 'event_msg',
					timestamp: '2026-07-10T10:00:04.000Z',
					payload: { type: 'patch_apply_end', call_id: 'call-3' },
				}),
			].join('\n')
		);

		const calls = await collect(
			readCodexSessionToolCalls({ agent: 'codex', rootDir: path.join(tempDir, 'codex'), project: '/work/example' })
		);
		expect(
			calls.map(({ tool, rawToolName, command, toolUseId }) => ({ tool, rawToolName, command, toolUseId }))
		).toEqual([
			{ tool: 'bash', rawToolName: 'exec_command', command: 'git status', toolUseId: 'call-1' },
			{ tool: 'edit', rawToolName: 'apply_patch', command: '*** Begin Patch', toolUseId: 'call-2' },
			{ tool: 'edit', rawToolName: 'apply_patch', command: 'edit', toolUseId: 'call-3' },
		]);
	});

	test('uses date directories to prune an out-of-window transcript', async () => {
		const oldDay = path.join(tempDir, 'codex', '2020', '01', '01');
		mkdirSync(oldDay, { recursive: true });
		writeFileSync(path.join(oldDay, 'rollout-old.jsonl'), '{not json}');

		expect(
			await collect(
				readCodexSessionToolCalls({
					agent: 'codex',
					rootDir: path.join(tempDir, 'codex'),
					since: '2026-01-01T00:00:00.000Z',
				})
			)
		).toEqual([]);
	});

	test('filters transcript calls by workspace-style project roots', async () => {
		const dayDir = path.join(tempDir, 'codex', '2026', '07', '10');
		mkdirSync(dayDir, { recursive: true });
		for (const [name, cwd] of [
			['client', '/work/client/packages/app'],
			['personal', '/work/personal'],
		] as const) {
			writeFileSync(
				path.join(dayDir, `rollout-${name}.jsonl`),
				[
					JSON.stringify({
						type: 'session_meta',
						timestamp: '2026-07-10T10:00:00.000Z',
						payload: { id: `${name}-session`, cwd },
					}),
					JSON.stringify({
						type: 'response_item',
						timestamp: '2026-07-10T10:00:01.000Z',
						payload: {
							type: 'function_call',
							name: 'exec_command',
							call_id: `${name}-call`,
							arguments: JSON.stringify({ cmd: 'pwd' }),
						},
					}),
				].join('\n')
			);
		}

		const calls = await collect(
			readCodexSessionToolCalls({
				agent: 'codex',
				rootDir: path.join(tempDir, 'codex'),
				projectRoots: ['/work/client'],
			})
		);

		expect(calls.map((call) => call.sessionId)).toEqual(['client-session']);
	});
});
