import { describe, expect, test } from 'bun:test';

import { normalizeSearchText, quoteFts5Literal } from '../../src/utils/search.ts';

describe('search text normalization', () => {
	test('folds case, accents, and canonically equivalent combining marks', () => {
		expect(normalizeSearchText('Grímr CAFÉ')).toBe('grimr cafe');
		expect(normalizeSearchText('Cafe\u0301')).toBe(normalizeSearchText('Café'));
	});

	test('applies compatibility decomposition before removing combining marks', () => {
		expect(normalizeSearchText('oﬃce')).toBe('office');
		expect(normalizeSearchText('İ')).toBe('i');
	});

	test('folds Latin letters that NFKD does not decompose', () => {
		expect(normalizeSearchText('Æ Ð Đ Ħ ı Ł Ŋ Ø Œ ẞ Ŧ Þ')).toBe('ae d d h i l n o oe ss t th');
	});
});

describe('FTS5 literal quoting', () => {
	test('wraps text as one quoted literal', () => {
		expect(quoteFts5Literal('foo OR bar')).toBe('"foo OR bar"');
	});

	test('escapes embedded double quotes by doubling them', () => {
		expect(quoteFts5Literal('say "hello"')).toBe('"say ""hello"""');
		expect(quoteFts5Literal('"')).toBe('""""');
	});
});
