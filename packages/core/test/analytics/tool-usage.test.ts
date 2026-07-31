import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { computeToolUsage } from '../../src/analytics/tool-usage.ts';
import { AuditLogStore } from '../../src/db/audit-log.ts';
import type { EvaluationResult, ToolCall } from '../../src/core/types.ts';
import { makeCall, makeManifest } from '../helpers.ts';

let tempDir: string;

class CountingAuditLogStore extends AuditLogStore {
	aggregateToolUsageCalls = 0;
	topCommandsCalls = 0;
	taskTypeCalls = 0;
	distinctToolsCalls = 0;

	override aggregateToolUsage(
		filter: Parameters<AuditLogStore['aggregateToolUsage']>[0] = {}
	): ReturnType<AuditLogStore['aggregateToolUsage']> {
		this.aggregateToolUsageCalls += 1;
		return super.aggregateToolUsage(filter);
	}

	override topCommandsByTool(
		filter: Parameters<AuditLogStore['topCommandsByTool']>[0] = {},
		limitPerTool?: number
	): ReturnType<AuditLogStore['topCommandsByTool']> {
		this.topCommandsCalls += 1;
		return super.topCommandsByTool(filter, limitPerTool);
	}

	override aggregateTaskTypes(
		filter: Parameters<AuditLogStore['aggregateTaskTypes']>[0] = {}
	): ReturnType<AuditLogStore['aggregateTaskTypes']> {
		this.taskTypeCalls += 1;
		return super.aggregateTaskTypes(filter);
	}

	override distinctTools(
		filter: Parameters<AuditLogStore['distinctTools']>[0] = {}
	): ReturnType<AuditLogStore['distinctTools']> {
		this.distinctToolsCalls += 1;
		return super.distinctTools(filter);
	}
}

let store: CountingAuditLogStore;

function makeResult(overrides: Partial<EvaluationResult> = {}): EvaluationResult {
	return {
		decision: 'allow',
		classification: 'readonly',
		reason: 'auto-allowed readonly tool call',
		...overrides,
	};
}

function seed(call: Partial<ToolCall>, result: Partial<EvaluationResult> = {}): void {
	store.append(makeCall(call), makeResult(result));
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'umbod-analytics-test-'));
	store = new CountingAuditLogStore(join(tempDir, 'test.db'));
});

afterEach(() => {
	store.close();
	rmSync(tempDir, { recursive: true, force: true });
});

describe('analytics > tool usage', () => {
	test('aggregates counts, decisions, and classifications per tool', () => {
		seed({ tool: 'bash', command: 'git status' });
		seed({ tool: 'bash', command: 'git status' });
		seed({ tool: 'bash', command: 'rm -rf /' }, { decision: 'block', classification: 'destructive' });
		seed({ tool: 'read', command: 'read /tmp/file' });

		const stats = computeToolUsage(store, makeManifest());

		const bash = stats.byTool.find((row) => row.tool === 'bash');
		expect(bash?.count).toBe(3);
		expect(bash?.decisions).toEqual({ allow: 2, block: 1, approve: 0 });
		expect(bash?.classifications.readonly).toBe(2);
		expect(bash?.classifications.destructive).toBe(1);
		expect(bash?.topCommands[0]).toEqual({ command: 'git status', count: 2 });

		expect(stats.totals.entries).toBe(4);
		expect(store.aggregateToolUsageCalls).toBe(1);
	});

	test('groups task types by working directory and classification', () => {
		seed({ workingDirectory: '/home/x/proj-a' });
		seed({ workingDirectory: '/home/x/proj-a' });
		seed({ workingDirectory: '/home/x/proj-b', command: 'rm -rf /' }, { classification: 'destructive' });

		const stats = computeToolUsage(store, makeManifest());

		expect(stats.byTaskType).toHaveLength(2);
		const projA = stats.byTaskType.find((row) => row.workingDirectory === '/home/x/proj-a');
		expect(projA?.count).toBe(2);
		expect(projA?.classification).toBe('readonly');
	});

	test('summary projection skips drill-down scans', () => {
		seed({ tool: 'bash', command: 'git status' });

		const stats = computeToolUsage(store, makeManifest(), { projection: 'summary' });

		expect(stats.projection).toBe('summary');
		expect(stats.totals.entries).toBe(1);
		expect(stats.byTool[0]?.topCommands).toEqual([]);
		expect(stats.byTaskType).toEqual([]);
		expect(stats.unusedTools).toEqual([]);
		expect(store.aggregateToolUsageCalls).toBe(1);
		expect(store.topCommandsCalls).toBe(0);
		expect(store.taskTypeCalls).toBe(0);
		expect(store.distinctToolsCalls).toBe(0);
	});

	test('counts distinct sessions', () => {
		seed({ sessionId: 'sess-1' });
		seed({ sessionId: 'sess-1' });
		seed({ sessionId: 'sess-2' });
		seed({});

		const stats = computeToolUsage(store, makeManifest());
		expect(stats.totals.sessions).toBe(2);
	});

	test('filters by since window', () => {
		seed({ timestamp: '2020-01-01T00:00:00.000Z' });
		seed({ timestamp: '2026-01-01T00:00:00.000Z' });

		const stats = computeToolUsage(store, makeManifest(), { since: '2025-01-01T00:00:00.000Z' });
		expect(stats.totals.entries).toBe(1);
		expect(store.aggregateToolUsageCalls).toBe(2);
	});

	test('flags historical tools unused in the recent window', () => {
		seed({ tool: 'grep', timestamp: '2020-01-01T00:00:00.000Z' });
		seed({ tool: 'bash', timestamp: new Date().toISOString() });

		const stats = computeToolUsage(store, makeManifest());
		const stale = stats.unusedTools.find((entry) => entry.tool === 'grep');
		expect(stale?.source).toBe('history');
		expect(stale?.lastSeen).toBe('2020-01-01T00:00:00.000Z');
		expect(stats.unusedTools.find((entry) => entry.tool === 'bash')).toBeUndefined();
	});

	test('flags tools referenced by rules but never seen', () => {
		seed({ tool: 'bash' });

		const manifest = makeManifest({ rules: { 'write /etc/*': 'block' } });
		const stats = computeToolUsage(store, manifest);
		const ruleRef = stats.unusedTools.find((entry) => entry.tool === 'write');
		expect(ruleRef?.source).toBe('rules');
		expect(ruleRef?.referencedByRules).toEqual(['write /etc/*']);
	});

	test('flags adapter-declared tools never seen', () => {
		seed({ tool: 'bash' });

		const stats = computeToolUsage(store, makeManifest());
		const adapterTool = stats.unusedTools.find((entry) => entry.tool === 'read');
		expect(adapterTool?.source).toBe('adapter');
	});
});
