import { describe, expect, test } from 'bun:test';
import { classifyToolCall } from '../../src/policy/classifier.ts';
import { analyzeShellCommand } from '../../src/policy/shell-analyzer.ts';
import { makeCall } from '../helpers.ts';

// ── Readonly bash commands ───────────────────────────────────

describe('classifier > readonly bash', () => {
	const readonlyCommands = [
		'git status',
		'git diff HEAD',
		'git diff --staged',
		'git log --oneline',
		'git log -5',
		'ls',
		'ls -la',
		'ls /tmp',
		'cat',
		'cat README.md',
		'cat /etc/hostname',
		'pwd',
		'find',
		"find . -name '*.ts'",
	];

	for (const command of readonlyCommands) {
		test(`"${command}" → readonly`, () => {
			expect(classifyToolCall(makeCall({ command }))).toBe('readonly');
		});
	}
});

// ── Destructive bash commands ────────────────────────────────

describe('classifier > destructive bash', () => {
	const destructiveCommands: [string, string][] = [
		// File operations
		['rm file.txt', 'rm'],
		['rm -rf /tmp/junk', 'rm -rf'],
		['/usr/bin/rm foo', 'absolute path rm'],
		['mv old.txt new.txt', 'mv'],
		['/bin/mv a b', 'absolute path mv'],
		['chmod 755 script.sh', 'chmod'],
		['chown root:root file', 'chown'],
		['truncate -s 0 log.txt', 'truncate'],
		['cp src dest', 'cp'],
		['/usr/bin/cp a b', 'absolute path cp'],
		['install -m 755 bin /usr/local/bin', 'install'],
		['ln -s target link', 'ln'],

		// Git write operations
		['git push origin main', 'git push'],
		['git reset --hard HEAD~1', 'git reset'],
		['git clean -fd', 'git clean'],

		// Redirects
		['echo hello > file.txt', 'output redirect'],
		['echo hello >> file.txt', 'append redirect'],
		['sort < input.txt > output.txt', 'input+output redirect'],

		// Explicit dynamic writers
		["find . -name '*.log' | xargs rm", 'xargs'],

		// Pipe-to-writer commands
		['echo foo | tee output.txt', 'tee'],
		['dd if=/dev/zero of=file bs=1M count=1', 'dd'],

		// find with exec/delete
		["find . -name '*.tmp' -exec rm {} \\;", 'find -exec'],
		["find . -name '*.tmp' -execdir rm {} +", 'find -execdir'],
		["find . -name '*.tmp' -delete", 'find -delete'],
		["find . -name '*.log' -fprint /tmp/logs", 'find -fprint'],

		// Compound command containing a destructive component
		['true && rm -f file', '&& chain'],

		// --output flag
		['git format-patch --output=/tmp/patch HEAD~1', '--output flag'],

		// install (system command that writes files)
		['npm install', 'npm install'],
		['npm install lodash', 'npm install with arg'],
	];

	for (const [command, label] of destructiveCommands) {
		test(`"${command}" → destructive (${label})`, () => {
			expect(classifyToolCall(makeCall({ command }))).toBe('destructive');
		});
	}
});

// ── Destructive patterns should NOT false-positive on safe commands ──

describe('classifier > destructive false-positive guards', () => {
	const safeCommands: [string, string][] = [
		// "rm" as substring in non-destructive contexts
		['git log --format=short', 'format contains rm as substring'],
		// /dev/null redirect is explicitly excluded
		['command > /dev/null', 'redirect to /dev/null'],
		['command >/dev/null 2>&1', 'redirect to /dev/null variant'],
	];

	for (const [command, label] of safeCommands) {
		test(`"${command}" is NOT destructive (${label})`, () => {
			const result = classifyToolCall(makeCall({ command }));
			expect(result).not.toBe('destructive');
		});
	}
});

// ── External bash commands ───────────────────────────────────

describe('classifier > external bash', () => {
	const externalCommands: [string, string][] = [
		['curl https://example.com', 'curl'],
		['/usr/bin/curl -s https://example.com', 'absolute path curl'],
		['wget https://example.com/file.tar.gz', 'wget'],
		['/usr/bin/wget -q https://example.com', 'absolute path wget'],
		['gh pr list', 'gh'],
		['npm publish', 'npm publish'],
		['scp file.txt user@host:/path', 'scp'],
		["ssh user@host 'ls'", 'ssh'],
	];

	for (const [command, label] of externalCommands) {
		test(`"${command}" → external (${label})`, () => {
			expect(classifyToolCall(makeCall({ command }))).toBe('external');
		});
	}
});

