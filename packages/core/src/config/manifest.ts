import { DEFAULT_HOST, DEFAULT_PORT } from '../core/types.ts';
import type {
	ApprovalDecision,
	CallClassification,
	Manifest,
	ManifestPolicyTest,
	PolicyConfig,
	PolicyGuard,
	ServerConfig,
	StructuredRule,
	WorkspaceConfig,
} from '../core/types.ts';
import { isAbsoluteWorkspaceRoot, normalizeWorkspaceRoot } from '../policy/workspace.ts';
import { isCanonicalOperation } from '../policy/operations.ts';
import { isRecord } from '../utils/guards.ts';
import { errorMessage } from '../utils/errors.ts';

export interface DefaultManifestOptions {
	name?: string;
	version?: string;
	timeout?: number;
	defaultUnknown?: ApprovalDecision;
	approvalMethod?: PolicyConfig['approval_method'];
}

/** Render Umbod's supported starter manifest for hosts and the CLI. */
export function createDefaultManifestSource(options: DefaultManifestOptions = {}): string {
	const name = options.name ?? 'dev';
	const version = options.version ?? '1.0.0';
	const timeout = options.timeout ?? 30;
	const defaultUnknown = options.defaultUnknown ?? 'block';
	const approvalMethod = options.approvalMethod ?? 'web';

	if (!Number.isFinite(timeout) || timeout < 0) {
		throw new Error('default manifest timeout must be a non-negative number');
	}

	return `[env]
name = ${JSON.stringify(name)}
version = ${JSON.stringify(version)}
timeout = ${timeout}

[policy]
default_unknown = ${JSON.stringify(defaultUnknown)}
approval_method = ${JSON.stringify(approvalMethod)}

[rules]
"git log *" = "allow"
"ls *" = "allow"
"rm *" = "approve"
"git push *" = "approve"
"* --force" = "approve"
'/(^|\\/)\\.[^\\s\\/]+/' = "block"
`;
}

function isDecision(value: unknown): value is ApprovalDecision {
	return value === 'allow' || value === 'block' || value === 'approve';
}

function normalizePolicyFallback(
	raw: unknown,
	defaults: Partial<Record<CallClassification, ApprovalDecision>> | undefined
): ApprovalDecision {
	if (raw !== undefined && !isDecision(raw)) {
		throw new Error('manifest policy.default_unknown must be allow, block, or approve when provided');
	}
	if (raw === undefined && defaults?.unknown === undefined) {
		throw new Error('manifest policy.default_unknown or policy.defaults.unknown is required');
	}
	return raw ?? (defaults?.unknown as ApprovalDecision);
}

function normalizeApprovalMethod(raw: unknown): PolicyConfig['approval_method'] {
	if (raw !== 'web' && raw !== 'cli' && raw !== 'both') {
		throw new Error('manifest policy.approval_method must be web, cli, or both');
	}
	return raw;
}

function normalizePolicy(raw: Record<string, unknown> | undefined): PolicyConfig {
	const defaults = normalizeClassificationDefaults(raw?.defaults, 'policy.defaults');
	return {
		default_unknown: normalizePolicyFallback(raw?.default_unknown, defaults),
		approval_method: normalizeApprovalMethod(raw?.approval_method),
		...(defaults ? { defaults } : {}),
	};
}

function normalizeClassificationDefaults(
	raw: unknown,
	field: string
): Partial<Record<CallClassification, ApprovalDecision>> | undefined {
	if (raw === undefined) return undefined;
	if (!isRecord(raw)) throw new Error(`manifest ${field} must be a table`);
	const defaults: Partial<Record<CallClassification, ApprovalDecision>> = {};
	for (const [classification, decision] of Object.entries(raw)) {
		if (!CLASSIFICATIONS.has(classification as CallClassification)) {
			throw new Error(`manifest ${field} contains unknown classification "${classification}"`);
		}
		if (!isDecision(decision)) throw new Error(`manifest ${field}.${classification} must be allow, block, or approve`);
		defaults[classification as CallClassification] = decision;
	}
	return defaults;
}

function normalizeServer(raw: Record<string, unknown> | undefined): ServerConfig {
	const host = raw?.host;
	const port = raw?.port;

	return {
		host: typeof host === 'string' ? host : DEFAULT_HOST,
		port: typeof port === 'number' ? port : DEFAULT_PORT,
	};
}

