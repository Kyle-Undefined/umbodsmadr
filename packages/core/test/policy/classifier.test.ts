import { describe, expect, test } from 'bun:test';
import { classifyToolCall } from '../../src/policy/classifier.ts';
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

		// Command substitution
		['echo $(whoami)', '$() substitution'],
		['echo `date`', 'backtick substitution'],

		// Dynamic execution
		["eval 'rm -rf /'", 'eval'],
		["find . -name '*.log' | xargs rm", 'xargs'],
		["sh -c 'echo hello'", 'sh -c'],
		["bash -c 'echo hello'", 'bash -c'],

		// Pipe-to-writer commands
		['echo foo | tee output.txt', 'tee'],
		['dd if=/dev/zero of=file bs=1M count=1', 'dd'],

		// find with exec/delete
		["find . -name '*.tmp' -exec rm {} ;", 'find -exec'],
		["find . -name '*.tmp' -execdir rm {} +", 'find -execdir'],
		["find . -name '*.tmp' -delete", 'find -delete'],
		["find . -name '*.log' -fprint /tmp/logs", 'find -fprint'],

		// Compound commands
		['echo hello | cat', 'pipe'],
		['echo hello; echo world', 'semicolon chain'],
		['true && rm -f file', '&& chain'],

		// Shell flow control
		['while read line; do echo $line; done', 'while loop'],
		['for f in *.txt; do cat $f; done', 'for loop'],
		['if true; then echo yes; fi', 'if statement'],
		['case $x in a) echo a;; esac', 'case statement'],

		// Interpreters
		['python3 script.py', 'python3'],
		['python script.py', 'python'],
		["perl -e 'print 1'", 'perl'],
		["ruby -e 'puts 1'", 'ruby'],
		['node script.js', 'node'],
		['deno run script.ts', 'deno'],
		['bun run script.ts', 'bun'],

		// Brace expansion
		['echo {a,b,c}', 'brace expansion'],
		['cat {.,}secret', 'brace expansion dotfile bypass'],

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
		// "ls" is readonly, but piping makes it destructive
		expect(classifyToolCall(makeCall({ command: 'ls | wc -l' }))).toBe('destructive');
	});

	test('destructive wins over external when both match', () => {
		// "curl" is external, but $() makes it destructive first
		expect(classifyToolCall(makeCall({ command: 'curl $(cat /etc/passwd)' }))).toBe('destructive');
	});
});
