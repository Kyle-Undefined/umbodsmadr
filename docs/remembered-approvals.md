# Remembered approvals

Embedding hosts can return `{ decision: 'allow', persist: 'always' }` from their approval callback. Umbod atomically saves the grant and resolves the pending approval in its shared SQLite database. A failed save denies the request and returns `userFeedback` explaining the failure.

Grants are shared by providers and sessions using the same database. They require an absolute working directory and a resolved workspace. Configured workspace roots share timing-tool grants across Windows and WSL aliases. Other grants retain their working directory and exact command/input. `clock.sleep` and `clock.curr_time` grant the timing tool across duration changes, including native Codex and MCP naming variants.

Policy is evaluated first. Explicit blocks always win; a grant only substitutes for a policy decision that requires approval. Removing a grant makes matching calls follow policy again.

Use `umbod.auditLog.listRememberedApprovals()` to inspect grants and their saved command, and `umbod.auditLog.forgetApproval(grantKey)` to revoke one. These methods require host authorization; the shared store does not add a provider-specific permission boundary. Revocation affects subsequent authorization checks and does not cancel calls already authorized.

Schema 10 retains saved commands independently of audit-history cleanup. Existing grants recover commands only from a unique approved audit record matching their timestamp, tool and working directory. If that record is unavailable or ambiguous, `command` is null. Old Claude settings grants are not imported. Standalone processes opening the same database must upgrade their core; HTTP hook clients use the host's core and do not need regenerated wrappers for this change.
