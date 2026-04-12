export const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  tool TEXT NOT NULL,
  command TEXT NOT NULL,
  args_json TEXT,
  working_directory TEXT,
  inputs_json TEXT,
  timestamp TEXT NOT NULL,
  decision TEXT NOT NULL,
  classification TEXT NOT NULL,
  matched_rule TEXT,
  reason TEXT NOT NULL
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
`;
