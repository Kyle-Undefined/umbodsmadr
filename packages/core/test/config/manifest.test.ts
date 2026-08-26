import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { createDefaultManifestSource, loadManifest } from '../../src/config/manifest.ts';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'umbod-test-'));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function writeToml(content: string): string {
	const filePath = join(tempDir, 'umbod.toml');
	writeFileSync(filePath, content);
	return filePath;
}

describe('createDefaultManifestSource', () => {
	test('renders a valid Umbod starter manifest', async () => {
		const path = writeToml(createDefaultManifestSource());
		const manifest = await loadManifest(path);

		expect(manifest.env).toEqual({ name: 'dev', version: '1.0.0', timeout: 30 });
		expect(manifest.policy).toEqual({ default_unknown: 'block', approval_method: 'web' });
		expect(manifest.rules['git push *']).toBe('approve');
		expect(manifest.rules['/(^|\\/)\\.[^\\s\\/]+/']).toBe('block');
	});

	test('supports host-specific environment and approval defaults', async () => {
		const path = writeToml(
			createDefaultManifestSource({
				name: 'hlid',
				version: '2.0.0',
				timeout: 300,
				defaultUnknown: 'approve',
				approvalMethod: 'cli',
			})
		);
		const manifest = await loadManifest(path);

		expect(manifest.env).toEqual({ name: 'hlid', version: '2.0.0', timeout: 300 });
		expect(manifest.policy).toEqual({ default_unknown: 'approve', approval_method: 'cli' });
	});

	test('rejects an invalid timeout', () => {
		expect(() => createDefaultManifestSource({ timeout: -1 })).toThrow('non-negative');
	});
});

// ── Valid manifests ──────────────────────────────────────────

