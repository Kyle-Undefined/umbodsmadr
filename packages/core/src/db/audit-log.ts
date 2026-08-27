import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

import type {
	ApprovalHotspot,
	AuditFilter,
	AuditEntrySummary,
	CursorCallQuery,
	CursorCallPage,
	CoverageAuditRow,
	MatchedRuleCount,
	TaskTypeRow,
	ToolUsageRow,
} from '../analytics/types.ts';
import type {
	ApprovalRequest,
	ApprovalStatus,
	AuditEntry,
	EvaluationResult,
	StoredAuditEntry,
	ToolCall,
} from '../core/types.ts';
import { normalizeSearchText, quoteFts5Literal } from '../utils/search.ts';
import { FTS_SCHEMA, FTS_TRIGGER_NAMES, MIGRATIONS, SCHEMA, SCHEMA_VERSION } from './schema.ts';

const VALID_DECISIONS = new Set<string>(['allow', 'block', 'approve']);
const VALID_CLASSIFICATIONS = new Set<string>(['readonly', 'destructive', 'external', 'stateful', 'unknown']);
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export interface AuditLogConnectionOptions {
	/** Time SQLite waits for a lock before returning SQLITE_BUSY. Default 5000. */
	busyTimeoutMs?: number;
}

export interface AuditLogStoreOptions extends AuditLogConnectionOptions {
	/** Opt in to persistent WAL mode during writable initialization. */
	journalMode?: 'default' | 'wal';
}

function finiteNumber(value: unknown, label: string): number {
	const number = Number(value);
	if (!Number.isFinite(number)) throw new Error(`invalid ${label}: ${String(value)}`);
	return number;
}

function enumValue<T extends string>(value: unknown, valid: Set<string>, label: string): T {
	if (typeof value !== 'string' || !valid.has(value)) throw new Error(`invalid ${label}: ${String(value)}`);
	return value as T;
}

function optionalString(value: unknown): string | undefined {
	return value === null || value === undefined ? undefined : String(value);
}

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

function rowToAuditEntry(row: Record<string, unknown>): StoredAuditEntry {
	const rawId = row.id ?? row.audit_log_id;
	if (rawId === undefined || rawId === null) throw new Error('missing id in audit log row');

	return {
		id: finiteNumber(rawId, 'audit log row id'),
		agent: String(row.agent),
		tool: String(row.tool),
		operation: optionalString(row.operation),
		command: String(row.command),
		args: safeJsonParse<string[]>(row.args_json, []),
		workingDirectory: optionalString(row.working_directory),
		workspaceId: optionalString(row.workspace_id),
		inputs: safeJsonParse<Record<string, unknown>>(row.inputs_json, {}),
		timestamp: String(row.timestamp),
		decision: enumValue(row.decision, VALID_DECISIONS, 'decision in audit log row'),
		classification: enumValue(row.classification, VALID_CLASSIFICATIONS, 'classification in audit log row'),
		matchedRule: optionalString(row.matched_rule),
		matchedRuleMode: optionalString(row.matched_rule_mode) as EvaluationResult['matchedRuleMode'],
		matchedSelectors: safeJsonParse<string[]>(row.matched_selectors_json, []),
		policyScope: optionalString(row.policy_scope) as AuditEntry['policyScope'],
		resolvedWorkspaceId: optionalString(row.resolved_workspace_id),
		reason: String(row.reason),
		sessionId: optionalString(row.session_id),
		toolUseId: optionalString(row.tool_use_id),
		policyHash: optionalString(row.policy_hash),
		policyGeneration:
			row.policy_generation === null || row.policy_generation === undefined
				? undefined
				: finiteNumber(row.policy_generation, 'policy generation'),
	};
}

function rowToAuditEntryWithApproval(row: Record<string, unknown>): StoredAuditEntry {
	return {
		...rowToAuditEntry(row),
		approvalStatus: optionalString(row.approval_status) as ApprovalStatus | undefined,
		approvalResolvedAt: optionalString(row.approval_resolved_at),
	};
}

function rowToAuditEntrySummary(row: Record<string, unknown>): AuditEntrySummary {
	return {
		id: finiteNumber(row.id, 'audit log row id'),
		agent: String(row.agent),
		tool: String(row.tool),
		operation: optionalString(row.operation),
		command: String(row.command),
		timestamp: String(row.timestamp),
		decision: enumValue(row.decision, VALID_DECISIONS, 'decision in audit log row'),
		classification: enumValue(row.classification, VALID_CLASSIFICATIONS, 'classification in audit log row'),
	};
}

