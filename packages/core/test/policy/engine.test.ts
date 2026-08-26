import { describe, expect, test } from 'bun:test';
import type { Manifest } from '../../src/core/types.ts';
import { PolicyEngine } from '../../src/policy/engine.ts';
import { makeCall, makeManifest } from '../helpers.ts';

test('legacy programmatic manifests without workspaces retain global policy behavior', () => {
	const manifest: Manifest = {
		env: { name: 'legacy-embedder', version: '1.0.0', timeout: 5 },
		policy: { default_unknown: 'block', approval_method: 'web' },
		rules: { 'npm install *': 'allow' },
		server: { host: '127.0.0.1', port: 9090 },
	};

	const result = new PolicyEngine(manifest).evaluate(makeCall({ command: 'npm install lodash' }));

	expect(result).toMatchObject({
		decision: 'allow',
		matchedRule: 'npm install *',
		policyScope: 'global',
	});
});

describe('engine > structured policy', () => {
	test('supports observe, warn, expiry, and per-generation usage limits', () => {
		const engine = new PolicyEngine(
			makeManifest({
				policy: { default_unknown: 'block', approval_method: 'web' },
				structuredRules: [
					{ id: 'observe-only', decision: 'allow', tools: ['observe'], mode: 'observe' },
					{ id: 'warn-write', decision: 'approve', tools: ['warn'], mode: 'warn' },
					{ id: 'expired', decision: 'allow', tools: ['expired'], expiresAt: '2020-01-01T00:00:00.000Z' },
					{ id: 'twice', decision: 'allow', tools: ['limited'], maxUses: 2 },
				],
			})
		);
		const observed = engine.evaluateWithTrace(makeCall({ tool: 'observe', command: 'run' }));
		expect(observed.result.decision).toBe('block');
		expect(observed.matches).toContainEqual(expect.objectContaining({ id: 'observe-only', selected: false }));
		expect(engine.evaluate(makeCall({ tool: 'warn', command: 'run' }))).toMatchObject({
			decision: 'approve',
			matchedRuleMode: 'warn',
		});
		expect(
			engine.evaluate(makeCall({ tool: 'expired', command: 'run', timestamp: '2026-01-01T00:00:00Z' })).decision
		).toBe('block');
		expect(engine.evaluate(makeCall({ tool: 'limited', command: 'run' })).decision).toBe('allow');
		expect(engine.evaluate(makeCall({ tool: 'limited', command: 'run' })).decision).toBe('allow');
		expect(engine.evaluate(makeCall({ tool: 'limited', command: 'run' })).decision).toBe('block');
	});

	test('returns all selector-aware matches while identifying the enforcement winner', () => {
		const engine = new PolicyEngine(
			makeManifest({
				structuredRules: [{ id: 'status', decision: 'allow', commands: ['git status'] }],
				rules: { 'git *': 'block' },
			})
		);
		const trace = engine.evaluateWithTrace(makeCall({ command: 'git status' }));
		expect(trace.result).toMatchObject({ decision: 'allow', matchedRule: 'status' });
		expect(trace.matches).toEqual([
			expect.objectContaining({ id: 'status', selected: true, scope: 'global' }),
			expect.objectContaining({ id: 'git *', selected: false, scope: 'global' }),
		]);
	});
	test('ANDs selector kinds and ORs values within a selector', () => {
		const engine = new PolicyEngine(
			makeManifest({
				structuredRules: [
					{
						id: 'safe-repository-reads',
						decision: 'allow',
						tools: ['read', 'grep'],
						paths: ['/work/repo/**'],
						classifications: ['readonly'],
					},
				],
			})
		);

		const allowed = engine.evaluate(
			makeCall({ tool: 'Read', command: '/work/repo/src/app.ts', inputs: { file_path: '/work/repo/src/app.ts' } })
		);
		const outside = engine.evaluate(
			makeCall({ tool: 'Read', command: '/tmp/app.ts', inputs: { file_path: '/tmp/app.ts' } })
		);
		expect(allowed).toMatchObject({ decision: 'allow', matchedRule: 'safe-repository-reads' });
		expect(outside.matchedRule).toBeUndefined();
	});

	test('matches trusted canonical operation selectors', () => {
		const result = new PolicyEngine(
			makeManifest({
				structuredRules: [{ id: 'host-read', decision: 'allow', operations: ['filesystem.read'] }],
			})
		).evaluate(makeCall({ tool: 'host_tool', operation: 'filesystem.read', command: '/work/file' }));
		expect(result).toMatchObject({ decision: 'allow', matchedRule: 'host-read' });
	});

	test('supports resolved workspace selectors, any matching, priority, and selector attribution', () => {
		const result = new PolicyEngine(
			makeManifest({
				structuredRules: [
					{ id: 'low', decision: 'block', tools: ['read'], priority: 1 },
					{
						id: 'high',
						decision: 'allow',
						tools: ['write'],
						workspaces: ['repo'],
						selectorMode: 'any',
						priority: 10,
					},
				],
				workspaces: [{ id: 'repo', roots: ['/work/repo'], rules: {} }],
			})
		).evaluate(makeCall({ tool: 'read', command: '/work/repo/file', workingDirectory: '/work/repo' }));
		expect(result).toMatchObject({
			decision: 'allow',
			matchedRule: 'high',
			matchedSelectors: ['workspaces'],
			resolvedWorkspaceId: 'repo',
		});
	});

	test('global guards cannot be relaxed by workspace or legacy allows', () => {
		const engine = new PolicyEngine(
			makeManifest({
				guards: [{ id: 'credentials', decision: 'block', paths: ['**/.env'] }],
				rules: { '*': 'allow' },
				workspaces: [
					{
						id: 'relaxed',
						roots: ['/work/repo'],
						rules: { '*': 'allow' },
						structuredRules: [{ id: 'all-reads', decision: 'allow', tools: ['read'] }],
					},
				],
			})
		);

		const result = engine.evaluate(
			makeCall({
				tool: 'Read',
				command: '/work/repo/.env',
				workingDirectory: '/work/repo',
				inputs: { file_path: '/work/repo/.env' },
			})
		);
		expect(result).toMatchObject({ decision: 'block', matchedRule: 'credentials', policyScope: 'global' });
		expect(result.reason).toContain('guard');
	});

	test('structured path guards protect directory searches through a hidden-file probe', () => {
		const engine = new PolicyEngine(
			makeManifest({
				policy: { default_unknown: 'approve', approval_method: 'web' },
				guards: [{ id: 'credentials', decision: 'block', paths: ['**/.env'] }],
			})
		);
		const result = engine.evaluate(makeCall({ tool: 'grep', command: '/work/repo' }));
		expect(result.decision).toBe('approve');
		expect(result.reason).toContain('hidden files');
	});

	test('workspace guards run before workspace and global rules', () => {
		const engine = new PolicyEngine(
			makeManifest({
				structuredRules: [{ id: 'publish', decision: 'approve', commands: ['git push *'] }],
				workspaces: [
					{
						id: 'repo',
						roots: ['/work/repo'],
						rules: {},
						structuredRules: [{ id: 'workspace-publish', decision: 'allow', commands: ['git push *'] }],
						guards: [{ id: 'no-force-push', decision: 'block', commands: ['git push --force *'] }],
					},
				],
			})
		);

		const result = engine.evaluate(
			makeCall({ command: 'git push --force origin main', workingDirectory: '/work/repo' })
		);
		expect(result).toMatchObject({ decision: 'block', matchedRule: 'no-force-push', policyScope: 'workspace' });
	});

	test('structured rules take precedence over legacy rules in the same scope', () => {
		const engine = new PolicyEngine(
			makeManifest({
				structuredRules: [{ id: 'structured-publish', decision: 'block', commands: ['git push *'] }],
				rules: { 'git push *': 'allow' },
			})
		);
		expect(engine.evaluate(makeCall({ command: 'git push origin main' }))).toMatchObject({
			decision: 'block',
			matchedRule: 'structured-publish',
		});
	});
});

