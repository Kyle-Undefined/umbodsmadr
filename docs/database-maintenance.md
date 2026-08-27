# Audit database maintenance

Umbod owns its SQLite schema, so it also owns cleaning it up. Hlið or another consumer can ask for status, preview, receipt-bound cleanup, or compaction through the supported interfaces. It should never poke at the database, WAL, or SHM files directly. That is how a tidy-up command turns into a very bad afternoon.

Nothing runs automatically at startup. The `[audit]` values are just command defaults:

```toml
[audit]
retention_days = 90
compact_after_cleanup = false
```

Manifest retention runs from 7 through 36,500 days. An explicit core/API policy accepts 1 through 36,500 days. Pending approvals are always preserved, full stop. `preservePendingApprovals` can only be omitted or set to `true`.

## CLI workflow

Status and preview are read-only. If you use `--database` directly, there is no manifest to pull defaults from, so pass `--older-than-days` yourself.

```bash
umbod database status --env ./umbod.toml --older-than-days 90 --json
umbod database cleanup --env ./umbod.toml --older-than-days 90 --dry-run --json
```

The preview gives you an opaque `previewReceipt`. Use that exact receipt for execution:

```bash
umbod database cleanup \
  --env ./umbod.toml \
  --preview-receipt 'umbod-cleanup-v1.…' \
  --execute \
  --json
```

JSON and non-interactive execution require `--execute`, so Umbod will not surprise a script with a prompt. Interactive execution also asks you to type the operation name. Add `--compact-after-cleanup` only when that same authorized run should compact after cleanup.

Compaction can also run separately:

```bash
umbod database compact --env ./umbod.toml --execute --json
```

## HTTP workflow

```bash
curl -sS 'http://127.0.0.1:9090/api/database/status?olderThanDays=90'

curl -sS -X POST 'http://127.0.0.1:9090/api/database/cleanup/preview' \
  -H 'content-type: application/json' \
  --data '{"olderThanDays":90,"preservePendingApprovals":true}'

curl -sS -X POST 'http://127.0.0.1:9090/api/database/cleanup' \
  -H 'content-type: application/json' \
  --data '{"previewReceipt":"umbod-cleanup-v1.…","execute":true}'

curl -sS -X POST 'http://127.0.0.1:9090/api/database/compact' \
  -H 'content-type: application/json' \
  --data '{"execute":true}'
```

Mutation routes reject a browser request whose `Origin` differs from the Umbod server origin. That is a CSRF check, not authentication. The deployment or embedding host still needs to authenticate callers and keep its own approval boundary around destructive operations.

## Embedded TypeScript

The writable owner gets the same operations in process:

```ts
import { AuditLogStore, type AuditCleanupPreview } from '@umbod/core';

const store = new AuditLogStore('umbod.dev.db', { journalMode: 'wal' });
try {
	const status = store.databaseStatus({ olderThanDays: 90 });
	const preview: AuditCleanupPreview = store.previewCleanup({ olderThanDays: 90 });

	// Execute only after the host has authorized this exact preview.
	const cleanup = store.executeCleanup({
		previewReceipt: preview.previewReceipt,
		execute: true,
	});
} finally {
	store.close();
}
```

The exported contract is typed with `DatabaseMaintenanceStatus`, `AuditCleanupPreview`, `AuditCleanupExecution`, `DatabaseCompactionResult`, `DatabaseFileSizes`, `AuditRetentionPolicy`, `ExecuteAuditCleanupOptions`, and `CompactAuditDatabaseOptions`.

## Receipt and concurrency semantics

The receipt binds the resolved cutoff, eligible-row fingerprint, and durable maintenance revision. A new audit row, an approval resolution, or another maintenance run makes it stale. Execution takes the owning write lock, checks the receipt again inside an immediate transaction, and fails without partially deleting anything.

Cleanup never deletes an audit row tied to a pending approval. Approved and denied rows follow the existing foreign-key cascade when their audit rows go away. Before committing, Umbod checks foreign keys and FTS consistency. Maintenance provenance lives outside the tool-call audit stream, otherwise maintenance would grow the thing it is trying to clean up. Come on now.

## File sizes, WAL, and compaction

The reported main, WAL, and SHM sizes are exact filesystem observations at that moment. `estimatedReusableBytes` is only SQLite page size multiplied by freelist pages. It is useful, but it is not a promise about what `VACUUM` will reclaim.

Logical cleanup does not shrink the main file. That is SQLite doing SQLite things. Explicit compaction checkpoints WAL through the owner connection, refuses active readers or writers, checks temporary free-space requirements, and runs `VACUUM`. Umbod does not change `auto_vacuum` on an existing database. The result includes exact before/after sizes and checkpoint details.

## Scheduler contract

A Hlið Routine, cron job, or other scheduler should:

1. Request status and decide whether policy calls for a preview.
2. Request a cleanup preview.
3. Present the exact counts, cutoff, samples, and receipt at its approval boundary.
4. Execute with that receipt only after authorization.
5. Optionally request compaction as a separately visible destructive action.

The scheduler owns timing and user authorization. Umbod owns the database rules: retention validation, serialization, receipts, deletion behavior, checkpointing, and compaction. Keeping that line clean makes the integration a whole lot easier to trust.