function nullable<T>(value: T | undefined): T | null {
	return value === undefined ? null : value;
}

function jsonOr<T>(value: T | undefined, fallback: T): string {
	return JSON.stringify(value === undefined ? fallback : value);
}

export interface PolicyAuditProvenance {
	policyHash: string;
	policyGeneration: number;
}

function auditEntryValues(
	call: ToolCall,
	result: EvaluationResult,
	timestamp: string,
	provenance?: PolicyAuditProvenance
): Array<string | number | null> {
	return [
		call.agent,
		call.tool,
		nullable(call.operation),
		call.command,
		normalizeSearchText(call.command),
		jsonOr(call.args, []),
		nullable(call.workingDirectory),
		nullable(call.workspaceId),
		jsonOr(call.inputs, {}),
		timestamp,
		result.decision,
		result.classification,
		nullable(result.matchedRule),
		nullable(result.matchedRuleMode),
		jsonOr(result.matchedSelectors, []),
		result.policyScope === undefined ? 'global' : result.policyScope,
		nullable(result.resolvedWorkspaceId),
		result.reason,
		nullable(call.sessionId),
		nullable(call.toolUseId),
		nullable(provenance?.policyHash),
		nullable(provenance?.policyGeneration),
	];
}

function validatedBusyTimeout(value: number | undefined): number {
	const timeout = value ?? DEFAULT_BUSY_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 2_147_483_647) {
		throw new Error(`busyTimeoutMs must be an integer between 0 and 2147483647; received ${String(value)}`);
	}
	return timeout;
}

function databaseObjectExists(database: Database, type: 'table' | 'trigger', name: string): boolean {
	return database.query('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get(type, name) !== null;
}

function hasRequiredColumns(database: Database, table: string, required: readonly string[]): boolean {
	const columns = new Set(
		(database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name)
	);
	return required.every((column) => columns.has(column));
}

function validateReadableSchema(database: Database): void {
	const requiredTables = ['audit_log', 'approval_requests'] as const;
	for (const table of requiredTables) {
		if (!databaseObjectExists(database, 'table', table)) {
			throw new Error(`audit database schema version is current but required table "${table}" is missing`);
		}
	}

	const auditColumns = [
		'id',
		'agent',
		'tool',
		'operation',
		'command',
		'command_search',
		'args_json',
		'working_directory',
		'workspace_id',
		'inputs_json',
		'timestamp',
		'decision',
		'classification',
		'matched_rule',
		'matched_rule_mode',
		'matched_selectors_json',
		'policy_scope',
		'resolved_workspace_id',
		'reason',
		'session_id',
		'tool_use_id',
		'policy_hash',
		'policy_generation',
	] as const;
	if (!hasRequiredColumns(database, 'audit_log', auditColumns)) {
		throw new Error('audit database schema version is current but audit_log is missing required columns');
	}
	if (
		!hasRequiredColumns(database, 'approval_requests', ['id', 'audit_log_id', 'status', 'created_at', 'resolved_at'])
	) {
		throw new Error('audit database schema version is current but approval_requests is missing required columns');
	}
}

function hasUsableTrigramIndex(database: Database): boolean {
	if (!databaseObjectExists(database, 'table', 'audit_log_command_fts')) return false;
	if (!FTS_TRIGGER_NAMES.every((name) => databaseObjectExists(database, 'trigger', name))) return false;

	try {
		database
			.query('SELECT rowid FROM audit_log_command_fts WHERE audit_log_command_fts MATCH ? LIMIT 0')
			.all('"umbod"');
		return true;
	} catch {
		return false;
	}
}

function supportsTrigramIndex(database: Database): boolean {
	const probe = 'temp.umbod_fts5_trigram_probe';
	try {
		database.exec(`DROP TABLE IF EXISTS ${probe}`);
		database.exec(`CREATE VIRTUAL TABLE ${probe} USING fts5(value, tokenize = 'trigram')`);
		database.exec(`DROP TABLE ${probe}`);
		return true;
	} catch {
		try {
			database.exec(`DROP TABLE IF EXISTS ${probe}`);
		} catch {
			// The failed capability probe must not mask the fallback path.
		}
		return false;
	}
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		(typeof value === 'object' || typeof value === 'function') &&
		value !== null &&
		typeof (value as { then?: unknown }).then === 'function'
	);
}