describe('loadManifest > valid', () => {
	test('minimal manifest', async () => {
		const path = writeToml(`
[env]
name = "test"
version = "1.0.0"
timeout = 5

[policy]
default_unknown = "block"
approval_method = "web"
`);

		const manifest = await loadManifest(path);
		expect(manifest.env.name).toBe('test');
		expect(manifest.env.version).toBe('1.0.0');
		expect(manifest.policy.default_unknown).toBe('block');
		expect(manifest.policy.approval_method).toBe('web');
		expect(manifest.rules).toEqual({});
		expect(manifest.server.host).toBe('127.0.0.1');
		expect(manifest.server.port).toBe(9090);
	});

	test('full manifest with rules and server', async () => {
		const path = writeToml(`
[env]
name = "production"
version = "2.0.0"
timeout = 5

[policy]
default_unknown = "approve"
approval_method = "both"

[server]
host = "0.0.0.0"
port = 8080

[rules]
"git status" = "allow"
"rm *" = "approve"
"/^curl/" = "block"
`);

		const manifest = await loadManifest(path);
		expect(manifest.env.name).toBe('production');
		expect(manifest.policy.default_unknown).toBe('approve');
		expect(manifest.policy.approval_method).toBe('both');
		expect(manifest.server.host).toBe('0.0.0.0');
		expect(manifest.server.port).toBe(8080);
		expect(manifest.rules['git status']).toBe('allow');
		expect(manifest.rules['rm *']).toBe('approve');
		expect(manifest.rules['/^curl/']).toBe('block');
	});

	test('all approval methods', async () => {
		for (const method of ['web', 'cli', 'both'] as const) {
			const path = writeToml(`
[env]
name = "test"
version = "1.0.0"
timeout = 5

[policy]
default_unknown = "block"
approval_method = "${method}"
`);

			const manifest = await loadManifest(path);
			expect(manifest.policy.approval_method).toBe(method);
		}
	});

	test('all default_unknown values', async () => {
		for (const decision of ['allow', 'block', 'approve'] as const) {
			const path = writeToml(`
[env]
name = "test"
version = "1.0.0"
timeout = 5

[policy]
default_unknown = "${decision}"
approval_method = "web"
`);

			const manifest = await loadManifest(path);
			expect(manifest.policy.default_unknown).toBe(decision);
		}
	});

	test('supports classification defaults with unknown as the compatibility fallback', async () => {
		const path = writeToml(`
[env]
name = "test"
version = "1.0.0"
timeout = 5

[policy]
approval_method = "web"

[policy.defaults]
readonly = "allow"
stateful = "approve"
destructive = "block"
external = "approve"
unknown = "block"
`);

		const manifest = await loadManifest(path);
		expect(manifest.policy).toEqual({
			default_unknown: 'block',
			approval_method: 'web',
			defaults: {
				readonly: 'allow',
				stateful: 'approve',
				destructive: 'block',
				external: 'approve',
				unknown: 'block',
			},
		});
	});

	test('server defaults when section omitted', async () => {
		const path = writeToml(`
[env]
name = "test"
version = "1.0.0"
timeout = 5

[policy]
default_unknown = "block"
approval_method = "web"
`);

		const manifest = await loadManifest(path);
		expect(manifest.server.host).toBe('127.0.0.1');
		expect(manifest.server.port).toBe(9090);
	});

	test('empty rules section', async () => {
		const path = writeToml(`
[env]
name = "test"
version = "1.0.0"
timeout = 5

[policy]
default_unknown = "block"
approval_method = "web"

[rules]
`);

		const manifest = await loadManifest(path);
		expect(manifest.rules).toEqual({});
	});

	test('workspace profiles support explicit ids, roots, fallbacks, and rules', async () => {
		const path = writeToml(`
[env]
name = "test"
version = "1.0.0"
timeout = 5

[policy]
default_unknown = "approve"
approval_method = "web"

[[workspaces]]
id = "client"
roots = ["/work/client", "C:\\\\work\\\\client"]
default_unknown = "block"

[workspaces.rules]
"git push *" = "block"

[[workspaces]]
id = "conceptual"

[workspaces.rules]
"deploy *" = "approve"
`);

		const manifest = await loadManifest(path);
		expect(manifest.workspaces).toEqual([
			{
				id: 'client',
				roots: ['/work/client', 'C:\\work\\client'],
				default_unknown: 'block',
				rules: { 'git push *': 'block' },
			},
			{
				id: 'conceptual',
				roots: [],
				default_unknown: undefined,
				rules: { 'deploy *': 'approve' },
			},
		]);
	});

	test('accepts mobile-safe literal Windows drive and wsl.localhost roots', async () => {
		const path = writeToml(`
[env]
name = "test"
version = "1.0.0"
timeout = 5

[policy]
default_unknown = "approve"
approval_method = "web"

[[workspaces]]
id = "hlid"
roots = [
  '/home/kyle/development/repos/hlid',
  'C:\\Users\\kyleu\\development\\repos\\hlid',
  '\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\development\\repos\\hlid'
]
`);

		const manifest = await loadManifest(path);
		expect(manifest.workspaces?.[0]?.roots).toEqual([
			'/home/kyle/development/repos/hlid',
			'C:\\Users\\kyleu\\development\\repos\\hlid',
			'\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\development\\repos\\hlid',
		]);
	});

	test('workspace profiles support classification defaults', async () => {
		const path = writeToml(`
[env]
name = "test"
version = "1.0.0"
timeout = 5
[policy]
default_unknown = "block"
approval_method = "web"
[[workspaces]]
id = "repo"
roots = ["/work/repo"]
[workspaces.defaults]
readonly = "approve"
stateful = "allow"
`);

		const manifest = await loadManifest(path);
		expect(manifest.workspaces?.[0]?.defaults).toEqual({ readonly: 'approve', stateful: 'allow' });
	});

	test('supports ordered structured rules and block-only guards', async () => {
		const path = writeToml(`
[env]
name = "test"
version = "1.0.0"
timeout = 5

[policy]
default_unknown = "approve"
approval_method = "web"

[[rule]]
id = "repository-reads"
decision = "allow"
tools = ["read", "grep"]
paths = ["/work/repo/**"]
classifications = ["readonly"]
operations = ["filesystem.read"]
reason = "normal repository read"

[[guard]]
id = "credentials"
paths = ["**/.env", "**/*.pem"]

[[workspaces]]
id = "repo"
roots = ["/work/repo"]

[[workspaces.rule]]
id = "normal-edits"
decision = "allow"
tools = ["edit", "write"]

[[workspaces.guard]]
id = "no-force-push"
commands = ["git push --force *"]
`);

		const manifest = await loadManifest(path);
		expect(manifest.structuredRules?.[0]).toMatchObject({
			id: 'repository-reads',
			decision: 'allow',
			operations: ['filesystem.read'],
		});
		expect(manifest.guards?.[0]).toMatchObject({
			id: 'credentials',
			decision: 'block',
			paths: ['**/.env', '**/*.pem'],
		});
		expect(manifest.workspaces?.[0]?.structuredRules?.[0]?.id).toBe('normal-edits');
		expect(manifest.workspaces?.[0]?.guards?.[0]).toMatchObject({ id: 'no-force-push', decision: 'block' });
	});

	test('supports rule lifecycle controls and embedded policy tests', async () => {
		const path = writeToml(`
[env]
name = "test"
version = "1.0.0"
timeout = 5
[policy]
default_unknown = "block"
approval_method = "web"
[[rule]]
id = "temporary-read"
decision = "allow"
operations = ["filesystem.read"]
mode = "warn"
expires_at = "2030-01-01T00:00:00Z"
max_uses = 2
[[test]]
id = "read-is-allowed"
call = { agent = "host", tool = "read", command = "/work/file", operation = "filesystem.read" }
expect = "allow"
`);
		const manifest = await loadManifest(path);
		expect(manifest.structuredRules?.[0]).toMatchObject({
			mode: 'warn',
			expiresAt: '2030-01-01T00:00:00.000Z',
			maxUses: 2,
		});
		expect(manifest.tests?.[0]).toMatchObject({ id: 'read-is-allowed', expect: 'allow' });
	});

	test('supports workspace selectors, any-selector semantics, and priority', async () => {
		const path = writeToml(`
[env]
name = "test"
version = "1.0.0"
timeout = 5
[policy]
default_unknown = "block"
approval_method = "web"
[[rule]]
id = "targeted"
decision = "allow"
tools = ["read"]
workspaces = ["repo"]
requires_any = true
priority = 20
`);
		expect((await loadManifest(path)).structuredRules?.[0]).toMatchObject({
			workspaces: ['repo'],
			selectorMode: 'any',
			priority: 20,
		});
	});
});