function normalizeRules(raw: Record<string, unknown> | undefined): Manifest['rules'] {
	const normalized: Manifest['rules'] = {};

	if (!raw) {
		return normalized;
	}

	for (const [pattern, decision] of Object.entries(raw)) {
		if (!isDecision(decision)) {
			if (decision && typeof decision === 'object' && !Array.isArray(decision)) {
				throw new Error(
					`manifest rules.${pattern} must be allow, block, or approve; nested rule tables are not supported`
				);
			}

			throw new Error(`manifest rules.${pattern} must be allow, block, or approve`);
		}

		normalized[pattern] = decision;
	}

	return normalized;
}

const CLASSIFICATIONS = new Set<CallClassification>(['readonly', 'destructive', 'external', 'stateful', 'unknown']);
const REGEX_PATTERN_RE = /^\/(.+)\/([gimsuy]*)$/;

function normalizeStringList(value: unknown, field: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || !item.trim())) {
		throw new Error(`manifest ${field} must be a non-empty string array`);
	}
	return value.map((item) => (item as string).trim());
}

function validateMatcherPatterns(patterns: string[] | undefined, field: string): void {
	for (const pattern of patterns ?? []) {
		const match = REGEX_PATTERN_RE.exec(pattern);
		if (!match) continue;
		try {
			new RegExp(match[1], match[2]);
		} catch (error) {
			throw new Error(`manifest ${field} contains an invalid regex: ${errorMessage(error)}`);
		}
	}
}

function normalizeStructuredEntries(raw: unknown, scope: string, guard: false): StructuredRule[];
function normalizeStructuredEntries(raw: unknown, scope: string, guard: true): PolicyGuard[];
function normalizeStructuredEntries(raw: unknown, scope: string, guard: boolean): Array<StructuredRule | PolicyGuard> {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) throw new Error(`manifest ${scope} must be an array of tables`);
	const ids = new Set<string>();
	// fallow-ignore-next-line complexity -- one schema boundary validates every selector field together.
	return raw.map((value, index) => {
		if (!isRecord(value)) throw new Error(`manifest ${scope}[${index}] must be a table`);
		const id = typeof value.id === 'string' ? value.id.trim() : '';
		if (!id) throw new Error(`manifest ${scope}[${index}].id must be a non-empty string`);
		if (ids.has(id)) throw new Error(`manifest ${scope} id "${id}" is duplicated`);
		ids.add(id);

		const decision = value.decision;
		if (guard ? decision !== undefined && decision !== 'block' : !isDecision(decision)) {
			throw new Error(
				guard
					? `manifest ${scope} "${id}" decision must be block when provided`
					: `manifest ${scope} "${id}" decision must be allow, block, or approve`
			);
		}

		const classifications = normalizeStringList(value.classifications, `${scope} "${id}".classifications`);
		if (classifications?.some((item) => !CLASSIFICATIONS.has(item as CallClassification))) {
			throw new Error(`manifest ${scope} "${id}".classifications contains an unknown classification`);
		}
		const commands = normalizeStringList(value.commands, `${scope} "${id}".commands`);
		const paths = normalizeStringList(value.paths, `${scope} "${id}".paths`);
		const operations = normalizeStringList(value.operations, `${scope} "${id}".operations`);
		if (operations?.some((operation) => !isCanonicalOperation(operation))) {
			throw new Error(`manifest ${scope} "${id}".operations contains an invalid canonical operation`);
		}
		validateMatcherPatterns(commands, `${scope} "${id}".commands`);
		validateMatcherPatterns(paths, `${scope} "${id}".paths`);
		const entry = {
			id,
			decision: guard ? ('block' as const) : (decision as ApprovalDecision),
			tools: normalizeStringList(value.tools, `${scope} "${id}".tools`),
			commands,
			paths,
			classifications: classifications as CallClassification[] | undefined,
			agents: normalizeStringList(value.agents, `${scope} "${id}".agents`),
			operations,
			workspaces: normalizeStringList(value.workspaces, `${scope} "${id}".workspaces`),
			reason: typeof value.reason === 'string' && value.reason.trim() ? value.reason.trim() : undefined,
			mode: normalizeRuleMode(value.mode, `${scope} "${id}".mode`),
			expiresAt: normalizeExpiry(value.expires_at, `${scope} "${id}".expires_at`),
			maxUses: normalizeMaxUses(value.max_uses, `${scope} "${id}".max_uses`),
			selectorMode: normalizeSelectorMode(value, `${scope} "${id}"`),
			priority: normalizePriority(value.priority, `${scope} "${id}".priority`),
		};
		if (
			!entry.tools &&
			!entry.commands &&
			!entry.paths &&
			!entry.classifications &&
			!entry.agents &&
			!entry.operations &&
			!entry.workspaces
		) {
			throw new Error(`manifest ${scope} "${id}" must define at least one selector`);
		}
		return entry;
	});
}

