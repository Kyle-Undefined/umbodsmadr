import { describe, expect, test } from 'bun:test';
import { affectedPaths, ruleMatchCandidates, looksLikeFilePath } from '../../src/policy/rule-candidates.ts';
import { makeCall } from '../helpers.ts';

// ── looksLikeFilePath ───────────────────────────────────────

describe('looksLikeFilePath', () => {
	test('absolute paths', () => {
		expect(looksLikeFilePath('/etc/passwd')).toBe(true);
		expect(looksLikeFilePath('/home/user/.bashrc')).toBe(true);
	});

	test('relative paths', () => {
		expect(looksLikeFilePath('./src/index.ts')).toBe(true);
		expect(looksLikeFilePath('../parent/file.txt')).toBe(true);
		expect(looksLikeFilePath('src/index.ts')).toBe(true);
	});

	test('paths containing /.', () => {
		expect(looksLikeFilePath('src/.env')).toBe(true);
		expect(looksLikeFilePath('project/.git/config')).toBe(true);
	});

	test('dotfiles starting with .', () => {
		expect(looksLikeFilePath('.env')).toBe(true);
		expect(looksLikeFilePath('.gitignore')).toBe(true);
	});

	test('Windows paths', () => {
		expect(looksLikeFilePath('C:\\Users\\test')).toBe(true);
		expect(looksLikeFilePath('D:/documents/file.txt')).toBe(true);
	});

	test('non-path strings', () => {
		expect(looksLikeFilePath('hello world')).toBe(false);
		expect(looksLikeFilePath('npm install')).toBe(false);
		expect(looksLikeFilePath('git status')).toBe(false);
	});

	test('empty and oversized strings', () => {
		expect(looksLikeFilePath('')).toBe(false);
		expect(looksLikeFilePath('  ')).toBe(false);
		expect(looksLikeFilePath('x'.repeat(9000))).toBe(false);
	});

	test('does not treat multiline document or patch content as one affected path', () => {
		expect(looksLikeFilePath('policy documentation\nmentions /repo/.env without accessing it')).toBe(false);
		expect(
			affectedPaths({
				agent: 'codex',
				tool: 'edit',
				command: '*** Begin Patch\n*** Update File: /repo/policy.ts\n+const example = "/repo/.env";\n*** End Patch',
				inputs: {},
				timestamp: '2026-08-27T00:00:00.000Z',
			})
		).toEqual([{ path: '/repo/policy.ts', access: 'write', source: 'apply-patch' }]);
	});

	test('does not treat an entire shell command containing a dot-path as an affected path', () => {
		expect(
			affectedPaths({
				agent: 'codex',
				tool: 'bash',
				command: 'bun -e \'console.log("/repo/.env")\'',
				inputs: { command: 'bun -e \'console.log("/repo/.env")\'' },
				timestamp: '2026-08-27T00:00:00.000Z',
			})
		).toEqual([]);
	});
});

describe('affectedPaths', () => {
	test('extracts every apply_patch target with access provenance', () => {
		const paths = affectedPaths(
			makeCall({
				tool: 'edit',
				command:
					'*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: C:\\work\\b.ts\n*** Delete File: old/c.ts\n*** End Patch',
			})
		);
		expect(paths).toContainEqual({ path: 'src/a.ts', access: 'write', source: 'apply-patch' });
		expect(paths).toContainEqual({ path: 'C:/work/b.ts', access: 'write', source: 'apply-patch' });
		expect(paths).toContainEqual({ path: 'old/c.ts', access: 'delete', source: 'apply-patch' });
	});

	test('extracts provider multi-file inputs and reliable shell redirections', () => {
		const provider = affectedPaths(
			makeCall({ tool: 'edit', command: 'edit', inputs: { tool_input: { paths: ['src/a.ts', 'src/b.ts'] } } })
		);
		expect(provider.map((entry) => entry.path)).toEqual(['src/a.ts', 'src/b.ts']);
		expect(affectedPaths(makeCall({ tool: 'bash', command: 'printf ok > ./out.txt' }))).toContainEqual({
			path: './out.txt',
			access: 'write',
			source: 'shell-redirection',
		});
	});
});

// ── ruleMatchCandidates ──────────────────────────────────────

describe('ruleMatchCandidates', () => {
	test('command is always first candidate', () => {
		const candidates = ruleMatchCandidates(makeCall({ command: 'git status' }));
		expect(candidates[0]).toBe('git status');
	});

	test('deduplicates command', () => {
		const candidates = ruleMatchCandidates(makeCall({ command: 'git status' }));
		const count = candidates.filter((c) => c === 'git status').length;
		expect(count).toBe(1);
	});

	test('extracts path-like strings from tool_input in inputs', () => {
		const candidates = ruleMatchCandidates(
			makeCall({
				tool: 'read',
				command: 'read /home/user/.env',
				inputs: {
					tool_input: {
						file_path: '/home/user/.env',
					},
				},
			})
		);
		expect(candidates).toContain('read /home/user/.env');
	});

	test('extracts from toolInput (camelCase variant)', () => {
		const candidates = ruleMatchCandidates(
			makeCall({
				tool: 'grep',
				command: 'grep pattern',
				inputs: {
					toolInput: {
						path: '/home/user/.secrets',
					},
				},
			})
		);
		expect(candidates).toContain('grep /home/user/.secrets');
	});

	test('prefixes paths with tool name', () => {
		const candidates = ruleMatchCandidates(
			makeCall({
				tool: 'Read',
				command: 'Read /tmp/file',
				inputs: {
					tool_input: {
						file_path: '/etc/shadow',
					},
				},
			})
		);
		// Tool name is lowercased when prefixed
		expect(candidates).toContain('read /etc/shadow');
	});

	test('ignores non-path strings in inputs', () => {
		const candidates = ruleMatchCandidates(
			makeCall({
				tool: 'bash',
				command: 'echo hello',
				inputs: {
					tool_input: {
						command: 'echo hello',
						some_flag: 'true',
					},
				},
			})
		);
		// "echo hello" and "true" are not path-like, should not generate extra candidates
		expect(candidates).toEqual(['echo hello']);
	});

	test('handles missing inputs gracefully', () => {
		const candidates = ruleMatchCandidates(makeCall({ command: 'ls' }));
		expect(candidates).toEqual(['ls']);
	});

	test('handles deeply nested inputs up to depth limit', () => {
		const deepInput: Record<string, unknown> = { file_path: '/deep/path' };
		let current: Record<string, unknown> = deepInput;
		for (let i = 0; i < 15; i++) {
			const next: Record<string, unknown> = { nested: current };
			current = next;
		}

		const candidates = ruleMatchCandidates(
			makeCall({
				tool: 'read',
				command: 'read something',
				inputs: { tool_input: current },
			})
		);
		// The deeply nested path should be truncated by MAX_DEPTH
		// Command should still be there
		expect(candidates[0]).toBe('read something');
	});
});