describe('loadManifest > structured policy validation', () => {
	test('rejects a guard that attempts to allow', async () => {
		const path = writeToml(`
[env]
name = "test"
version = "1.0.0"
timeout = 5
[policy]
default_unknown = "block"
approval_method = "web"
[[guard]]
id = "unsafe"
decision = "allow"
tools = ["read"]
`);
		await expect(loadManifest(path)).rejects.toThrow('decision must be block');
	});

	test('rejects selector-free and duplicate structured rules', async () => {
		const noSelector = writeToml(`
[env]
name = "test"
version = "1.0.0"
timeout = 5
[policy]
default_unknown = "block"
approval_method = "web"
[[rule]]
id = "empty"
decision = "allow"
`);
		await expect(loadManifest(noSelector)).rejects.toThrow('at least one selector');

		const duplicate = writeToml(`
[env]
name = "test"
version = "1.0.0"
timeout = 5
[policy]
default_unknown = "block"
approval_method = "web"
[[rule]]
id = "same"
decision = "allow"
tools = ["read"]
[[rule]]
id = "same"
decision = "block"
tools = ["write"]
`);
		await expect(loadManifest(duplicate)).rejects.toThrow('duplicated');
	});

	test('rejects malformed operation selectors', async () => {
		const path = writeToml(`
[env]
name = "test"
version = "1.0.0"
timeout = 5
[policy]
default_unknown = "block"
approval_method = "web"
[[rule]]
id = "bad-operation"
decision = "allow"
operations = ["Filesystem Read"]
`);
		await expect(loadManifest(path)).rejects.toThrow('invalid canonical operation');
	});

	test('rejects invalid structured regexes and identity collisions with legacy rules', async () => {
		const invalidRegex = writeToml(`
[env]
name = "test"
version = "1.0.0"
timeout = 5
[policy]
default_unknown = "block"
approval_method = "web"
[[rule]]
id = "invalid"
decision = "allow"
commands = ["/[invalid/"]
`);
		await expect(loadManifest(invalidRegex)).rejects.toThrow('invalid regex');

		const collision = writeToml(`
[env]
name = "test"
version = "1.0.0"
timeout = 5
[policy]
default_unknown = "block"
approval_method = "web"
[rules]
credentials = "allow"
[[guard]]
id = "credentials"
paths = ["**/.env"]
`);
		await expect(loadManifest(collision)).rejects.toThrow('must not collide');
	});
});

// ── Invalid manifests ────────────────────────────────────────

