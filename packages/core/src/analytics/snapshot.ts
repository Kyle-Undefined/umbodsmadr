import type { Manifest } from '../core/types.ts';
import type { AuditLogReader } from '../db/audit-log.ts';
import { analyzeRules } from './rule-analysis.ts';
import { computeToolUsage } from './tool-usage.ts';
import type { AnalyticsSnapshot, AnalyticsSnapshotQuery } from './types.ts';

function computeReports(
	auditLog: AuditLogReader,
	manifest: Manifest,
	query: AnalyticsSnapshotQuery
): Omit<AnalyticsSnapshot, 'revision'> {
	const common = {
		since: query.since,
		until: query.until,
		agent: query.agent,
		project: query.project,
		workspace: query.workspace,
	};
	return {
		tools: computeToolUsage(auditLog, manifest, {
			...common,
			projection: query.projection,
			recentWindowDays: query.recentWindowDays,
			topCommandsPerTool: query.topCommandsPerTool,
		}),
		rules: analyzeRules(manifest, auditLog, {
			...common,
			projection: query.projection,
			minOccurrences: query.minOccurrences,
			replayLimit: query.replayLimit,
		}),
	};
}

/**
 * Compute the reports consumers usually request together against one SQLite
 * read snapshot. Retry once if another connection commits during the read.
 */
export function computeAnalyticsSnapshot(
	auditLog: AuditLogReader,
	manifest: Manifest,
	query: AnalyticsSnapshotQuery = {}
): AnalyticsSnapshot {
	let reports: Omit<AnalyticsSnapshot, 'revision'> | undefined;

	for (let attempt = 0; attempt < 2; attempt += 1) {
		const before = auditLog.revision();
		reports = auditLog.withSnapshot(() => computeReports(auditLog, manifest, query));
		const after = auditLog.revision();
		if (before === after) return { ...reports, revision: after };
	}

	// The reports themselves are transactionally consistent, but omitting the
	// token prevents consumers from caching them against a newer database state.
	return reports as Omit<AnalyticsSnapshot, 'revision'>;
}