// ── Rule matching takes priority ─────────────────────────────

describe('engine > rule matching', () => {
	test('explicit allow rule overrides classification', () => {
		const engine = new PolicyEngine(
			makeManifest({
				policy: { default_unknown: 'block', approval_method: 'web' },
				rules: { 'npm install *': 'allow' },
			})
		);

		const result = engine.evaluate(makeCall({ command: 'npm install lodash' }));
		expect(result.decision).toBe('allow');
		expect(result.matchedRule).toBe('npm install *');
		expect(result.reason).toContain('matched rule');
	});

	test('explicit block rule overrides classification', () => {
		const engine = new PolicyEngine(
			makeManifest({
				rules: { 'git status': 'block' },
			})
		);

		// git status is normally readonly → auto-allow, but explicit block wins
		const result = engine.evaluate(makeCall({ command: 'git status' }));
		expect(result.decision).toBe('block');
		expect(result.matchedRule).toBe('git status');
	});

	test('approve rule matched', () => {
		const engine = new PolicyEngine(
			makeManifest({
				rules: { 'rm *': 'approve' },
			})
		);

		const result = engine.evaluate(makeCall({ command: 'rm -rf /tmp/junk' }));
		expect(result.decision).toBe('approve');
		expect(result.classification).toBe('destructive');
	});

	test('regex rules work', () => {
		const engine = new PolicyEngine(
			makeManifest({
				rules: { '/^git\\s+push/': 'approve' },
			})
		);

		const result = engine.evaluate(makeCall({ command: 'git push origin main' }));
		expect(result.decision).toBe('approve');
		expect(result.matchedRule).toBe('/^git\\s+push/');
	});

	test('first matching rule wins', () => {
		const engine = new PolicyEngine(
			makeManifest({
				rules: {
					'rm *': 'approve',
					'rm -rf *': 'block',
				},
			})
		);

		const result = engine.evaluate(makeCall({ command: 'rm -rf /tmp' }));
		expect(result.decision).toBe('approve');
		expect(result.matchedRule).toBe('rm *');
	});
});

