import { DEFAULT_HOST, DEFAULT_PORT } from '../core/types.ts';
import type { ApprovalDecision, Manifest, PolicyConfig, ServerConfig, WorkspaceConfig } from '../core/types.ts';
import { isAbsoluteWorkspaceRoot, normalizeWorkspaceRoot } from '../policy/workspace.ts';
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

function normalizePolicy(raw: Record<string, unknown> | undefined): PolicyConfig {
	const defaultUnknown = raw?.default_unknown;
	const approvalMethod = raw?.approval_method;

	if (!isDecision(defaultUnknown)) {
		throw new Error('manifest policy.default_unknown must be allow, block, or approve');
	}

	if (approvalMethod !== 'web' && approvalMethod !== 'cli' && approvalMethod !== 'both') {
		throw new Error('manifest policy.approval_method must be web, cli, or both');
	}

	return {
		default_unknown: defaultUnknown,
		approval_method: approvalMethod,
	};
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
	return {
		id,
		roots: normalizeWorkspaceRoots(entry.roots, id, roots),
		default_unknown: defaultUnknown,
		rules: normalizeRules(entry.rules),
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

	let parsed: Record<string, unknown>;

	try {
		parsed = Bun.TOML.parse(source) as Record<string, unknown>;
	} catch (error) {
		throw new Error(`failed to parse manifest at ${manifestPath}: ${errorMessage(error)}`);
	}

	const env = isRecord(parsed.env) ? parsed.env : undefined;
	const policy = isRecord(parsed.policy) ? parsed.policy : undefined;
	const rules = isRecord(parsed.rules) ? parsed.rules : undefined;
	const workspaces = parsed.workspaces;
	const server = isRecord(parsed.server) ? parsed.server : undefined;

	if (!env?.name || !env?.version) {
		throw new Error('manifest env.name and env.version are required');
	}

	const rawTimeout = env.timeout;
	if (typeof rawTimeout !== 'number' || rawTimeout < 0) {
		throw new Error('manifest env.timeout is required and must be a non-negative number (seconds); use 0 to disable');
	}

	return {
		env: {
			name: String(env.name),
			version: String(env.version),
			timeout: rawTimeout,
		},
		policy: normalizePolicy(policy),
		rules: normalizeRules(rules),
		workspaces: normalizeWorkspaces(workspaces),
		server: normalizeServer(server),
	};
}