function validateCursorQuery(query: CursorCallQuery): void {
	if (!Number.isSafeInteger(query.pageSize) || query.pageSize < 1 || query.pageSize > 200) {
		throw new Error(`pageSize must be an integer between 1 and 200; received ${String(query.pageSize)}`);
	}
	if (query.cursor !== undefined && (!Number.isSafeInteger(query.cursor) || query.cursor <= 0)) {
		throw new Error(`cursor must be a positive audit entry id; received ${String(query.cursor)}`);
	}
}

function cursorPage(
	rows: Array<Record<string, unknown>>,
	query: CursorCallQuery,
	projection: 'full' | 'summary'
): CursorCallPage {
	const hasMore = rows.length > query.pageSize;
	const visibleRows = hasMore ? rows.slice(0, query.pageSize) : rows;
	const entries =
		projection === 'summary' ? visibleRows.map(rowToAuditEntrySummary) : visibleRows.map(rowToAuditEntryWithApproval);
	const lastEntry = entries.at(-1);
	return {
		entries,
		pageSize: query.pageSize,
		hasMore,
		nextCursor: hasMore && lastEntry?.id !== undefined ? String(lastEntry.id) : null,
	};
}

export class AuditLogReader {
	protected readonly database: Database;
	private readonly readerInstanceId = randomUUID();
	private localMutationVersion = 0;
	private trigramSearchAvailable = false;

	protected constructor(database: Database) {
		this.database = database;
	}

	close(): void {
		this.database.close();
	}

	/**
	 * Connection-local change token. Compare successive values only while this
	 * reader remains open; it is not a durable database revision.
	 */
	dataVersion(): number {
		const row = this.database.query('PRAGMA data_version').get() as { data_version: number };
		return Number(row.data_version);
	}

	/**
	 * Opaque cache token for this open connection. Compare it only with later
	 * values from the same reader instance.
	 */
	revision(): string {
		return `${this.readerInstanceId}:${this.dataVersion()}:${this.localMutationVersion}`;
	}

	protected noteMutation(): void {
		this.localMutationVersion += 1;
	}

	protected enableTrigramSearch(): void {
		this.trigramSearchAvailable = true;
	}

	/** Run related synchronous reads against one deferred SQLite snapshot. */
	withSnapshot<T>(read: () => T): T {
		return this.database
			.transaction(() => {
				const result = read();
				if (isPromiseLike(result)) {
					throw new Error('AuditLogReader.withSnapshot requires a synchronous callback');
				}
				return result;
			})
			.deferred();
	}

	listRecent(limit?: number): StoredAuditEntry[] {
		let sql = `SELECT al.id, al.agent, al.tool, al.operation, al.command, al.args_json, al.working_directory, al.workspace_id, al.inputs_json,
                al.timestamp, al.decision, al.classification, al.matched_rule, al.matched_rule_mode, al.matched_selectors_json, al.policy_scope, al.resolved_workspace_id, al.reason,
                al.session_id, al.tool_use_id, al.policy_hash, al.policy_generation,
                ar.status AS approval_status, ar.resolved_at AS approval_resolved_at
         FROM audit_log al
         LEFT JOIN approval_requests ar ON ar.audit_log_id = al.id
         ORDER BY al.id DESC`;
		if (limit !== undefined) sql += ` LIMIT ?`;
		const rows = this.database.query(sql).all(...(limit !== undefined ? [limit] : [])) as Array<
			Record<string, unknown>
		>;

		return rows.map(rowToAuditEntryWithApproval);
	}

	listRecentFiltered(filter: AuditFilter = {}, limit = 2000, offset = 0): StoredAuditEntry[] {
		const { where, params } = this.buildFilter(filter, 'al');
		const rows = this.database
			.query(
				`SELECT al.id, al.agent, al.tool, al.operation, al.command, al.args_json, al.working_directory, al.workspace_id, al.inputs_json,
                al.timestamp, al.decision, al.classification, al.matched_rule, al.matched_rule_mode, al.matched_selectors_json, al.policy_scope, al.resolved_workspace_id, al.reason,
                al.session_id, al.tool_use_id, al.policy_hash, al.policy_generation,
                ar.status AS approval_status, ar.resolved_at AS approval_resolved_at
         FROM audit_log al
         LEFT JOIN approval_requests ar ON ar.audit_log_id = al.id
         ${where}
         ORDER BY al.id DESC
         LIMIT ? OFFSET ?`
			)
			.all(...params, limit, offset) as Array<Record<string, unknown>>;

		return rows.map(rowToAuditEntryWithApproval);
	}