// ── Readonly auto-allow ──────────────────────────────────────

describe('engine > readonly auto-allow', () => {
	test('readonly bash commands auto-allowed', () => {
		const engine = new PolicyEngine(makeManifest({ rules: {} }));

		const result = engine.evaluate(makeCall({ command: 'git status' }));
		expect(result.decision).toBe('allow');
		expect(result.classification).toBe('readonly');
		expect(result.reason).toContain('auto-allowed readonly');
	});

	test('readonly non-bash tools auto-allowed', () => {
		const engine = new PolicyEngine(makeManifest({ rules: {} }));

		const result = engine.evaluate(makeCall({ tool: 'Read', command: '/tmp/file.txt' }));
		expect(result.decision).toBe('allow');
		expect(result.classification).toBe('readonly');
	});
});

describe('engine > classification defaults', () => {
	test('uses classification defaults and removes unconditional readonly auto-allow', () => {
		const engine = new PolicyEngine(
			makeManifest({
				policy: {
					default_unknown: 'block',
					approval_method: 'web',
					defaults: { readonly: 'approve', stateful: 'allow', destructive: 'block', external: 'approve' },
				},
			})
		);

		expect(engine.evaluate(makeCall({ command: 'git status' }))).toMatchObject({
			decision: 'approve',
			classification: 'readonly',
			policyScope: 'global',
		});
		expect(engine.evaluate(makeCall({ command: 'cargo build' })).decision).toBe('allow');
		expect(engine.evaluate(makeCall({ command: 'rm -rf /tmp/cache' })).decision).toBe('block');
		expect(engine.evaluate(makeCall({ command: 'curl https://example.com' })).decision).toBe('approve');
		expect(engine.evaluate(makeCall({ tool: 'SomethingNew', command: 'test' })).decision).toBe('block');
	});

	test('workspace defaults override aliases while missing entries preserve compatibility precedence', () => {
		const engine = new PolicyEngine(
			makeManifest({
				policy: {
					default_unknown: 'block',
					approval_method: 'web',
					defaults: { readonly: 'block', stateful: 'approve' },
				},
				workspaces: [
					{
						id: 'legacy',
						roots: ['/work/legacy'],
						default_unknown: 'allow',
						defaults: { readonly: 'approve' },
						rules: {},
					},
					{ id: 'inherited', roots: ['/work/inherited'], rules: {} },
				],
			})
		);

		expect(engine.evaluate(makeCall({ workspaceId: 'legacy', command: 'git status' }))).toMatchObject({
			decision: 'approve',
			policyScope: 'workspace',
		});
		expect(engine.evaluate(makeCall({ workspaceId: 'legacy', command: 'cargo build' }))).toMatchObject({
			decision: 'allow',
			policyScope: 'workspace',
		});
		expect(engine.evaluate(makeCall({ workspaceId: 'inherited', command: 'cargo build' }))).toMatchObject({
			decision: 'approve',
			policyScope: 'global',
		});
	});

	test('guards still win over permissive readonly defaults', () => {
		const result = new PolicyEngine(
			makeManifest({
				policy: { default_unknown: 'block', approval_method: 'web', defaults: { readonly: 'allow' } },
				guards: [{ id: 'credentials', decision: 'block', paths: ['**/.env'] }],
			})
		).evaluate(makeCall({ tool: 'Read', command: '/work/.env', inputs: { file_path: '/work/.env' } }));

		expect(result).toMatchObject({ decision: 'block', matchedRule: 'credentials' });
	});

	test('protected directory searches bypass permissive readonly defaults', () => {
		const result = new PolicyEngine(
			makeManifest({
				policy: {
					default_unknown: 'approve',
					approval_method: 'web',
					defaults: { readonly: 'allow' },
				},
				guards: [{ id: 'credentials', decision: 'block', paths: ['**/.env'] }],
			})
		).evaluate(makeCall({ tool: 'grep', command: '/work/repo' }));

		expect(result).toMatchObject({ decision: 'approve', classification: 'readonly', policyScope: 'global' });
		expect(result.reason).toContain('policy.default_unknown=approve');
	});
});

