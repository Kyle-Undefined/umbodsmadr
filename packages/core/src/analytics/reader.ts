import type { Manifest, StoredAuditEntry } from '../core/types.ts';
import { openAuditLogReader, type AuditLogConnectionOptions, type AuditLogReader } from '../db/audit-log.ts';
import { computeAnalyticsSnapshot } from './snapshot.ts';
import type {
	AnalyticsSnapshot,
	AnalyticsSnapshotQuery,
	AuditFilter,
	CursorCallPage,
	CursorCallQuery,
} from './types.ts';

export interface AnalyticsReaderOptions extends AuditLogConnectionOptions {
	dbPath: string;
	manifest: Manifest;
}

/** Owned, migration-free analytics connection for host applications. */
export interface AnalyticsReader {
	snapshot(query?: AnalyticsSnapshotQuery): AnalyticsSnapshot;
	listCalls(filter: AuditFilter, query: CursorCallQuery): CursorCallPage;
	getCall(id: number): StoredAuditEntry | undefined;
	/**
	 * Opaque cache token. Compare only successive values from this reader
	 * instance; reopening starts a new token lifetime.
	 */
	revision(): string;
	close(): void;
}

class DefaultAnalyticsReader implements AnalyticsReader {
	private readonly auditLog: AuditLogReader;
	private readonly manifest: Manifest;

	constructor(options: AnalyticsReaderOptions) {
		this.auditLog = openAuditLogReader(options.dbPath, { busyTimeoutMs: options.busyTimeoutMs });
		this.manifest = options.manifest;
	}

	snapshot(query: AnalyticsSnapshotQuery = {}): AnalyticsSnapshot {
		return computeAnalyticsSnapshot(this.auditLog, this.manifest, query);
	}

	listCalls(filter: AuditFilter, query: CursorCallQuery): CursorCallPage {
		return this.auditLog.listRecentCursor(filter, query);
	}

	getCall(id: number): StoredAuditEntry | undefined {
		return this.auditLog.getEntry(id);
	}

	revision(): string {
		return this.auditLog.revision();
	}

	close(): void {
		this.auditLog.close();
	}
}

export function createAnalyticsReader(options: AnalyticsReaderOptions): AnalyticsReader {
	return new DefaultAnalyticsReader(options);
}