	countFiltered(filter: AuditFilter = {}): number {
		const { where, params } = this.buildFilter(filter);
		const row = this.database.query(`SELECT COUNT(*) AS count FROM audit_log ${where}`).get(...params) as {
			count: number;
		};
		return row.count;
	}

	getEntry(id: number): StoredAuditEntry | undefined {
		const row = this.database
			.query(
				`SELECT al.id, al.agent, al.tool, al.operation, al.command, al.args_json, al.working_directory, al.workspace_id, al.inputs_json,
                al.timestamp, al.decision, al.classification, al.matched_rule, al.matched_rule_mode, al.matched_selectors_json, al.policy_scope, al.resolved_workspace_id, al.reason,
                al.session_id, al.tool_use_id, al.policy_hash, al.policy_generation,
                ar.status AS approval_status, ar.resolved_at AS approval_resolved_at
         FROM audit_log al
         LEFT JOIN approval_requests ar ON ar.audit_log_id = al.id
         WHERE al.id = ?`
			)
			.get(id) as Record<string, unknown> | null;
		return row === null ? undefined : rowToAuditEntryWithApproval(row);
	}

	listRecentCursor(filter: AuditFilter, query: CursorCallQuery): CursorCallPage {
		validateCursorQuery(query);
		const projection = query.projection ?? 'full';
		const rows = this.cursorRows(filter, query, projection);
		const page = cursorPage(rows, query, projection);
		if (!query.includeTotal) return page;

		const { where, params } = this.buildFilter(filter);
		const row = this.database.query(`SELECT COUNT(*) AS count FROM audit_log ${where}`).get(...params) as {
			count: number;
		};
		return {
			...page,
			total: row.count,
			totalPages: Math.max(Math.ceil(row.count / query.pageSize), 1),
		};
	}