// ── Grep/glob hidden file protection ─────────────────────────

describe('engine > hidden file protection', () => {
	test('grep on directory falls back to default_unknown when block rule covers hidden files', () => {
		const engine = new PolicyEngine(
			makeManifest({
				policy: { default_unknown: 'block', approval_method: 'web' },
				rules: {
					// Block any path with a hidden file component
					'/\\.[^\\s\\/]+/': 'block',
				},
			})
		);

		const result = engine.evaluate(makeCall({ tool: 'grep', command: '/home/user/project' }));
		// The probe "/home/user/project/.hidden_probe" matches the block rule,
		// so grep on this directory gets default_unknown instead of auto-allow
		expect(result.decision).toBe('block');
		expect(result.reason).toContain('hidden files');
	});

	test('grep on directory auto-allowed when no block rule covers hidden files', () => {
		const engine = new PolicyEngine(makeManifest({ rules: {} }));

		const result = engine.evaluate(makeCall({ tool: 'grep', command: '/home/user/project' }));
		expect(result.decision).toBe('allow');
		expect(result.classification).toBe('readonly');
	});

	test('glob tool gets same hidden file protection', () => {
		const engine = new PolicyEngine(
			makeManifest({
				policy: { default_unknown: 'approve', approval_method: 'web' },
				rules: {
					'/\\.[^\\s\\/]+/': 'block',
				},
			})
		);

		const result = engine.evaluate(makeCall({ tool: 'glob', command: '/home/user/project' }));
		expect(result.decision).toBe('approve'); // falls back to default_unknown
		expect(result.reason).toContain('hidden files');
	});

	test('grep is fine when hidden-file block rule has allow decision', () => {
		const engine = new PolicyEngine(
			makeManifest({
				rules: {
					// This rule matches hidden files but allows them
					'/\\.[^\\s\\/]+/': 'allow',
				},
			})
		);

		const result = engine.evaluate(makeCall({ tool: 'grep', command: '/home/user/project' }));
		expect(result.decision).toBe('allow');
		expect(result.reason).toContain('auto-allowed readonly');
	});
});

// ── Default unknown fallback ─────────────────────────────────

describe('engine > default_unknown fallback', () => {
	test('unmatched non-readonly falls back to default_unknown=block', () => {
		const engine = new PolicyEngine(
			makeManifest({
				policy: { default_unknown: 'block', approval_method: 'web' },
				rules: {},
			})
		);

		const result = engine.evaluate(makeCall({ command: 'cargo build' }));
		expect(result.decision).toBe('block');
		expect(result.classification).toBe('stateful');
		expect(result.reason).toContain('default_unknown=block');
	});

	test('unmatched non-readonly falls back to default_unknown=allow', () => {
		const engine = new PolicyEngine(
			makeManifest({
				policy: { default_unknown: 'allow', approval_method: 'web' },
				rules: {},
			})
		);

		const result = engine.evaluate(makeCall({ command: 'cargo build' }));
		expect(result.decision).toBe('allow');
	});

	test('unmatched non-readonly falls back to default_unknown=approve', () => {
		const engine = new PolicyEngine(
			makeManifest({
				policy: { default_unknown: 'approve', approval_method: 'web' },
				rules: {},
			})
		);

		const result = engine.evaluate(makeCall({ command: 'cargo build' }));
		expect(result.decision).toBe('approve');
	});

	test('unknown tool classification falls back to default_unknown', () => {
		const engine = new PolicyEngine(
			makeManifest({
				policy: { default_unknown: 'approve', approval_method: 'web' },
				rules: {},
			})
		);

		const result = engine.evaluate(makeCall({ tool: 'SomethingNew', command: 'test' }));
		expect(result.decision).toBe('approve');
		expect(result.classification).toBe('unknown');
	});
});

// ── Classification is always correct in result ───────────────

