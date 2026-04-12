import { describe, expect, test } from 'bun:test';
import { errorMessage } from '../../src/utils/errors.ts';

describe('errorMessage', () => {
	test('Error instance → message', () => {
		expect(errorMessage(new Error('something broke'))).toBe('something broke');
	});

	test('string → string', () => {
		expect(errorMessage('raw string error')).toBe('raw string error');
	});

	test('number → stringified', () => {
		expect(errorMessage(42)).toBe('42');
	});

	test('null → stringified', () => {
		expect(errorMessage(null)).toBe('null');
	});

	test('undefined → stringified', () => {
		expect(errorMessage(undefined)).toBe('undefined');
	});

	test('object → stringified', () => {
		expect(errorMessage({ code: 500 })).toBe('[object Object]');
	});
});