	/** Internal analytics paging with a larger bound than the interactive call explorer. */
	listRecentBatch(
		filter: AuditFilter,
		cursor: number | undefined,
		batchSize: number
	): { entries: StoredAuditEntry[]; nextCursor: number | undefined } {
		if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 20000) {
			throw new Error(`batchSize must be an integer between 1 and 20000; received ${String(batchSize)}`);
		}
		if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor <= 0)) {
			throw new Error(`cursor must be a positive audit entry id; received ${String(cursor)}`);
		}
		const page = cursorPage(
			this.cursorRows(filter, { cursor, pageSize: batchSize }, 'full'),
			{ cursor, pageSize: batchSize },
			'full'
		);
		return {
			entries: page.entries as StoredAuditEntry[],
			nextCursor: page.nextCursor === null ? undefined : Number(page.nextCursor),
		};
	}

	private cursorRows(
		filter: AuditFilter,
		query: CursorCallQuery,
		projection: 'full' | 'summary'
	): Array<Record<string, unknown>> {
		const { where, params } = this.buildFilter(filter, 'al');
		const cursorClause = query.cursor === undefined ? where : `${where}${where ? ' AND' : ' WHERE'} al.id < ?`;
		const cursorParams = query.cursor === undefined ? params : [...params, query.cursor];
		const select =
			projection === 'summary'
				? `al.id, al.agent, al.tool, al.operation, al.command, al.timestamp, al.decision, al.classification`
				: `al.id, al.agent, al.tool, al.operation, al.command, al.args_json, al.working_directory, al.workspace_id, al.inputs_json,
             al.timestamp, al.decision, al.classification, al.matched_rule, al.matched_rule_mode, al.matched_selectors_json, al.policy_scope, al.resolved_workspace_id, al.reason,
             al.session_id, al.tool_use_id, al.policy_hash, al.policy_generation,
             ar.status AS approval_status, ar.resolved_at AS approval_resolved_at`;
		const join = projection === 'summary' ? '' : 'LEFT JOIN approval_requests ar ON ar.audit_log_id = al.id';
		return this.database
			.query(
				`SELECT ${select}
         FROM audit_log al
         ${join}
         ${cursorClause}
         ORDER BY al.id DESC
         LIMIT ?`
			)
			.all(...cursorParams, query.pageSize + 1) as Array<Record<string, unknown>>;
	}

	listRecentPage(
		filter: AuditFilter,
		page: number,
		pageSize: number
	): { entries: StoredAuditEntry[]; page: number; pageSize: number; total: number; totalPages: number } {
		const { where, params } = this.buildFilter(filter);
		const row = this.database.query(`SELECT COUNT(*) AS count FROM audit_log ${where}`).get(...params) as {
			count: number;
		};
		return {
			entries: this.listRecentFiltered(filter, pageSize, (page - 1) * pageSize),
			page,
			pageSize,
			total: row.count,
			totalPages: Math.max(Math.ceil(row.count / pageSize), 1),
		};
	}

	listPendingApprovals(limit = 50): ApprovalRequest[] {
		const rows = this.database
			.query(
				`SELECT ar.id AS approval_id, ar.audit_log_id, ar.status, ar.created_at, ar.resolved_at,
	                al.agent, al.tool, al.operation, al.command, al.args_json, al.working_directory, al.workspace_id, al.inputs_json,
	                al.timestamp, al.decision, al.classification, al.matched_rule, al.matched_rule_mode, al.matched_selectors_json, al.policy_scope, al.resolved_workspace_id, al.reason,
	                al.session_id, al.tool_use_id, al.policy_hash, al.policy_generation
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
		const comparisons: Array<[column: string, operator: string, value: string | undefined]> = [
			['timestamp', '>=', filter.since],
			['timestamp', '<=', filter.until],
			['agent', '=', filter.agent],
			['working_directory', '=', filter.project],
			['resolved_workspace_id', '=', filter.workspace],
			['tool', '=', filter.tool],
			['operation', '=', filter.operation],
			['classification', '=', filter.classification],
			['decision', '=', filter.decision],
		];
		for (const [column, operator, value] of comparisons) {
			if (value === undefined) continue;
			clauses.push(`${prefix}${column} ${operator} ?`);
			params.push(value);
		}
		const search = filter.search === undefined ? '' : normalizeSearchText(filter.search).trim();
		if (this.trigramSearchAvailable && [...search].length >= 3) {
			clauses.push(`${prefix}id IN (SELECT rowid FROM audit_log_command_fts WHERE audit_log_command_fts MATCH ?)`);
			params.push(quoteFts5Literal(search));
		} else if (search.length > 0) {
			// FTS5's trigram tokenizer cannot answer one- or two-character
			// queries. instr keeps literal substring semantics for that case.
			clauses.push(`instr(${prefix}command_search, ?) > 0`);
			params.push(search);
		}

		return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
	}

	private filteredRows(
		filter: AuditFilter,
		buildSql: (where: string) => string,
		alias = '',
		extraParams: Array<string | number> = []
	): Array<Record<string, unknown>> {
		const { where, params } = this.buildFilter(filter, alias);
		return this.database.query(buildSql(where)).all(...params, ...extraParams) as Array<Record<string, unknown>>;
	}

	usageTotals(filter: AuditFilter = {}): {
		entries: number;
		sessions: number;
		agents: string[];
		projects: string[];
		workspaces: string[];
	} {
		const { where, params } = this.buildFilter(filter);
		const row = this.database
			.query(
				`SELECT COUNT(*) AS entries,
                COUNT(DISTINCT session_id) AS sessions,
                json_group_array(DISTINCT agent) AS agents_json,
                json_group_array(DISTINCT working_directory)
                  FILTER (WHERE working_directory IS NOT NULL) AS projects_json,
                json_group_array(DISTINCT resolved_workspace_id)
                  FILTER (WHERE resolved_workspace_id IS NOT NULL) AS workspaces_json
         FROM audit_log ${where}`
			)
			.get(...params) as {
			entries: number;
			sessions: number;
			agents_json: string;
			projects_json: string;
			workspaces_json: string;
		};

		return {
			entries: row.entries,
			sessions: row.sessions,
			agents: safeJsonParse<string[]>(row.agents_json, []).sort(),
			projects: safeJsonParse<string[]>(row.projects_json, []).sort(),
			workspaces: safeJsonParse<string[]>(row.workspaces_json, []).sort(),
		};
	}

	aggregateToolUsage(filter: AuditFilter = {}): Array<Omit<ToolUsageRow, 'topCommands'>> {
		const rows = this.filteredRows(
			filter,
			(where) => `SELECT agent, tool, COUNT(*) AS count,
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
		);

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

	distinctTools(filter: AuditFilter = {}): string[] {
		const { where, params } = this.buildFilter(filter);
		const rows = this.database
			.query(`SELECT DISTINCT tool FROM audit_log ${where} ORDER BY tool`)
			.all(...params) as Array<{ tool: string }>;
		return rows.map((row) => row.tool);
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
		const rows = this.filteredRows(
			filter,
			(where) => `SELECT working_directory, classification, COUNT(*) AS count,
                SUM(CASE WHEN decision = 'allow' THEN 1 ELSE 0 END) AS allow_count,
                SUM(CASE WHEN decision = 'block' THEN 1 ELSE 0 END) AS block_count,
                SUM(CASE WHEN decision = 'approve' THEN 1 ELSE 0 END) AS approve_count
         FROM audit_log ${where}
         GROUP BY working_directory, classification
         ORDER BY count DESC`
		);

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
				`SELECT matched_rule, policy_scope, resolved_workspace_id, COUNT(*) AS count, MAX(timestamp) AS last_matched
	         FROM audit_log ${where}${where ? ' AND' : ' WHERE'} matched_rule IS NOT NULL
	         GROUP BY matched_rule, policy_scope, resolved_workspace_id`
			)
			.all(...params) as Array<{
			matched_rule: string;
			policy_scope: 'global' | 'workspace' | null;
			resolved_workspace_id: string | null;
			count: number;
			last_matched: string;
		}>;

		return rows.map((row) => ({
			matchedRule: row.matched_rule,
			policyScope: row.policy_scope ?? undefined,
			resolvedWorkspaceId: row.resolved_workspace_id ?? undefined,
			count: row.count,
			lastMatched: row.last_matched,
		}));
	}

	approvalHotspots(filter: AuditFilter = {}, sampleLimit = 3): ApprovalHotspot[] {
		const { where, params } = this.buildFilter(filter, 'al');
		const rows = this.database
			.query(
				`WITH filtered AS (
	           SELECT al.id, al.tool, al.command,
	                  CASE WHEN instr(al.command, ' ') > 0
	                       THEN substr(al.command, 1, instr(al.command, ' ') - 1)
	                       ELSE al.command END AS command_key,
	                  ar.status, ar.created_at, ar.resolved_at
	           FROM audit_log al
	           JOIN approval_requests ar ON ar.audit_log_id = al.id
	           ${where}${where ? ' AND' : ' WHERE'} al.decision = 'approve'
	         ),
	         summaries AS (
	           SELECT tool, command_key, COUNT(*) AS total,
	                  SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
	                  SUM(CASE WHEN status = 'denied' THEN 1 ELSE 0 END) AS denied,
	                  SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
	                  AVG(CASE WHEN resolved_at IS NOT NULL
	                      THEN (julianday(resolved_at) - julianday(created_at)) * 86400000.0
	                      ELSE NULL END) AS avg_resolution_ms
	           FROM filtered
	           GROUP BY tool, command_key
	         ),
	         ranked_samples AS (
	           SELECT tool, command_key, command,
	                  ROW_NUMBER() OVER (
	                    PARTITION BY tool, command_key
	                    ORDER BY MAX(id) DESC
	                  ) AS sample_rank
	           FROM filtered
	           GROUP BY tool, command_key, command
	         )
	         SELECT summaries.*, ranked_samples.command AS sample_command
	         FROM summaries
	         LEFT JOIN ranked_samples
	           ON ranked_samples.tool = summaries.tool
	          AND ranked_samples.command_key = summaries.command_key
	          AND ranked_samples.sample_rank <= ?
	         ORDER BY summaries.total DESC, summaries.tool, summaries.command_key, ranked_samples.sample_rank`
			)
			.all(...params, Math.max(0, sampleLimit)) as Array<Record<string, unknown>>;

		const hotspots = new Map<string, ApprovalHotspot>();
		for (const row of rows) {
			const tool = String(row.tool);
			const commandKey = String(row.command_key);
			const key = JSON.stringify([tool, commandKey]);
			const hotspot = hotspots.get(key) ?? {
				tool,
				commandKey,
				total: Number(row.total),
				approved: Number(row.approved),
				denied: Number(row.denied),
				pending: Number(row.pending),
				avgResolutionMs: row.avg_resolution_ms === null ? undefined : Number(row.avg_resolution_ms),
				sampleCommands: [],
			};
			if (row.sample_command !== null && row.sample_command !== undefined) {
				hotspot.sampleCommands.push(String(row.sample_command));
			}
			hotspots.set(key, hotspot);
		}

		return [...hotspots.values()];
	}

	unmatchedEntries(filter: AuditFilter = {}, limit = 2000): StoredAuditEntry[] {
		const { where, params } = this.buildFilter(filter, 'al');
		const rows = this.database
			.query(
				`SELECT al.id, al.agent, al.tool, al.operation, al.command, al.args_json, al.working_directory, al.workspace_id, al.inputs_json,
                al.timestamp, al.decision, al.classification, al.matched_rule, al.matched_rule_mode, al.matched_selectors_json, al.policy_scope, al.resolved_workspace_id, al.reason,
                al.session_id, al.tool_use_id, al.policy_hash, al.policy_generation,
                ar.status AS approval_status, ar.resolved_at AS approval_resolved_at
         FROM audit_log al
         LEFT JOIN approval_requests ar ON ar.audit_log_id = al.id
         ${where}${where ? ' AND' : ' WHERE'} al.matched_rule IS NULL
         ORDER BY al.id DESC
         LIMIT ?`
			)
			.all(...params, limit) as Array<Record<string, unknown>>;

		return rows.map(rowToAuditEntryWithApproval);
	}

	entriesForCoverage(filter: AuditFilter = {}): CoverageAuditRow[] {
		const rows = this.filteredRows(
			filter,
			(where) => `SELECT id, agent, tool, command, timestamp, session_id, tool_use_id, working_directory
         FROM audit_log ${where}
         ORDER BY timestamp`
		);

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
}

