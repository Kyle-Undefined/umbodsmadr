import { DEFAULT_HOST, DEFAULT_PORT } from '../core/types.ts';
import type { ApprovalDecision, Manifest, PolicyConfig, ServerConfig } from '../core/types.ts';
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
		server: normalizeServer(server),
	};
}
