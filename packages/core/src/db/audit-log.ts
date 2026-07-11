import { Database } from 'bun:sqlite';

import type { ApprovalRequest, ApprovalStatus, AuditEntry, EvaluationResult, ToolCall } from '../core/types.ts';
import { SCHEMA } from './schema.ts';

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
	};
}

export class AuditLogStore {
	private readonly database: Database;

	constructor(databasePath: string) {
		this.database = new Database(databasePath, { create: true });
		this.database.exec(SCHEMA);
	}

	close(): void {
		this.database.close();
	}

	append(call: ToolCall, result: EvaluationResult): { entryId: number; approvalRequestId?: number } {
		const timestamp = call.timestamp ?? new Date().toISOString();
		const insertEntry = this.database.query(
			`INSERT INTO audit_log (
        agent, tool, command, args_json, working_directory, inputs_json, timestamp,
        decision, classification, matched_rule, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
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
				result.reason
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

	listPendingApprovals(limit = 50): ApprovalRequest[] {
		const rows = this.database
			.query(
				`SELECT ar.id AS approval_id, ar.audit_log_id, ar.status, ar.created_at, ar.resolved_at,
                al.agent, al.tool, al.command, al.args_json, al.working_directory, al.inputs_json,
                al.timestamp, al.decision, al.classification, al.matched_rule, al.reason
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