class ReadOnlyAuditLogReader extends AuditLogReader {
	constructor(databasePath: string, options: AuditLogConnectionOptions) {
		const busyTimeout = validatedBusyTimeout(options.busyTimeoutMs);
		const database = new Database(databasePath, { readonly: true });
		super(database);

		try {
			database.exec('PRAGMA query_only = ON');
			database.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
			const { user_version: userVersion } = database.query('PRAGMA user_version').get() as {
				user_version: number;
			};
			if (userVersion < SCHEMA_VERSION) {
				throw new Error(
					`audit database schema version ${userVersion} is not readable by this Umbod build (expected ${SCHEMA_VERSION}); open it with AuditLogStore to migrate`
				);
			}
			if (userVersion > SCHEMA_VERSION) {
				throw new Error(
					`audit database schema version ${userVersion} is newer than this Umbod build supports (expected ${SCHEMA_VERSION})`
				);
			}
			validateReadableSchema(database);
			if (hasUsableTrigramIndex(database)) this.enableTrigramSearch();
		} catch (error: unknown) {
			database.close();
			throw error;
		}
	}
}

/** Open an analytics-only connection without creating or migrating the database. */
export function openAuditLogReader(databasePath: string, options: AuditLogConnectionOptions = {}): AuditLogReader {
	return new ReadOnlyAuditLogReader(databasePath, options);
}