function normalizeRuleMode(value: unknown, field: string): 'enforce' | 'warn' | 'observe' | undefined {
	if (value === undefined) return undefined;
	if (value !== 'enforce' && value !== 'warn' && value !== 'observe') {
		throw new Error(`manifest ${field} must be enforce, warn, or observe`);
	}
	return value;
}

function normalizeExpiry(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'string' || !value.trim() || Number.isNaN(Date.parse(value))) {
		throw new Error(`manifest ${field} must be an ISO timestamp`);
	}
	return new Date(value).toISOString();
}

function normalizeMaxUses(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || (value as number) <= 0) {
		throw new Error(`manifest ${field} must be a positive integer`);
	}
	return value as number;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
	if (value !== undefined && typeof value !== 'boolean') throw new Error(`manifest ${field} must be boolean`);
	return value as boolean | undefined;
}

function normalizeSelectorMode(value: Record<string, unknown>, field: string): 'all' | 'any' | undefined {
	const requiresAll = optionalBoolean(value.requires_all, `${field}.requires_all`);
	const requiresAny = optionalBoolean(value.requires_any, `${field}.requires_any`);
	if (requiresAll === true && requiresAny === true) {
		throw new Error(`manifest ${field} cannot require both all and any`);
	}
	if (requiresAny === true || requiresAll === false) return 'any';
	return requiresAll === true || requiresAny === false ? 'all' : undefined;
}

function normalizePriority(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value)) throw new Error(`manifest ${field} must be an integer`);
	return value as number;
}

function normalizeManifestTests(raw: unknown): ManifestPolicyTest[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) throw new Error('manifest test must be an array of tables');
	// fallow-ignore-next-line complexity -- one schema boundary validates the complete embedded call fixture.
	return raw.map((value, index) => {
		if (!isRecord(value) || !isRecord(value.call)) throw new Error(`manifest test[${index}].call must be a table`);
		const call = value.call;
		if (typeof call.agent !== 'string' || typeof call.tool !== 'string' || typeof call.command !== 'string') {
			throw new Error(`manifest test[${index}].call requires string agent, tool, and command`);
		}
		if (!isDecision(value.expect)) throw new Error(`manifest test[${index}].expect must be allow, block, or approve`);
		if (call.operation !== undefined && (typeof call.operation !== 'string' || !isCanonicalOperation(call.operation))) {
			throw new Error(`manifest test[${index}].call.operation must be canonical`);
		}
		return {
			id: typeof value.id === 'string' && value.id.trim() ? value.id.trim() : undefined,
			call: {
				agent: call.agent,
				tool: call.tool,
				command: call.command,
				operation: call.operation as string | undefined,
				workingDirectory: typeof call.workingDirectory === 'string' ? call.workingDirectory : undefined,
				workspaceId: typeof call.workspaceId === 'string' ? call.workspaceId : undefined,
				timestamp: typeof call.timestamp === 'string' ? call.timestamp : undefined,
			},
			expect: value.expect,
		};
	});
}

function normalizeWorkspaceRoots(raw: unknown, id: string, seen: Set<string>): string[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw) || raw.some((root) => typeof root !== 'string')) {
		throw new Error(`manifest workspace "${id}".roots must be a string array`);
	}
	return raw.map((root) => {
		if (!isAbsoluteWorkspaceRoot(root)) {
			throw new Error(`manifest workspace "${id}" root must be absolute: ${root}`);
		}
		const normalized = normalizeWorkspaceRoot(root);
		if (seen.has(normalized)) throw new Error(`manifest workspace root is duplicated: ${root}`);
		seen.add(normalized);
		return root;
	});
}