describe('loadManifest > invalid', () => {
	test('missing env.name', async () => {
		const path = writeToml(`
[env]
version = "1.0.0"

[policy]
default_unknown = "block"
approval_method = "web"
`);

		await expect(loadManifest(path)).rejects.toThrow('env.name');
	});

	test('missing env.version', async () => {
		const path = writeToml(`
[env]
name = "test"

[policy]
default_unknown = "block"
approval_method = "web"
`);

		await expect(loadManifest(path)).rejects.toThrow('env.version');
	});

	test('missing env.timeout', async () => {
		const path = writeToml(`
[env]
name = "test"
version = "1.0.0"

[policy]
default_unknown = "block"
approval_method = "web"
`);

		await expect(loadManifest(path)).rejects.toThrow('env.timeout');
	});

	test('invalid default_unknown value', async () => {
		const path = writeToml(`
[env]
name = "test"
version = "1.0.0"
timeout = 5

[policy]
default_unknown = "yolo"
approval_method = "web"
`);

		await expect(loadManifest(path)).rejects.toThrow('default_unknown');
	});

	test('requires an unknown fallback and validates classification defaults', async () => {
		const missingFallback = writeToml(`
[env]
name = "test"
version = "1.0.0"
timeout = 5
[policy]
approval_method = "web"
[policy.defaults]
readonly = "allow"
`);
		await expect(loadManifest(missingFallback)).rejects.toThrow('defaults.unknown is required');

		const unknownClassification = writeToml(`
[env]
name = "test"
version = "1.0.0"
timeout = 5
[policy]
default_unknown = "block"
approval_method = "web"
[policy.defaults]
safe = "allow"
`);
		await expect(loadManifest(unknownClassification)).rejects.toThrow('unknown classification "safe"');

		const invalidDecision = writeToml(`
[env]
name = "test"
version = "1.0.0"
timeout = 5
[policy]
default_unknown = "block"
approval_method = "web"
[policy.defaults]
readonly = "ask"
`);
		await expect(loadManifest(invalidDecision)).rejects.toThrow('defaults.readonly');
	});

	test('invalid approval_method value', async () => {
		const path = writeToml(`
[env]
name = "test"
version = "1.0.0"
timeout = 5

[policy]
default_unknown = "block"
approval_method = "slack"
`);

		await expect(loadManifest(path)).rejects.toThrow('approval_method');
	});

	test('invalid rule decision value', async () => {
		const path = writeToml(`
[env]
name = "test"
version = "1.0.0"
timeout = 5

[policy]
default_unknown = "block"
approval_method = "web"

[rules]
"rm *" = "yeet"
`);

		await expect(loadManifest(path)).rejects.toThrow('rm *');
	});

	test('nested rule table rejected', async () => {
		const path = writeToml(`
[env]
name = "test"
version = "1.0.0"
timeout = 5

[policy]
default_unknown = "block"
approval_method = "web"

[rules]
[rules.nested]
"rm *" = "block"
`);

		await expect(loadManifest(path)).rejects.toThrow('nested');
	});

	test('nonexistent manifest file', async () => {
		await expect(loadManifest('/nonexistent/path/umbod.toml')).rejects.toThrow('failed to read');
	});

	test('invalid TOML syntax', async () => {
		const path = writeToml('this is not valid toml [[[');

		await expect(loadManifest(path)).rejects.toThrow('failed to parse');
	});

	test('rejects duplicate workspace ids and roots', async () => {
		const duplicateId = writeToml(`
[env]
name = "test"
version = "1.0.0"
timeout = 5
[policy]
default_unknown = "block"
approval_method = "web"
[[workspaces]]
id = "same"
[[workspaces]]
id = "same"
`);
		await expect(loadManifest(duplicateId)).rejects.toThrow('duplicated');

		const duplicateRoot = writeToml(`
[env]
name = "test"
version = "1.0.0"
timeout = 5
[policy]
default_unknown = "block"
approval_method = "web"
[[workspaces]]
id = "one"
roots = ["C:\\\\Work\\\\Repo"]
[[workspaces]]
id = "two"
roots = ["c:/work/repo"]
`);
		await expect(loadManifest(duplicateRoot)).rejects.toThrow('root is duplicated');
	});

	test('rejects relative workspace roots and invalid workspace decisions', async () => {
		const relativeRoot = writeToml(`
[env]
name = "test"
version = "1.0.0"
timeout = 5
[policy]
default_unknown = "block"
approval_method = "web"
[[workspaces]]
id = "bad"
roots = ["relative/path"]
`);
		await expect(loadManifest(relativeRoot)).rejects.toThrow('must be absolute');

		const invalidDecision = writeToml(`
[env]
name = "test"
version = "1.0.0"
timeout = 5
[policy]
default_unknown = "block"
approval_method = "web"
[[workspaces]]
id = "bad"
default_unknown = "ask"
`);
		await expect(loadManifest(invalidDecision)).rejects.toThrow('default_unknown');
	});

	test('rejects malformed workspace rules values', async () => {
		const path = writeToml(`
[env]
name = "test"
version = "1.0.0"
timeout = 5
[policy]
default_unknown = "block"
approval_method = "web"
[[workspaces]]
id = "bad"
rules = "block"
`);
		await expect(loadManifest(path)).rejects.toThrow('workspace "bad".rules must be a table');
	});
});
