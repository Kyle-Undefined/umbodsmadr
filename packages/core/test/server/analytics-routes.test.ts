import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createUmbod } from '../../src/server/api.ts';
import { makeManifest } from '../helpers.ts';

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(path.join(tmpdir(), 'umbod-analytics-route-test-'));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

async function fetchJson(
	umbod: ReturnType<typeof createUmbod>,
	pathName: string,
	init?: RequestInit
): Promise<unknown> {
	const response = await umbod.fetch(new Request(`http://umbod.test${pathName}`, init));
	if (!response) throw new Error(`route did not handle ${pathName}`);
	expect(response.status).toBe(200);
	return response.json();
}

describe('analytics API routes', () => {
	test('exposes embedded analytics and coverage with injected transcript roots', async () => {
		const transcriptRoot = path.join(tempDir, 'claude');
		const projectDir = path.join(transcriptRoot, '-work-project');
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(
			path.join(projectDir, 'session.jsonl'),
			JSON.stringify({
				type: 'assistant',
				timestamp: '2026-07-10T10:00:00.000Z',
				sessionId: 'session-1',
				cwd: '/work/project',
				message: { content: [{ type: 'tool_use', id: 'toolu-1', name: 'Bash', input: { command: 'git status' } }] },
			})
		);
		const otherProjectDir = path.join(transcriptRoot, '-work-other');
		mkdirSync(otherProjectDir, { recursive: true });
		writeFileSync(
			path.join(otherProjectDir, 'session.jsonl'),
			JSON.stringify({
				type: 'assistant',
				timestamp: '2026-07-10T10:00:00.000Z',
				sessionId: 'session-other',
				cwd: '/work/other',
				message: {
					content: [{ type: 'tool_use', id: 'toolu-other', name: 'Bash', input: { command: 'git status' } }],
				},
			})
		);
		const nestedProjectDir = path.join(transcriptRoot, '-work-project-nested');
		mkdirSync(nestedProjectDir, { recursive: true });
		writeFileSync(
			path.join(nestedProjectDir, 'session.jsonl'),
			JSON.stringify({
				type: 'assistant',
				timestamp: '2026-07-10T10:00:00.000Z',
				sessionId: 'session-nested',
				cwd: '/work/project/nested',
				message: {
					content: [{ type: 'tool_use', id: 'toolu-nested', name: 'Bash', input: { command: 'git status' } }],
				},
			})
		);
		const umbod = createUmbod({
			manifest: makeManifest({
				workspaces: [
					{ id: 'strict-project', roots: ['/work/project'], rules: {} },
					{ id: 'nested-project', roots: ['/work/project/nested'], rules: {} },
				],
			}),
			dbPath: path.join(tempDir, 'audit.db'),
			sessionLogSources: [{ agent: 'claude', rootDir: transcriptRoot }],
		});

		try {
			const evaluation = (await fetchJson(umbod, '/api/evaluate', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					agent: 'claude',
					tool: 'bash',
					command: 'git status',
					workingDirectory: '/work/project',
					workspaceId: 'strict-project',
					timestamp: '2026-07-10T10:00:00.000Z',
					sessionId: 'session-1',
					toolUseId: 'toolu-1',
				}),
			})) as {
				entry: { sessionId?: string; toolUseId?: string; resolvedWorkspaceId?: string };
			};
			expect(evaluation.entry).toMatchObject({
				sessionId: 'session-1',
				toolUseId: 'toolu-1',
				resolvedWorkspaceId: 'strict-project',
			});

			const tools = (await fetchJson(umbod, '/api/analytics/tools?since=2026-07-01T00:00:00.000Z')) as {
				totals: { entries: number };
			};
			expect(tools.totals.entries).toBe(1);

			const rules = (await fetchJson(
				umbod,
				'/api/analytics/rules?since=2026-07-01T00:00:00.000Z&workspace=strict-project'
			)) as {
				rules: unknown[];
			};
			expect(rules.rules).toEqual([]);

			const calls = (await fetchJson(
				umbod,
				'/api/analytics/calls?tool=bash&agent=claude&workspace=strict-project&classification=readonly&decision=allow&search=status'
			)) as {
				entries: Array<{ command: string; sessionId?: string; resolvedWorkspaceId?: string }>;
				page: number;
				pageSize: number;
				total: number;
				totalPages: number;
			};
			expect(calls.entries).toEqual([
				expect.objectContaining({
					command: 'git status',
					sessionId: 'session-1',
					resolvedWorkspaceId: 'strict-project',
				}),
			]);
			expect(calls).toMatchObject({ page: 1, pageSize: 50, total: 1, totalPages: 1 });

			const coverage = (await fetchJson(
				umbod,
				'/api/analytics/coverage?since=2026-07-01T00:00:00.000Z&workspace=strict-project'
			)) as {
				coverageRatio: number;
				totals: { sessionCalls: number; matched: number };
			};
			expect(coverage).toMatchObject({ coverageRatio: 1, totals: { sessionCalls: 1, matched: 1 } });
		} finally {
			umbod.close();
		}
	});

	test('requires an exact project for coverage of an id-only workspace', async () => {
		const umbod = createUmbod({
			manifest: makeManifest({
				workspaces: [{ id: 'explicit-only', roots: [], rules: {} }],
			}),
			dbPath: path.join(tempDir, 'audit.db'),
			sessionLogSources: [],
		});

		try {
			const response = await umbod.fetch(
				new Request('http://umbod.test/api/analytics/coverage?workspace=explicit-only')
			);
			expect(response?.status).toBe(400);
			expect(await response?.json()).toEqual({
				ok: false,
				error:
					'workspace "explicit-only" has no roots; coverage requires an exact project because transcripts do not record workspace IDs',
			});
		} finally {
			umbod.close();
		}
	});
});