export class AuditLogStore extends AuditLogReader {
	constructor(databasePath: string, options: AuditLogStoreOptions = {}) {
		const busyTimeout = validatedBusyTimeout(options.busyTimeoutMs);
		const database = new Database(databasePath, { create: true, readwrite: true });
		super(database);

		try {
			database.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
			const userVersion = this.userVersion();
			if (userVersion > SCHEMA_VERSION) {
				throw new Error(
					`audit database schema version ${userVersion} is newer than this Umbod build supports (expected ${SCHEMA_VERSION})`
				);
			}
			if (options.journalMode === 'wal') {
				const row = database.query('PRAGMA journal_mode = WAL').get() as { journal_mode: string };
				if (row.journal_mode.toLowerCase() !== 'wal') {
					throw new Error(`failed to enable WAL journal mode; SQLite returned "${row.journal_mode}"`);
				}
			}
			const trigramSupported = supportsTrigramIndex(database);
			const searchIndexWasReady = trigramSupported && hasUsableTrigramIndex(database);
			database
				.transaction(() => {
					if (!trigramSupported) {
						for (const trigger of FTS_TRIGGER_NAMES) database.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
					}
					this.migrate(userVersion);
					this.backfillCommandSearch();
					database.exec(SCHEMA);
					if (trigramSupported) {
						database.exec(FTS_SCHEMA);
						if (userVersion < 3 || !searchIndexWasReady) {
							database.exec("INSERT INTO audit_log_command_fts(audit_log_command_fts) VALUES ('rebuild')");
						}
						if (!hasUsableTrigramIndex(database)) {
							throw new Error('failed to initialize the optional FTS5 trigram search index');
						}
					}
					database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
					validateReadableSchema(database);
				})
				.immediate();
			if (trigramSupported) this.enableTrigramSearch();
		} catch (error: unknown) {
			database.close();
			throw error;
		}
	}