describe('engine > classification passthrough', () => {
	const engine = new PolicyEngine(
		makeManifest({
			policy: { default_unknown: 'block', approval_method: 'web' },
			rules: { 'rm *': 'approve' },
		})
	);

	test('destructive classification preserved in result', () => {
		const result = engine.evaluate(makeCall({ command: 'rm -rf /tmp' }));
		expect(result.classification).toBe('destructive');
	});

	test('readonly classification preserved in result', () => {
		const result = engine.evaluate(makeCall({ command: 'git status' }));
		expect(result.classification).toBe('readonly');
	});

	test('external classification preserved in result', () => {
		const result = engine.evaluate(makeCall({ command: 'curl https://example.com' }));
		expect(result.classification).toBe('external');
	});

	test('stateful classification preserved in result', () => {
		const result = engine.evaluate(makeCall({ command: 'cargo build' }));
		expect(result.classification).toBe('stateful');
	});
});

// ── Input-based rule matching ────────────────────────────────

describe('engine > input path matching', () => {
	test('rules match against tool-prefixed paths from inputs', () => {
		const engine = new PolicyEngine(
			makeManifest({
				rules: {
					'/read\\s+\\.env/': 'block',
				},
			})
		);

		const result = engine.evaluate(
			makeCall({
				tool: 'Read',
				command: 'Read',
				inputs: {
					tool_input: { file_path: '.env' },
				},
			})
		);
		expect(result.decision).toBe('block');
	});
});

describe('engine > workspace policy', () => {
	const manifest = makeManifest({
		policy: { default_unknown: 'approve', approval_method: 'web' },
		rules: {
			'git push *': 'approve',
			'rm *': 'block',
		},
		workspaces: [
			{
				id: 'strict',
				roots: ['/work/strict'],
				default_unknown: 'block',
				rules: { 'git push *': 'block' },
			},
			{
				id: 'relaxed',
				roots: ['/work/relaxed'],
				default_unknown: 'allow',
				rules: { 'rm /tmp/*': 'allow' },
			},
		],
	});

	test('explicit workspace rule overrides global rule', () => {
		const result = new PolicyEngine(manifest).evaluate(
			makeCall({ workspaceId: 'strict', command: 'git push origin main' })
		);
		expect(result).toMatchObject({
			decision: 'block',
			policyScope: 'workspace',
			resolvedWorkspaceId: 'strict',
			matchedRule: 'git push *',
		});
	});

	test('cwd root selects workspace when no id is supplied', () => {
		const result = new PolicyEngine(manifest).evaluate(
			makeCall({ workingDirectory: '/work/strict/src', command: 'cargo build' })
		);
		expect(result).toMatchObject({
			decision: 'block',
			policyScope: 'workspace',
			resolvedWorkspaceId: 'strict',
		});
	});

	test('workspace can explicitly relax a global rule', () => {
		const result = new PolicyEngine(manifest).evaluate(makeCall({ workspaceId: 'relaxed', command: 'rm /tmp/cache' }));
		expect(result).toMatchObject({
			decision: 'allow',
			policyScope: 'workspace',
			matchedRule: 'rm /tmp/*',
		});
	});

	test('unmatched workspace rule inherits a matching global rule', () => {
		const result = new PolicyEngine(manifest).evaluate(
			makeCall({ workspaceId: 'relaxed', command: 'git push origin main' })
		);
		expect(result).toMatchObject({
			decision: 'approve',
			policyScope: 'global',
			resolvedWorkspaceId: 'relaxed',
		});
	});

	test('unknown explicit workspace cannot bypass a matching cwd workspace', () => {
		const result = new PolicyEngine(manifest).evaluate(
			makeCall({
				workspaceId: 'missing',
				workingDirectory: '/work/strict',
				command: 'cargo build',
			})
		);
		expect(result).toMatchObject({
			decision: 'block',
			policyScope: 'workspace',
			resolvedWorkspaceId: 'strict',
		});
	});

	test('unknown explicit workspace without a matching cwd fails closed before global rule matching', () => {
		const result = new PolicyEngine(manifest).evaluate(
			makeCall({
				workspaceId: 'missing',
				workingDirectory: '/other',
				command: 'git push origin main',
			})
		);
		expect(result).toMatchObject({ decision: 'block', policyScope: 'global' });
		expect(result.matchedRule).toBeUndefined();
		expect(result.resolvedWorkspaceId).toBeUndefined();
		expect(result.reason).toContain('working directory did not match');
	});

	test('unknown explicit workspace without a matching cwd blocks readonly calls', () => {
		const result = new PolicyEngine(manifest).evaluate(
			makeCall({
				workspaceId: 'missing',
				workingDirectory: '/other',
				command: 'git status',
			})
		);
		expect(result).toMatchObject({ decision: 'block', classification: 'readonly' });
		expect(result.reason).toContain('requested workspace "missing" was not configured');
	});
});
