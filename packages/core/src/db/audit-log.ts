import { Database } from 'bun:sqlite';

import type {
	ApprovalHotspot,
	AuditFilter,
	CoverageAuditRow,
	MatchedRuleCount,
	TaskTypeRow,
	ToolUsageRow,
} from '../analytics/types.ts';
import type { ApprovalRequest, ApprovalStatus, AuditEntry, EvaluationResult, ToolCall } from '../core/types.ts';
import { MIGRATIONS, SCHEMA, SCHEMA_VERSION } from './schema.ts';

const VALID_DECISIONS = new Set<string>(['allow', 'block', 'approve']);
const VALID_CLASSIFICATIONS = new Set<string>(['readonly', 'destructive', 'external', 'stateful', 'unknown']);

function safeJsonParse<T>(value: unknown, fallback: T): T {
	if (typeof value !== 'string') {
		return fallback;
	}

	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function rowToAuditEntry(row: Record<string, unknown>): AuditEntry {
	const rawId = row.id ?? row.audit_log_id;
	if (rawId === undefined || rawId === null) {
		throw new Error('missing id in audit log row');
	}

	const id = Number(rawId);
	if (!Number.isFinite(id)) {
		throw new Error(`invalid audit log row id: ${String(rawId)}`);
	}

	if (typeof row.decision !== 'string' || !VALID_DECISIONS.has(row.decision)) {
		throw new Error(`invalid decision in audit log row: ${String(row.decision)}`);
	}

	if (typeof row.classification !== 'string' || !VALID_CLASSIFICATIONS.has(row.classification)) {
		throw new Error(`invalid classification in audit log row: ${String(row.classification)}`);
	}

	return {
		id,
		agent: String(row.agent),
		tool: String(row.tool),
		command: String(row.command),
		args: safeJsonParse<string[]>(row.args_json, []),
		workingDirectory: row.working_directory === null ? undefined : String(row.working_directory),
		inputs: safeJsonParse<Record<string, unknown>>(row.inputs_json, {}),
		timestamp: String(row.timestamp),
		decision: row.decision as AuditEntry['decision'],
		classification: row.classification as AuditEntry['classification'],
		matchedRule: row.matched_rule === null ? undefined : String(row.matched_rule),
		reason: String(row.reason),
		sessionId: row.session_id === null || row.session_id === undefined ? undefined : String(row.session_id),
		toolUseId: row.tool_use_id === null || row.tool_use_id === undefined ? undefined : String(row.tool_use_id),
	};
}

export class AuditLogStore {
	private readonly database: Database;

	constructor(databasePath: string) {
		this.database = new Database(databasePath, { create: true });
		this.migrate();
		this.database.exec(SCHEMA);
		this.database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	}

	// Bring a pre-existing audit_log up to the current shape before SCHEMA
	// runs, since SCHEMA's index statements assume the new columns exist.
	private migrate(): void {
		const tableExists =
			this.database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'").get() !== null;
		if (!tableExists) {
			return;
		}

		const { user_version: userVersion } = this.database.query('PRAGMA user_version').get() as {
			user_version: number;
		};
		if (userVersion >= SCHEMA_VERSION) {
			return;
		}

		const columns = new Set(
			(this.database.query('PRAGMA table_info(audit_log)').all() as Array<{ name: string }>).map((row) => row.name)
		);

		this.database.transaction(() => {
			for (let version = userVersion + 1; version <= SCHEMA_VERSION; version += 1) {
				for (const statement of MIGRATIONS[version] ?? []) {
					if (statement.addsColumn && columns.has(statement.addsColumn)) {
						continue;
					}
					this.database.exec(statement.sql);
				}
			}
		})();
	}

	close(): void {
		this.database.close();
	}

	append(call: ToolCall, result: EvaluationResult): { entryId: number; approvalRequestId?: number } {
		const timestamp = call.timestamp ?? new Date().toISOString();
		const insertEntry = this.database.query(
			`INSERT INTO audit_log (
        agent, tool, command, args_json, working_directory, inputs_json, timestamp,
        decision, classification, matched_rule, reason, session_id, tool_use_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
		);
		const insertApproval = this.database.query(
			'INSERT INTO approval_requests (audit_log_id, created_at) VALUES (?, ?) RETURNING id'
		);

		return this.database.transaction(() => {
			const row = insertEntry.get(
				call.agent,
				call.tool,
				call.command,
				JSON.stringify(call.args ?? []),
				call.workingDirectory ?? null,
				JSON.stringify(call.inputs ?? {}),
				timestamp,
				result.decision,
				result.classification,
				result.matchedRule ?? null,
				result.reason,
				call.sessionId ?? null,
				call.toolUseId ?? null
			) as { id: number };
			let approvalRequestId: number | undefined;

			if (result.decision === 'approve') {
				const approvalRow = insertApproval.get(row.id, timestamp) as { id: number };
				approvalRequestId = approvalRow.id;
			}

			return { entryId: row.id, approvalRequestId };
		})();
	}

	listRecent(limit?: number): AuditEntry[] {
		let sql = `SELECT al.id, al.agent, al.tool, al.command, al.args_json, al.working_directory, al.inputs_json,
                al.timestamp, al.decision, al.classification, al.matched_rule, al.reason,
                al.session_id, al.tool_use_id,
                ar.status AS approval_status, ar.resolved_at AS approval_resolved_at
         FROM audit_log al
         LEFT JOIN approval_requests ar ON ar.audit_log_id = al.id
         ORDER BY al.id DESC`;
		if (limit !== undefined) sql += ` LIMIT ?`;
		const rows = this.database.query(sql).all(...(limit !== undefined ? [limit] : [])) as Array<
			Record<string, unknown>
		>;

		return rows.map((row) => ({
			...rowToAuditEntry(row),
			approvalStatus: row.approval_status === null ? undefined : (String(row.approval_status) as ApprovalStatus),
			approvalResolvedAt: row.approval_resolved_at === null ? undefined : String(row.approval_resolved_at),
		}));
	}

	listRecentFiltered(filter: AuditFilter = {}, limit = 2000): AuditEntry[] {
		const { where, params } = this.buildFilter(filter, 'al');
		const rows = this.database
			.query(
				`SELECT al.id, al.agent, al.tool, al.command, al.args_json, al.working_directory, al.inputs_json,
                al.timestamp, al.decision, al.classification, al.matched_rule, al.reason,
                al.session_id, al.tool_use_id,
                ar.status AS approval_status, ar.resolved_at AS approval_resolved_at
         FROM audit_log al
         LEFT JOIN approval_requests ar ON ar.audit_log_id = al.id
         ${where}
         ORDER BY al.id DESC
         LIMIT ?`
			)
			.all(...params, limit) as Array<Record<string, unknown>>;

		return rows.map((row) => ({
			...rowToAuditEntry(row),
			approvalStatus: row.approval_status === null ? undefined : (String(row.approval_status) as ApprovalStatus),
			approvalResolvedAt: row.approval_resolved_at === null ? undefined : String(row.approval_resolved_at),
		}));
	}

	listPendingApprovals(limit = 50): ApprovalRequest[] {
		const rows = this.database
			.query(
				`SELECT ar.id AS approval_id, ar.audit_log_id, ar.status, ar.created_at, ar.resolved_at,
                al.agent, al.tool, al.command, al.args_json, al.working_directory, al.inputs_json,
                al.timestamp, al.decision, al.classification, al.matched_rule, al.reason,
                al.session_id, al.tool_use_id
         FROM approval_requests ar
         JOIN audit_log al ON al.id = ar.audit_log_id
         WHERE ar.status = 'pending'
         ORDER BY ar.id DESC
         LIMIT ?`
			)
			.all(limit) as Array<Record<string, unknown>>;

		return rows.map((row) => ({
			id: Number(row.approval_id),
			auditLogId: Number(row.audit_log_id),
			status: row.status as ApprovalStatus,
			createdAt: String(row.created_at),
			resolvedAt: row.resolved_at === null ? undefined : String(row.resolved_at),
			entry: rowToAuditEntry(row),
		}));
	}

	// ── Analytics queries ────────────────────────────────────────

	private buildFilter(filter: AuditFilter, alias = ''): { where: string; params: (string | number)[] } {
		const prefix = alias.length > 0 ? `${alias}.` : '';
		const clauses: string[] = [];
		const params: (string | number)[] = [];

		if (filter.since !== undefined) {
			clauses.push(`${prefix}timestamp >= ?`);
			params.push(filter.since);
		}
		if (filter.until !== undefined) {
			clauses.push(`${prefix}timestamp <= ?`);
			params.push(filter.until);
		}
		if (filter.agent !== undefined) {
			clauses.push(`${prefix}agent = ?`);
			params.push(filter.agent);
		}
		if (filter.project !== undefined) {
			clauses.push(`${prefix}working_directory = ?`);
			params.push(filter.project);
		}

		return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
	}

	usageTotals(filter: AuditFilter = {}): { entries: number; sessions: number; agents: string[]; projects: string[] } {
		const { where, params } = this.buildFilter(filter);
		const row = this.database
			.query(
				`SELECT COUNT(*) AS entries, COUNT(DISTINCT session_id) AS sessions
         FROM audit_log ${where}`
			)
			.get(...params) as { entries: number; sessions: number };
		const agents = this.database
			.query(`SELECT DISTINCT agent FROM audit_log ${where} ORDER BY agent`)
			.all(...params) as Array<{ agent: string }>;
		const projects = this.database
			.query(
				`SELECT DISTINCT working_directory FROM audit_log ${where}${where ? ' AND' : ' WHERE'} working_directory IS NOT NULL ORDER BY working_directory`
			)
			.all(...params) as Array<{ working_directory: string }>;

		return {
			entries: row.entries,
			sessions: row.sessions,
			agents: agents.map((entry) => entry.agent),
			projects: projects.map((entry) => entry.working_directory),
		};
	}

	aggregateToolUsage(filter: AuditFilter = {}): Array<Omit<ToolUsageRow, 'topCommands'>> {
		const { where, params } = this.buildFilter(filter);
		const rows = this.database
			.query(
				`SELECT agent, tool, COUNT(*) AS count,
                SUM(CASE WHEN decision = 'allow' THEN 1 ELSE 0 END) AS allow_count,
                SUM(CASE WHEN decision = 'block' THEN 1 ELSE 0 END) AS block_count,
                SUM(CASE WHEN decision = 'approve' THEN 1 ELSE 0 END) AS approve_count,
                SUM(CASE WHEN classification = 'readonly' THEN 1 ELSE 0 END) AS readonly_count,
                SUM(CASE WHEN classification = 'destructive' THEN 1 ELSE 0 END) AS destructive_count,
                SUM(CASE WHEN classification = 'external' THEN 1 ELSE 0 END) AS external_count,
                SUM(CASE WHEN classification = 'stateful' THEN 1 ELSE 0 END) AS stateful_count,
                SUM(CASE WHEN classification = 'unknown' THEN 1 ELSE 0 END) AS unknown_count,
                MIN(timestamp) AS first_seen, MAX(timestamp) AS last_seen
         FROM audit_log ${where}
         GROUP BY agent, tool
         ORDER BY count DESC`
			)
			.all(...params) as Array<Record<string, unknown>>;

		return rows.map((row) => {
			const classifications: ToolUsageRow['classifications'] = {};
			for (const key of ['readonly', 'destructive', 'external', 'stateful', 'unknown'] as const) {
				const count = Number(row[`${key}_count`]);
				if (count > 0) classifications[key] = count;
			}

			return {
				agent: String(row.agent),
				tool: String(row.tool),
				count: Number(row.count),
				decisions: {
					allow: Number(row.allow_count),
					block: Number(row.block_count),
					approve: Number(row.approve_count),
				},
				classifications,
				firstSeen: String(row.first_seen),
				lastSeen: String(row.last_seen),
			};
		});
	}

	topCommandsByTool(
		filter: AuditFilter = {},
		limitPerTool = 5
	): Map<string, Array<{ command: string; count: number }>> {
		const { where, params } = this.buildFilter(filter);
		const rows = this.database
			.query(
				`SELECT tool, command, count FROM (
           SELECT tool, command, COUNT(*) AS count,
                  ROW_NUMBER() OVER (PARTITION BY tool ORDER BY COUNT(*) DESC, command) AS rank
           FROM audit_log ${where}
           GROUP BY tool, command
         ) WHERE rank <= ?
         ORDER BY tool, count DESC`
			)
			.all(...params, limitPerTool) as Array<{ tool: string; command: string; count: number }>;

		const byTool = new Map<string, Array<{ command: string; count: number }>>();
		for (const row of rows) {
			const list = byTool.get(row.tool) ?? [];
			list.push({ command: row.command, count: row.count });
			byTool.set(row.tool, list);
		}

		return byTool;
	}

	aggregateTaskTypes(filter: AuditFilter = {}): TaskTypeRow[] {
		const { where, params } = this.buildFilter(filter);
		const rows = this.database
			.query(
				`SELECT working_directory, classification, COUNT(*) AS count,
                SUM(CASE WHEN decision = 'allow' THEN 1 ELSE 0 END) AS allow_count,
                SUM(CASE WHEN decision = 'block' THEN 1 ELSE 0 END) AS block_count,
                SUM(CASE WHEN decision = 'approve' THEN 1 ELSE 0 END) AS approve_count
         FROM audit_log ${where}
         GROUP BY working_directory, classification
         ORDER BY count DESC`
			)
			.all(...params) as Array<Record<string, unknown>>;

		return rows.map((row) => ({
			workingDirectory: row.working_directory === null ? null : String(row.working_directory),
			classification: String(row.classification) as TaskTypeRow['classification'],
			count: Number(row.count),
			decisions: {
				allow: Number(row.allow_count),
				block: Number(row.block_count),
				approve: Number(row.approve_count),
			},
		}));
	}

	matchedRuleCounts(filter: AuditFilter = {}): MatchedRuleCount[] {
		const { where, params } = this.buildFilter(filter);
		const rows = this.database
			.query(
				`SELECT matched_rule, COUNT(*) AS count, MAX(timestamp) AS last_matched
         FROM audit_log ${where}${where ? ' AND' : ' WHERE'} matched_rule IS NOT NULL
         GROUP BY matched_rule`
			)
			.all(...params) as Array<{ matched_rule: string; count: number; last_matched: string }>;

		return rows.map((row) => ({
			matchedRule: row.matched_rule,
			count: row.count,
			lastMatched: row.last_matched,
		}));
	}

	approvalHotspots(filter: AuditFilter = {}, sampleLimit = 3): ApprovalHotspot[] {
		const { where, params } = this.buildFilter(filter, 'al');
		const rows = this.database
			.query(
				`SELECT al.tool,
                CASE WHEN instr(al.command, ' ') > 0
                     THEN substr(al.command, 1, instr(al.command, ' ') - 1)
                     ELSE al.command END AS command_key,
                COUNT(*) AS total,
                SUM(CASE WHEN ar.status = 'approved' THEN 1 ELSE 0 END) AS approved,
                SUM(CASE WHEN ar.status = 'denied' THEN 1 ELSE 0 END) AS denied,
                SUM(CASE WHEN ar.status = 'pending' THEN 1 ELSE 0 END) AS pending,
                AVG(CASE WHEN ar.resolved_at IS NOT NULL
                    THEN (julianday(ar.resolved_at) - julianday(ar.created_at)) * 86400000.0
                    ELSE NULL END) AS avg_resolution_ms
         FROM audit_log al
         JOIN approval_requests ar ON ar.audit_log_id = al.id
         ${where}${where ? ' AND' : ' WHERE'} al.decision = 'approve'
         GROUP BY al.tool, command_key
         ORDER BY total DESC`
			)
			.all(...params) as Array<Record<string, unknown>>;

		return rows.map((row) => {
			const sampleRows = this.database
				.query(
					`SELECT DISTINCT command FROM audit_log
           WHERE decision = 'approve' AND tool = ? AND
                 (CASE WHEN instr(command, ' ') > 0
                       THEN substr(command, 1, instr(command, ' ') - 1)
                       ELSE command END) = ?
           ORDER BY id DESC LIMIT ?`
				)
				.all(String(row.tool), String(row.command_key), sampleLimit) as Array<{ command: string }>;

			return {
				tool: String(row.tool),
				commandKey: String(row.command_key),
				total: Number(row.total),
				approved: Number(row.approved),
				denied: Number(row.denied),
				pending: Number(row.pending),
				avgResolutionMs: row.avg_resolution_ms === null ? undefined : Number(row.avg_resolution_ms),
				sampleCommands: sampleRows.map((sample) => sample.command),
			};
		});
	}

	unmatchedEntries(filter: AuditFilter = {}, limit = 2000): AuditEntry[] {
		const { where, params } = this.buildFilter(filter, 'al');
		const rows = this.database
			.query(
				`SELECT al.id, al.agent, al.tool, al.command, al.args_json, al.working_directory, al.inputs_json,
                al.timestamp, al.decision, al.classification, al.matched_rule, al.reason,
                al.session_id, al.tool_use_id,
                ar.status AS approval_status, ar.resolved_at AS approval_resolved_at
         FROM audit_log al
         LEFT JOIN approval_requests ar ON ar.audit_log_id = al.id
         ${where}${where ? ' AND' : ' WHERE'} al.matched_rule IS NULL
         ORDER BY al.id DESC
         LIMIT ?`
			)
			.all(...params, limit) as Array<Record<string, unknown>>;

		return rows.map((row) => ({
			...rowToAuditEntry(row),
			approvalStatus: row.approval_status === null ? undefined : (String(row.approval_status) as ApprovalStatus),
			approvalResolvedAt: row.approval_resolved_at === null ? undefined : String(row.approval_resolved_at),
		}));
	}

	entriesForCoverage(filter: AuditFilter = {}): CoverageAuditRow[] {
		const { where, params } = this.buildFilter(filter);
		const rows = this.database
			.query(
				`SELECT id, agent, tool, command, timestamp, session_id, tool_use_id, working_directory
         FROM audit_log ${where}
         ORDER BY timestamp`
			)
			.all(...params) as Array<Record<string, unknown>>;

		return rows.map((row) => ({
			id: Number(row.id),
			agent: String(row.agent),
			tool: String(row.tool),
			command: String(row.command),
			timestamp: String(row.timestamp),
			sessionId: row.session_id === null ? undefined : String(row.session_id),
			toolUseId: row.tool_use_id === null ? undefined : String(row.tool_use_id),
			workingDirectory: row.working_directory === null ? undefined : String(row.working_directory),
		}));
	}

	getApprovalStatus(id: number): ApprovalStatus | undefined {
		const row = this.database.query('SELECT status FROM approval_requests WHERE id = ?').get(id) as {
			status?: ApprovalStatus;
		} | null;

		return row?.status;
	}

	resolveApprovalRequest(id: number, status: Exclude<ApprovalStatus, 'pending'>): boolean {
		const result = this.database
			.query(
				`UPDATE approval_requests
         SET status = ?, resolved_at = ?
         WHERE id = ? AND status = 'pending'`
			)
			.run(status, new Date().toISOString(), id);

		return result.changes > 0;
	}
}