	private tableExists(name: string): boolean {
		return this.database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
	}

	private userVersion(): number {
		const row = this.database.query('PRAGMA user_version').get() as { user_version: number };
		return Number(row.user_version);
	}

	// Bring a pre-existing audit_log up to the current shape before SCHEMA
	// runs, since SCHEMA's indexes and triggers assume the new columns exist.
	private migrate(userVersion: number): void {
		if (!this.tableExists('audit_log') || userVersion >= SCHEMA_VERSION) {
			return;
		}

		const columns = new Set(
			(this.database.query('PRAGMA table_info(audit_log)').all() as Array<{ name: string }>).map((row) => row.name)
		);

		for (let version = userVersion + 1; version <= SCHEMA_VERSION; version += 1) {
			for (const statement of MIGRATIONS[version] ?? []) {
				if (statement.addsColumn && columns.has(statement.addsColumn)) {
					continue;
				}
				this.database.exec(statement.sql);
				if (statement.addsColumn) columns.add(statement.addsColumn);
			}
		}
	}

	private backfillCommandSearch(): void {
		if (!this.tableExists('audit_log')) return;
		const columns = new Set(
			(this.database.query('PRAGMA table_info(audit_log)').all() as Array<{ name: string }>).map((row) => row.name)
		);
		if (!columns.has('command_search')) return;

		const rows = this.database.query('SELECT id, command FROM audit_log WHERE command_search IS NULL').all() as Array<{
			id: number;
			command: string;
		}>;
		if (rows.length === 0) return;
		const update = this.database.query('UPDATE audit_log SET command_search = ? WHERE id = ?');
		for (const row of rows) update.run(normalizeSearchText(row.command), row.id);
	}

	append(
		call: ToolCall,
		result: EvaluationResult,
		provenance?: PolicyAuditProvenance
	): { entryId: number; approvalRequestId?: number } {
		const timestamp = call.timestamp ?? new Date().toISOString();
		const insertEntry = this.database.query(
			`INSERT INTO audit_log (
        agent, tool, operation, command, command_search, args_json, working_directory, workspace_id, inputs_json, timestamp,
        decision, classification, matched_rule, matched_rule_mode, matched_selectors_json, policy_scope, resolved_workspace_id, reason, session_id, tool_use_id,
        policy_hash, policy_generation
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
		);
		const insertApproval = this.database.query(
			'INSERT INTO approval_requests (audit_log_id, created_at) VALUES (?, ?) RETURNING id'
		);

		const appended = this.database.transaction(() => {
			const row = insertEntry.get(...auditEntryValues(call, result, timestamp, provenance)) as { id: number };
			let approvalRequestId: number | undefined;

			if (result.decision === 'approve') {
				const approvalRow = insertApproval.get(row.id, timestamp) as { id: number };
				approvalRequestId = approvalRow.id;
			}

			return { entryId: row.id, approvalRequestId };
		})();
		this.noteMutation();
		return appended;
	}

	resolveApprovalRequest(
		id: number,
		status: Exclude<ApprovalStatus, 'pending'>,
		resolvedAt = new Date().toISOString()
	): boolean {
		const result = this.database
			.query(
				`UPDATE approval_requests
         SET status = ?, resolved_at = ?
         WHERE id = ? AND status = 'pending'`
			)
			.run(status, resolvedAt, id);

		const changed = result.changes > 0;
		if (changed) this.noteMutation();
		return changed;
	}
}
