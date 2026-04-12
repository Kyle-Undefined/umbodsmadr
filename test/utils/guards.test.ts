import { describe, expect, test } from 'bun:test';
import { isRecord } from '../../src/utils/guards.ts';

describe('isRecord', () => {
	test('plain object → true', () => {
		expect(isRecord({})).toBe(true);
		expect(isRecord({ key: 'value' })).toBe(true);
	});

	test('null → false', () => {
		expect(isRecord(null)).toBe(false);
	});

	test('array → false', () => {
		expect(isRecord([])).toBe(false);
		expect(isRecord([1, 2, 3])).toBe(false);
	});

	test('primitives → false', () => {
		expect(isRecord('string')).toBe(false);
		expect(isRecord(42)).toBe(false);
		expect(isRecord(true)).toBe(false);
		expect(isRecord(undefined)).toBe(false);
	});
});
