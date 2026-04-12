import { describe, expect, test } from 'bun:test';
import { matchesPattern, findMatchingRule } from '../../src/policy/rule-matcher.ts';

// ── Glob matching ────────────────────────────────────────────

describe('matchesPattern > glob', () => {
	test('exact match', () => {
		expect(matchesPattern('git status', 'git status')).toBe(true);
		expect(matchesPattern('git status', 'git log')).toBe(false);
	});

	test('trailing wildcard', () => {
		expect(matchesPattern('git log --oneline', 'git log *')).toBe(true);
		expect(matchesPattern('git log', 'git log *')).toBe(true);
		expect(matchesPattern('git status', 'git log *')).toBe(false);
	});

	test('leading wildcard', () => {
		expect(matchesPattern('git push --force', '* --force')).toBe(true);
		expect(matchesPattern('rm -rf --force', '* --force')).toBe(true);
		expect(matchesPattern('git push', '* --force')).toBe(false);
	});

	test('middle wildcard', () => {
		expect(matchesPattern('git push origin main', 'git * main')).toBe(true);
		expect(matchesPattern('git rebase main', 'git * main')).toBe(true);
		expect(matchesPattern('git push origin dev', 'git * main')).toBe(false);
	});

	test('multiple wildcards', () => {
		expect(matchesPattern('a b c d', 'a * c *')).toBe(true);
		expect(matchesPattern('a xyz c end', 'a * c *')).toBe(true);
	});

	test('wildcard matches empty string', () => {
		expect(matchesPattern('git log', 'git log*')).toBe(true);
		expect(matchesPattern('git log --all', 'git log*')).toBe(true);
	});

	test('pattern with no wildcard requires exact match', () => {
		expect(matchesPattern('git status', 'git status')).toBe(true);
		expect(matchesPattern('git status --short', 'git status')).toBe(false);
	});
});

// ── Regex matching ───────────────────────────────────────────

describe('matchesPattern > regex', () => {
	test('simple regex', () => {
		expect(matchesPattern('rm -rf /tmp', '/^rm/')).toBe(true);
		expect(matchesPattern('ls -la', '/^rm/')).toBe(false);
	});

	test('regex with flags', () => {
		expect(matchesPattern('RM -rf /tmp', '/^rm/i')).toBe(true);
		expect(matchesPattern('RM -rf /tmp', '/^rm/')).toBe(false);
	});

	test('complex regex — dotfile detection', () => {
		const pattern = '/^\\w+\\s+\\.[^\\s\\/]+/';
		expect(matchesPattern('cat .env', pattern)).toBe(true);
		expect(matchesPattern('cat .ssh/config', pattern)).toBe(true);
		expect(matchesPattern('ls normal_file', pattern)).toBe(false);
	});

	test('regex anchored to full line', () => {
		expect(matchesPattern('rm -rf /', '/^rm\\s+-rf\\s+\\/$/')).toBe(true);
		expect(matchesPattern('rm -rf / --yes', '/^rm\\s+-rf\\s+\\/$/')).toBe(false);
	});

	test('partial regex match (no anchors)', () => {
		expect(matchesPattern('the secret word', '/secret/')).toBe(true);
		expect(matchesPattern('no match here', '/secret/')).toBe(false);
	});

	test("invalid regex doesn't throw, returns false", () => {
		expect(matchesPattern('anything', '/[invalid/')).toBe(false);
	});

	test('regex-like string not enclosed in slashes treated as glob', () => {
		// No leading/trailing slash — treated as glob, not regex
		expect(matchesPattern('^rm', '^rm')).toBe(true);
		expect(matchesPattern('rm -rf', '^rm')).toBe(false);
	});
});

// ── findMatchingRule ─────────────────────────────────────────

describe('findMatchingRule', () => {
	const rules = {
		'git status': 'allow' as const,
		'git log *': 'allow' as const,
		'rm *': 'approve' as const,
		'* --force': 'approve' as const,
		'/^curl\\s/': 'block' as const,
	};

	test('returns first matching rule', () => {
		const result = findMatchingRule('git status', rules);
		expect(result).toEqual(['git status', 'allow']);
	});

	test('wildcard rule matches', () => {
		const result = findMatchingRule('git log --oneline -5', rules);
		expect(result).toEqual(['git log *', 'allow']);
	});

	test('regex rule matches', () => {
		const result = findMatchingRule('curl https://example.com', rules);
		expect(result).toEqual(['/^curl\\s/', 'block']);
	});

	test('returns undefined when no rule matches', () => {
		const result = findMatchingRule('npm install', rules);
		expect(result).toBeUndefined();
	});

	test('first match wins (rule order matters)', () => {
		const orderedRules = {
			'rm *': 'approve' as const,
			'rm -rf *': 'block' as const,
		};
		// "rm -rf /tmp" matches "rm *" first
		const result = findMatchingRule('rm -rf /tmp', orderedRules);
		expect(result).toEqual(['rm *', 'approve']);
	});
});
