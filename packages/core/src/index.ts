export * from './core/types.ts';

export { createUmbod } from './server/api.ts';
export type {
	ActivityEntry,
	ApprovalPrompt,
	AuthorizationResult,
	AuthorizeOptions,
	Umbod,
	UmbodOptions,
} from './server/api.ts';

export { AuditLogReader, AuditLogStore, openAuditLogReader } from './db/audit-log.ts';
export type { AuditLogConnectionOptions, AuditLogStoreOptions } from './db/audit-log.ts';
export { PolicyEngine } from './policy/engine.ts';
export {
	isAbsoluteWorkspaceRoot,
	isPathWithinWorkspaceRoot,
	normalizeWorkspaceRoot,
	resolveWorkspace,
} from './policy/workspace.ts';
export type { WorkspaceResolution, WorkspaceResolutionSource } from './policy/workspace.ts';
export { classifyToolCall } from './policy/classifier.ts';
export { analyzeShellCommand } from './policy/shell-analyzer.ts';
export type { ShellOperationAnalysis } from './policy/shell-analyzer.ts';
export { runManifestTests } from './policy/manifest-tests.ts';
export type { ManifestTestReport, ManifestTestResult } from './policy/manifest-tests.ts';
export { createDefaultManifestSource, loadManifest, parseManifestSource } from './config/manifest.ts';
export type { DefaultManifestOptions } from './config/manifest.ts';
export { PolicyManager } from './policy/policy-manager.ts';
export type { PolicyEvaluation, PolicyReloadStatus, PolicyStatus } from './policy/policy-manager.ts';
export { runConfigureCommand } from './configure.ts';
export { adapters, findAdapterById, selectAdapters } from './adapters/index.ts';
export type { HookAdapter, HookInstallOptions, HookInstallResult } from './adapters/base.ts';
export { toPermissionDecision } from './hooks/adapter-utils.ts';
export type { PermissionDecision } from './hooks/adapter-utils.ts';
export { parseEvaluatePayload, resolveAgentId } from './server/parse.ts';
export { defaultDatabasePath, resolveEnvPath } from './utils/paths.ts';
export { resolveTimeParam } from './utils/duration.ts';
export { errorMessage } from './utils/errors.ts';
export { logger } from './utils/logger.ts';
export { computeToolUsage } from './analytics/tool-usage.ts';
export { analyzeRules } from './analytics/rule-analysis.ts';
export { simulatePolicy } from './analytics/policy-simulation.ts';
export type {
	DecisionTransition,
	PolicySimulation,
	PolicySimulationExample,
	PolicySimulationOptions,
	SimulatedRuleFinding,
} from './analytics/policy-simulation.ts';
export { suggestRules } from './analytics/suggestions.ts';
export { computeAnalyticsSnapshot } from './analytics/snapshot.ts';
export { createAnalyticsReader } from './analytics/reader.ts';
export type { AnalyticsReader, AnalyticsReaderOptions } from './analytics/reader.ts';
export { computeCoverage, scopeCoverageSources } from './analytics/coverage.ts';
export { readSessionToolCalls } from './sessions/index.ts';
export type {
	AnalyticsWindow,
	AnalyticsSnapshot,
	AnalyticsSnapshotQuery,
	AuditFilter,
	AuditEntrySummary,
	CursorCallPage,
	CursorCallQuery,
	ToolUsageQuery,
	ToolUsageStats,
	RuleAnalysis,
	RuleFinding,
	RuleSuggestion,
	CoverageQuery,
	CoverageReport,
	CoverageBreakdown,
} from './analytics/types.ts';
export type { SessionAgent, SessionLogSource, SessionToolCall } from './sessions/types.ts';
