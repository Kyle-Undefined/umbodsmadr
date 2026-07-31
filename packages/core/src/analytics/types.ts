import type { ApprovalDecision, CallClassification, StoredAuditEntry } from '../core/types.ts';

export interface AnalyticsWindow {
	since?: string;
	until?: string;
}

export interface AuditFilter extends AnalyticsWindow {
	agent?: string;
	/** Exact working_directory match. */
	project?: string;
	/** Exact resolved workspace id match. */
	workspace?: string;
	tool?: string;
	classification?: CallClassification;
	decision?: ApprovalDecision;
	/** Case-insensitive command substring. */
	search?: string;
}

export interface AuditEntrySummary {
	id: number;
	agent: string;
	tool: string;
	command: string;
	timestamp: string;
	decision: ApprovalDecision;
	classification: CallClassification;
}

export interface CursorCallPage {
	entries: Array<StoredAuditEntry | AuditEntrySummary>;
	pageSize: number;
	hasMore: boolean;
	nextCursor: string | null;
	/** Complete filtered count, included only when requested. */
	total?: number;
	totalPages?: number;
}

export interface CursorCallQuery {
	/** Last id from the preceding page. Omit for the first page. */
	cursor?: number;
	pageSize: number;
	includeTotal?: boolean;
	projection?: 'full' | 'summary';
}

export type DecisionCounts = Record<ApprovalDecision, number>;

export interface ToolUsageQuery extends AuditFilter {
	/** Summary skips top-command, task-type, and unused-tool detail. Default full. */
	projection?: 'full' | 'summary';
	/** Window (days) used for "unused recently" detection. Default 14. */
	recentWindowDays?: number;
	/** Top commands listed per tool. Default 5. */
	topCommandsPerTool?: number;
}

export interface ToolUsageRow {
	agent: string;
	tool: string;
	count: number;
	decisions: DecisionCounts;
	classifications: Partial<Record<CallClassification, number>>;
	firstSeen: string;
	lastSeen: string;
	topCommands: Array<{ command: string; count: number }>;
}

export interface TaskTypeRow {
	workingDirectory: string | null;
	classification: CallClassification;
	count: number;
	decisions: DecisionCounts;
}

export interface UnusedTool {
	tool: string;
	/** Where we learned about the tool: past audit history, a rule referencing it, or an adapter's supported list. */
	source: 'history' | 'rules' | 'adapter';
	lastSeen?: string;
	referencedByRules?: string[];
}

export interface ToolUsageStats {
	projection: 'full' | 'summary';
	window: AnalyticsWindow;
	totals: {
		entries: number;
		sessions: number;
		agents: string[];
		projects: string[];
		workspaces: string[];
	};
	byTool: ToolUsageRow[];
	byTaskType: TaskTypeRow[];
	unusedTools: UnusedTool[];
}

export interface AnalyticsSnapshotQuery extends AnalyticsWindow {
	agent?: string;
	/** Exact working_directory match. */
	project?: string;
	/** Exact resolved workspace id match. */
	workspace?: string;
	/** Summary keeps consumer-facing totals and rule health while skipping drill-down data. */
	projection?: 'full' | 'summary';
	recentWindowDays?: number;
	topCommandsPerTool?: number;
	minOccurrences?: number;
	replayLimit?: number;
}

export interface AnalyticsSnapshot {
	tools: ToolUsageStats;
	rules: RuleAnalysis;
	/**
	 * Opaque cache token for this open audit reader. Omitted if the database
	 * changed while the snapshot was computed.
	 */
	revision?: string;
}

export interface MatchedRuleCount {
	matchedRule: string;
	policyScope?: 'global' | 'workspace';
	resolvedWorkspaceId?: string;
	count: number;
	lastMatched: string;
}

export interface ApprovalHotspot {
	tool: string;
	commandKey: string;
	total: number;
	approved: number;
	denied: number;
	pending: number;
	avgResolutionMs?: number;
	sampleCommands: string[];
}

export type RuleStatus = 'active' | 'stale' | 'dead' | 'shadowed' | 'invalid';

export interface RuleFinding {
	pattern: string;
	decision: ApprovalDecision;
	/** Present when the finding belongs to a workspace rule table. */
	workspaceId?: string;
	matchCount: number;
	matchCountAllTime: number;
	lastMatched?: string;
	status: RuleStatus;
	shadowedBy?: string;
	note?: string;
}

export type SuggestionKind = 'promote-approved' | 'block-denied' | 'remove-dead' | 'fix-invalid' | 'reorder-shadowed';

export interface RuleSuggestion {
	pattern: string;
	decision: ApprovalDecision;
	/** Target workspace rule table; omitted for global suggestions. */
	workspaceId?: string;
	kind: SuggestionKind;
	rationale: string;
	evidence: {
		occurrences: number;
		approvedCount: number;
		deniedCount: number;
		distinctCommands: number;
		sampleCommands: string[];
	};
	/** Earlier rules that would preempt this pattern, or historical decisions it would flip. */
	conflicts: string[];
	/** Replay-backed projection for additive suggestions. */
	impact?: {
		matchingCalls: number;
		explicitlyCoveredBefore: number;
		coverageGained: number;
		before: DecisionCounts;
		after: DecisionCounts;
		decisionChanges: number;
		/** Commands currently falling through without an explicit rule, bounded for transport/UI. */
		gaps: Array<{ id: number; command: string; decision: ApprovalDecision; classification: CallClassification }>;
		gapCount: number;
	};
}

/** Slim audit row used for session-log cross-referencing. */
export interface CoverageAuditRow {
	id: number;
	agent: string;
	tool: string;
	command: string;
	timestamp: string;
	sessionId?: string;
	toolUseId?: string;
	workingDirectory?: string;
}

export interface CoverageQuery extends AuditFilter {
	/** Maximum timestamp delta for transcript calls without session identity. Default 15 seconds. */
	heuristicWindowMs?: number;
	/** Number of unmatched transcript calls retained in the report. Default 200. */
	gapLimit?: number;
}

export interface CoverageBreakdown {
	key: string;
	sessionCalls: number;
	matched: number;
	coverageRatio: number;
}

export interface CoverageReport {
	window: AnalyticsWindow;
	totals: {
		sessionCalls: number;
		auditEntries: number;
		matched: number;
		gaps: number;
		orphans: number;
	};
	coverageRatio: number;
	byAgent: CoverageBreakdown[];
	byTool: CoverageBreakdown[];
	/** A bounded sample; gapCount in totals has the complete count. */
	gaps: import('../sessions/types.ts').SessionToolCall[];
	/** Audit ids not associated with a streamed transcript call. */
	orphanAuditIds: number[];
	notes: string[];
}

export interface RuleAnalysis {
	projection: 'full' | 'summary';
	window: AnalyticsWindow;
	workspaceId?: string;
	rules: RuleFinding[];
	approvalHotspots: ApprovalHotspot[];
	suggestions: RuleSuggestion[];
	tomlSnippet: string;
}
