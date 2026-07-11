import { describe, expect, test } from 'bun:test';
import { PolicyEngine } from '../../src/policy/engine.ts';
import { makeCall, makeManifest } from '../helpers.ts';

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
