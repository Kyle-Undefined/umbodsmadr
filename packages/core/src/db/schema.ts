export const SCHEMA_VERSION = 2;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  tool TEXT NOT NULL,
  command TEXT NOT NULL,
	  args_json TEXT,
	  working_directory TEXT,
	  workspace_id TEXT,
	  inputs_json TEXT,
  timestamp TEXT NOT NULL,
  decision TEXT NOT NULL,
  classification TEXT NOT NULL,
	  matched_rule TEXT,
	  policy_scope TEXT,
	  resolved_workspace_id TEXT,
	  reason TEXT NOT NULL,
  session_id TEXT,
  tool_use_id TEXT
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_log_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY(audit_log_id) REFERENCES audit_log(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS approval_requests_audit_log_id_idx
  ON approval_requests(audit_log_id);

CREATE INDEX IF NOT EXISTS approval_requests_status_idx
  ON approval_requests(status);

CREATE INDEX IF NOT EXISTS audit_log_session_id_idx
  ON audit_log(session_id);

CREATE INDEX IF NOT EXISTS audit_log_timestamp_idx
  ON audit_log(timestamp);

CREATE INDEX IF NOT EXISTS audit_log_matched_rule_idx
  ON audit_log(matched_rule);

CREATE INDEX IF NOT EXISTS audit_log_workspace_timestamp_idx
  ON audit_log(resolved_workspace_id, timestamp);

CREATE INDEX IF NOT EXISTS audit_log_approval_hotspot_idx
  ON audit_log(
    decision,
    tool,
    CASE WHEN instr(command, ' ') > 0
         THEN substr(command, 1, instr(command, ' ') - 1)
         ELSE command END,
    id DESC
  );
`;

interface MigrationStatement {
	sql: string;
	/** Skip this statement when the column already exists on audit_log. */
	addsColumn?: string;
}

export const MIGRATIONS: Record<number, MigrationStatement[]> = {
	1: [
		{ sql: 'ALTER TABLE audit_log ADD COLUMN session_id TEXT', addsColumn: 'session_id' },
		{ sql: 'ALTER TABLE audit_log ADD COLUMN tool_use_id TEXT', addsColumn: 'tool_use_id' },
		{
			sql: `UPDATE audit_log SET session_id = json_extract(inputs_json, '$.session_id')
        WHERE session_id IS NULL AND json_extract(inputs_json, '$.session_id') IS NOT NULL`,
		},
		{
			sql: `UPDATE audit_log SET tool_use_id = json_extract(inputs_json, '$.tool_use_id')
        WHERE tool_use_id IS NULL AND json_extract(inputs_json, '$.tool_use_id') IS NOT NULL`,
		},
	],
	2: [
		{ sql: 'ALTER TABLE audit_log ADD COLUMN workspace_id TEXT', addsColumn: 'workspace_id' },
		{ sql: 'ALTER TABLE audit_log ADD COLUMN policy_scope TEXT', addsColumn: 'policy_scope' },
		{
			sql: 'ALTER TABLE audit_log ADD COLUMN resolved_workspace_id TEXT',
			addsColumn: 'resolved_workspace_id',
		},
		{ sql: `UPDATE audit_log SET policy_scope = 'global' WHERE policy_scope IS NULL` },
	],
};