// ── Stateful bash (catch-all for unmatched bash) ─────────────

describe('classifier > stateful bash', () => {
	const statefulCommands = ['mkdir -p /tmp/test', 'touch file.txt', 'git add .', "git commit -m 'test'", 'cargo build'];

	for (const command of statefulCommands) {
		test(`"${command}" → stateful`, () => {
			expect(classifyToolCall(makeCall({ command }))).toBe('stateful');
		});
	}
});

describe('classifier > bounded shell analysis', () => {
	test('evaluates every supported compound component and chooses the strictest classification', () => {
		expect(classifyToolCall(makeCall({ command: 'git status && git log -1' }))).toBe('readonly');
		expect(classifyToolCall(makeCall({ command: 'git status; cargo build' }))).toBe('stateful');
		expect(classifyToolCall(makeCall({ command: 'git status | curl https://example.com' }))).toBe('external');
		expect(classifyToolCall(makeCall({ command: 'git status && rm file' }))).toBe('destructive');
	});

	test('exposes bounded component analysis for hosts and diagnostics', () => {
		expect(analyzeShellCommand('git status && curl https://example.com')).toEqual({
			components: [
				{ command: 'git status', classification: 'readonly' },
				{ command: 'curl https://example.com', classification: 'external' },
			],
			compound: true,
			classification: 'external',
		});
	});

	test('does not split separators inside quoted arguments', () => {
		expect(classifyToolCall(makeCall({ command: `printf 'a;b|c'` }))).toBe('stateful');
	});

	test('fails ambiguous or unsupported shell syntax to unknown', () => {
		for (const command of [
			'echo $(whoami)',
			'echo `date`',
			"eval 'rm -rf /'",
			"bash -c 'echo hello'",
			'python3 script.py',
			'while read line; do echo $line; done',
			'echo {a,b,c}',
			"echo 'unterminated",
		]) {
			expect(classifyToolCall(makeCall({ command }))).toBe('unknown');
		}
	});
});

// ── Non-bash tool classification ─────────────────────────────

describe('classifier > non-bash tools', () => {
	test('read tools → readonly', () => {
		expect(classifyToolCall(makeCall({ tool: 'Read', command: '/tmp/file.txt' }))).toBe('readonly');
		expect(classifyToolCall(makeCall({ tool: 'Grep', command: 'pattern' }))).toBe('readonly');
		expect(classifyToolCall(makeCall({ tool: 'Glob', command: '**/*.ts' }))).toBe('readonly');
		expect(classifyToolCall(makeCall({ tool: 'list', command: '/tmp' }))).toBe('readonly');
		expect(classifyToolCall(makeCall({ tool: 'search', command: 'query' }))).toBe('readonly');
	});

	test('write/edit tools → destructive', () => {
		expect(classifyToolCall(makeCall({ tool: 'Write', command: '/tmp/file.txt' }))).toBe('destructive');
		expect(classifyToolCall(makeCall({ tool: 'Edit', command: '/tmp/file.txt' }))).toBe('destructive');
		expect(classifyToolCall(makeCall({ tool: 'delete', command: '/tmp/file.txt' }))).toBe('destructive');
		expect(classifyToolCall(makeCall({ tool: 'apply', command: 'patch' }))).toBe('destructive');
	});

	test('web tools → external', () => {
		expect(classifyToolCall(makeCall({ tool: 'WebFetch', command: 'https://example.com' }))).toBe('external');
		expect(classifyToolCall(makeCall({ tool: 'WebSearch', command: 'query' }))).toBe('external');
	});

	test('unknown tools → unknown', () => {
		expect(classifyToolCall(makeCall({ tool: 'SomethingNew', command: 'test' }))).toBe('unknown');
		expect(classifyToolCall(makeCall({ tool: 'Agent', command: 'task' }))).toBe('unknown');
	});
});

// ── Priority: destructive checked before readonly ────────────

describe('classifier > priority ordering', () => {
	test('destructive wins over readonly prefix', () => {
		// The unknown writer-free component is stateful, stricter than readonly.
		expect(classifyToolCall(makeCall({ command: 'ls | wc -l' }))).toBe('stateful');
	});

	test('destructive wins over external when both match', () => {
		// Ambiguous substitution fails to unknown instead of guessing.
		expect(classifyToolCall(makeCall({ command: 'curl $(cat /etc/passwd)' }))).toBe('unknown');
	});
});
