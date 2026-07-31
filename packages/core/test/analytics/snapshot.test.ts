import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyzeRules } from '../../src/analytics/rule-analysis.ts';
import { computeAnalyticsSnapshot } from '../../src/analytics/snapshot.ts';
import { computeToolUsage } from '../../src/analytics/tool-usage.ts';
import { AuditLogStore } from '../../src/db/audit-log.ts';
import { makeCall, makeManifest } from '../helpers.ts';

let tempDir: string;
let store: AuditLogStore;

class MutatingAuditLogStore extends AuditLogStore {
	externalWriter?: AuditLogStore;
	remainingMutations = 0;

	override usageTotals(
		filter: Parameters<AuditLogStore['usageTotals']>[0] = {}
	): ReturnType<AuditLogStore['usageTotals']> {
		if (this.remainingMutations > 0 && this.externalWriter) {
			this.remainingMutations -= 1;
			this.externalWriter.append(makeCall({ command: `external-${this.remainingMutations}` }), {
				decision: 'allow',
				classification: 'readonly',
				reason: 'external mutation',
			});
		}
		return super.usageTotals(filter);
	}
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'umbod-snapshot-test-'));
	store = new AuditLogStore(join(tempDir, 'audit.db'));
});

afterEach(() => {
	store.close();
	rmSync(tempDir, { recursive: true, force: true });
});

describe('analytics snapshot', () => {
	test('matches standalone reports and carries a stable revision', () => {
		const manifest = makeManifest({ rules: { 'git *': 'allow' } });
		store.append(makeCall({ command: 'git status' }), {
			decision: 'allow',
			classification: 'readonly',
			matchedRule: 'git *',
			reason: 'matched rule',
		});
		const query = { agent: 'test', topCommandsPerTool: 3, minOccurrences: 2 };

		const snapshot = computeAnalyticsSnapshot(store, manifest, query);

		expect(snapshot.tools).toEqual(computeToolUsage(store, manifest, query));
		expect(snapshot.rules).toEqual(analyzeRules(manifest, store, query));
		expect(snapshot.revision).toBe(store.revision());
	});

	test('updates the writer revision after local mutations', () => {
		const manifest = makeManifest();
		const before = computeAnalyticsSnapshot(store, manifest).revision;

		store.append(makeCall({ command: 'git status' }), {
			decision: 'allow',
			classification: 'readonly',
			reason: 'test',
		});

		expect(computeAnalyticsSnapshot(store, manifest).revision).not.toBe(before);
	});

	test('retries once when another WAL connection commits during the first attempt', () => {
		store.close();
		const databasePath = join(tempDir, 'audit.db');
		const external = new AuditLogStore(databasePath, { journalMode: 'wal' });
		const mutating = new MutatingAuditLogStore(databasePath, { journalMode: 'wal' });
		store = mutating;
		mutating.externalWriter = external;
		mutating.remainingMutations = 1;

		const snapshot = computeAnalyticsSnapshot(mutating, makeManifest(), { projection: 'summary' });

		expect(snapshot.tools.totals.entries).toBe(1);
		expect(snapshot.revision).toBe(mutating.revision());
		external.close();
	});

	test('omits the cache token when the database changes during both attempts', () => {
		store.close();
		const databasePath = join(tempDir, 'audit.db');
		const external = new AuditLogStore(databasePath, { journalMode: 'wal' });
		const mutating = new MutatingAuditLogStore(databasePath, { journalMode: 'wal' });
		store = mutating;
		mutating.externalWriter = external;
		mutating.remainingMutations = 2;

		const snapshot = computeAnalyticsSnapshot(mutating, makeManifest(), { projection: 'summary' });

		expect(snapshot.tools.totals.entries).toBe(2);
		expect(snapshot.revision).toBeUndefined();
		external.close();
	});
});