// fallow-ignore-next-line complexity -- workspace validation intentionally remains an atomic schema boundary.
function normalizeWorkspaceEntry(entry: unknown, index: number, ids: Set<string>, roots: Set<string>): WorkspaceConfig {
	if (!isRecord(entry)) throw new Error(`manifest workspaces[${index}] must be a table`);
	const id = typeof entry.id === 'string' ? entry.id.trim() : '';
	if (id.length === 0) throw new Error(`manifest workspaces[${index}].id must be a non-empty string`);
	if (ids.has(id)) throw new Error(`manifest workspace id "${id}" is duplicated`);
	ids.add(id);

	const defaultUnknown = entry.default_unknown;
	if (defaultUnknown !== undefined && !isDecision(defaultUnknown)) {
		throw new Error(`manifest workspace "${id}".default_unknown must be allow, block, or approve`);
	}
	if (entry.rules !== undefined && !isRecord(entry.rules)) {
		throw new Error(`manifest workspace "${id}".rules must be a table`);
	}
	const legacyRules = normalizeRules(isRecord(entry.rules) ? entry.rules : undefined);
	const defaults = normalizeClassificationDefaults(entry.defaults, `workspace "${id}".defaults`);
	const structuredRules = normalizeStructuredEntries(entry.rule, `workspace "${id}".rule`, false);
	const guards = normalizeStructuredEntries(entry.guard, `workspace "${id}".guard`, true);
	const identities = [...structuredRules, ...guards].map((item) => item.id);
	if (new Set(identities).size !== identities.length || identities.some((identity) => identity in legacyRules)) {
		throw new Error(
			`manifest workspace "${id}" structured rule and guard ids must be unique and must not collide with legacy patterns`
		);
	}
	return {
		id,
		roots: normalizeWorkspaceRoots(entry.roots, id, roots),
		default_unknown: defaultUnknown,
		...(defaults ? { defaults } : {}),
		rules: legacyRules,
		...(structuredRules.length > 0 ? { structuredRules } : {}),
		...(guards.length > 0 ? { guards } : {}),
	};
}

function normalizeWorkspaces(raw: unknown): WorkspaceConfig[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) throw new Error('manifest workspaces must be an array of tables');
	const ids = new Set<string>();
	const roots = new Set<string>();
	return raw.map((entry, index) => normalizeWorkspaceEntry(entry, index, ids, roots));
}

export async function loadManifest(manifestPath: string): Promise<Manifest> {
	let source: string;

	try {
		source = await Bun.file(manifestPath).text();
	} catch (error) {
		throw new Error(`failed to read manifest at ${manifestPath}: ${errorMessage(error)}`);
	}

	return parseManifestSource(source, manifestPath);
}

export function parseManifestSource(source: string, sourceLabel = 'manifest'): Manifest {
	let parsed: Record<string, unknown>;
	try {
		parsed = Bun.TOML.parse(source) as Record<string, unknown>;
	} catch (error) {
		throw new Error(`failed to parse manifest at ${sourceLabel}: ${errorMessage(error)}`);
	}

	const env = isRecord(parsed.env) ? parsed.env : undefined;
	const policy = isRecord(parsed.policy) ? parsed.policy : undefined;
	const rules = isRecord(parsed.rules) ? parsed.rules : undefined;
	const workspaces = parsed.workspaces;
	const structuredRules = parsed.rule;
	const guards = parsed.guard;
	const server = isRecord(parsed.server) ? parsed.server : undefined;
	const tests = parsed.test;

	if (!env?.name || !env?.version) {
		throw new Error('manifest env.name and env.version are required');
	}

	const rawTimeout = env.timeout;
	if (typeof rawTimeout !== 'number' || rawTimeout < 0) {
		throw new Error('manifest env.timeout is required and must be a non-negative number (seconds); use 0 to disable');
	}

	const normalizedStructuredRules = normalizeStructuredEntries(structuredRules, 'rule', false);
	const normalizedGuards = normalizeStructuredEntries(guards, 'guard', true);
	const identities = [...normalizedStructuredRules, ...normalizedGuards].map((item) => item.id);
	if (
		new Set(identities).size !== identities.length ||
		identities.some((identity) => identity in normalizeRules(rules))
	) {
		throw new Error(
			'manifest global structured rule and guard ids must be unique and must not collide with legacy patterns'
		);
	}
	return {
		env: {
			name: String(env.name),
			version: String(env.version),
			timeout: rawTimeout,
		},
		policy: normalizePolicy(policy),
		rules: normalizeRules(rules),
		...(normalizedStructuredRules.length > 0 ? { structuredRules: normalizedStructuredRules } : {}),
		...(normalizedGuards.length > 0 ? { guards: normalizedGuards } : {}),
		workspaces: normalizeWorkspaces(workspaces),
		...(tests === undefined ? {} : { tests: normalizeManifestTests(tests) }),
		server: normalizeServer(server),
	};
}
