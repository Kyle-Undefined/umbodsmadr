import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { computeCoverage, scopeCoverageSources } from '../../src/analytics/coverage.ts';
import { AuditLogStore } from '../../src/db/audit-log.ts';
import { makeCall, makeManifest } from '../helpers.ts';

let tempDir: string;
let store: AuditLogStore;

beforeEach(() => {
	tempDir = mkdtempSync(path.join(tmpdir(), 'umbod-coverage-test-'));
	store = new AuditLogStore(path.join(tempDir, 'audit.db'));
});

afterEach(() => {
	store.close();
	rmSync(tempDir, { recursive: true, force: true });
});

function append(call: Parameters<typeof makeCall>[0]): void {
	store.append(makeCall({ agent: 'claude', workingDirectory: '/work/project', ...call }), {
		decision: 'allow',
		classification: 'readonly',
		reason: 'test',
	});
}

function writeClaudeTranscript(records: unknown[]): string {
	const root = path.join(tempDir, 'claude');
	const directory = path.join(root, '-work-project');
	mkdirSync(directory, { recursive: true });
	writeFileSync(path.join(directory, 'session.jsonl'), records.map((record) => JSON.stringify(record)).join('\n'));
	return root;
}

function toolRecord(timestamp: string, id: string, name: string, input: Record<string, unknown>): unknown {
	return {
		type: 'assistant',
		timestamp,
		sessionId: 'session-1',
		cwd: '/work/project',
		message: { content: [{ type: 'tool_use', id, name, input }] },
	};
}

describe('analytics > coverage', () => {
	test('intersects workspace roots with host source boundaries and preserves exclusions', () => {
		const manifest = makeManifest({
			workspaces: [
				{ id: 'selected', roots: ['/allowed/project'], rules: {} },
				{ id: 'nested', roots: ['/allowed/project/packages/nested'], rules: {} },
			],
		});
		const scoped = scopeCoverageSources(
			manifest,
			[
				{
					agent: 'claude',
					projectRoots: ['/allowed'],
					projectRootExclusions: ['/allowed/project/private'],
				},
				{ agent: 'codex', projectRoots: ['/other'] },
			],
			{ workspace: 'selected' }
		);

		expect(scoped).toEqual([
			expect.objectContaining({
				agent: 'claude',
				projectRoots: ['/allowed'],
				projectRootExclusions: ['/allowed/project/private'],
				scopeProjectRoots: ['/allowed/project'],
				competingProjectRoots: ['/allowed/project/packages/nested'],
			}),
		]);
	});

	test('keeps host source boundaries when an exact project disambiguates workspace coverage', () => {
		const manifest = makeManifest({
			workspaces: [{ id: 'explicit', roots: [], rules: {} }],
		});
		const scoped = scopeCoverageSources(
			manifest,
			[
				{ agent: 'claude', projectRoots: ['/allowed'] },
				{ agent: 'codex', project: '/different' },
			],
			{ workspace: 'explicit', project: '/allowed/project' }
		);

		expect(scoped).toEqual([
			expect.objectContaining({
				agent: 'claude',
				project: '/allowed/project',
				projectRoots: ['/allowed'],
			}),
		]);
	});

	test('matches exact ids, session command pairs, then timestamp heuristics without reusing audit rows', async () => {
		append({
			command: 'different command',
			timestamp: '2026-07-10T10:00:00.000Z',
			sessionId: 'session-1',
			toolUseId: 'toolu-exact',
		});
		append({ command: 'git status', timestamp: '2026-07-10T10:05:00.000Z', sessionId: 'session-1' });
		append({ command: 'pwd', timestamp: '2026-07-10T10:10:05.000Z' });
		append({ command: 'orphan', timestamp: '2026-07-10T10:20:00.000Z' });
		const root = writeClaudeTranscript([
			toolRecord('2026-07-10T10:00:01.000Z', 'toolu-exact', 'Bash', { command: 'git status' }),
			toolRecord('2026-07-10T10:05:20.000Z', 'toolu-high', 'Bash', { command: 'git status' }),
			toolRecord('2026-07-10T10:10:00.000Z', 'toolu-medium', 'Bash', { command: 'pwd' }),
			toolRecord('2026-07-10T10:15:00.000Z', 'toolu-gap', 'Read', { file_path: '/tmp/missing' }),
		]);

		const report = await computeCoverage(store, [
			{ agent: 'claude', rootDir: root, project: '/work/project', since: '2026-07-10T00:00:00.000Z' },
		]);

		expect(report.totals).toEqual({ sessionCalls: 4, auditEntries: 4, matched: 3, gaps: 1, orphans: 1 });
		expect(report.coverageRatio).toBe(0.75);
		expect(report.gaps.map((gap) => gap.toolUseId)).toEqual(['toolu-gap']);
		expect(report.orphanAuditIds).toHaveLength(1);
		expect(report.byAgent).toEqual([{ key: 'claude', sessionCalls: 4, matched: 3, coverageRatio: 0.75 }]);
	});

	test('warns when most audit history predates session identity', async () => {
		append({ command: 'pwd', timestamp: '2026-07-10T10:00:00.000Z' });
		const root = writeClaudeTranscript([]);

		const report = await computeCoverage(store, [{ agent: 'claude', rootDir: root, project: '/work/project' }]);

		expect(report.notes).toContain(
			'Most audit entries lack session identity, so older data can only use heuristic matching.'
		);
	});
});
