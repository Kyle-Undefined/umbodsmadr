import type { ApprovalStatus } from '../core/types.ts';

export interface DatabaseFileSizes {
	/** Exact size reported by the filesystem, in bytes. */
	mainBytes: number;
	/** Exact size reported by the filesystem, or zero when no WAL file exists. */
	walBytes: number;
	/** Exact size reported by the filesystem, or zero when no SHM file exists. */
	shmBytes: number;
}

export type DatabaseMaintenanceState = 'idle' | 'cleanup' | 'compaction';

export interface DatabaseMaintenanceStatus {
	databasePath: string;
	files: DatabaseFileSizes;
	auditRows: number;
	oldestAuditTimestamp: string | null;
	newestAuditTimestamp: string | null;
	approvals: Record<ApprovalStatus, number>;
	proposedCutoff: string | null;
	eligibleAuditRows: number | null;
	journalMode: string;
	maintenanceState: DatabaseMaintenanceState;
	maintenanceRevision: number;
	lastMaintenanceAt: string | null;
	pageSizeBytes: number;
	freeListPages: number;
	/** Page-count estimate only; it is not an exact prediction of bytes VACUUM will reclaim. */
	estimatedReusableBytes: number;
	compactionRecommended: boolean;
	compactionReason: string;
}

export interface AuditRetentionPolicy {
	olderThanDays: number;
	/** Must be true. Pending approval preservation cannot be disabled. */
	preservePendingApprovals?: true;
}

export interface MaintenanceAuditSample {
	id: number;
	agent: string;
	tool: string;
	command: string;
	timestamp: string;
	decision: string;
	classification: string;
	approvalStatus?: ApprovalStatus;
}

export interface AuditCleanupPreview {
	readOnly: true;
	policy: Required<AuditRetentionPolicy>;
	cutoff: string;
	previewedAt: string;
	previewReceipt: string;
	eligibleAuditRows: number;
	retainedAuditRows: number;
	approvalRowsAffected: Record<ApprovalStatus, number>;
	pendingApprovalRowsPreserved: number;
	oldestAffectedTimestamp: string | null;
	newestAffectedTimestamp: string | null;
	samples: MaintenanceAuditSample[];
	samplesTruncated: boolean;
	estimated: false;
	files: DatabaseFileSizes;
	maintenanceRevision: number;
}

export interface AuditCleanupExecution {
	destructive: true;
	cutoff: string;
	startedAt: string;
	completedAt: string;
	deletedAuditRows: number;
	retainedAuditRows: number;
	deletedApprovalRows: Record<'approved' | 'denied', number>;
	preservedPendingApprovals: number;
	maintenanceRevision: number;
	provenanceId: number;
	filesAfterCleanup: DatabaseFileSizes;
	compactionPerformed: false;
	message: string;
}

export interface DatabaseCompactionResult {
	destructive: true;
	startedAt: string;
	completedAt: string;
	journalMode: string;
	checkpoint: { busy: number; logFrames: number; checkpointedFrames: number };
	filesBefore: DatabaseFileSizes;
	filesAfter: DatabaseFileSizes;
	availableBytesBefore: number;
	requiredBytes: number;
	maintenanceRevision: number;
	provenanceId: number;
	message: string;
}

export interface ExecuteAuditCleanupOptions {
	previewReceipt: string;
	/** Optional redundant assertion; when supplied it must match the receipt. */
	olderThanDays?: number;
	execute: true;
}

export interface CompactAuditDatabaseOptions {
	execute: true;
}
