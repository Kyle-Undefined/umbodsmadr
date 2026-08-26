import { describe, expect, test } from 'bun:test';
import { makeCall, makeManifest } from '../helpers.ts';
import { isAbsoluteWorkspaceRoot, normalizeWorkspaceRoot, resolveWorkspace } from '../../src/policy/workspace.ts';

const workspaces = [
	{
		id: 'repo',
		roots: ['/work/repo'],
		rules: {},
	},
	{
		id: 'package',
		roots: ['/work/repo/packages/app'],
		rules: {},
	},
	{
		id: 'windows',
		roots: ['C:\\Work\\Client'],
		rules: {},
	},
	{
		id: 'unc',
		roots: ['\\\\server\\share\\repo'],
		rules: {},
	},
	{
		id: 'wsl-unc',
		roots: ['\\\\wsl.localhost\\Ubuntu-24.04\\home\\kyle\\development\\repos\\hlid'],
		rules: {},
	},
];

describe('workspace path normalization', () => {
	test('normalizes separators and lexical segments', () => {
		expect(normalizeWorkspaceRoot('/work/repo/./packages/../src/')).toBe('/work/repo/src');
		expect(normalizeWorkspaceRoot('C:\\Work\\Client\\src')).toBe('c:/work/client/src');
	});

	test('clamps parent traversal at Windows drive and UNC share anchors', () => {
		expect(normalizeWorkspaceRoot('C:/../../Work/Client/src')).toBe('c:/work/client/src');
		expect(normalizeWorkspaceRoot('\\\\server\\share\\..\\repo\\src')).toBe('//server/share/repo/src');
	});

	test('recognizes POSIX, drive, and UNC roots', () => {
		expect(isAbsoluteWorkspaceRoot('/work/repo')).toBe(true);
		expect(isAbsoluteWorkspaceRoot('C:\\work\\repo')).toBe(true);
		expect(isAbsoluteWorkspaceRoot('\\\\server\\share\\repo')).toBe(true);
		expect(isAbsoluteWorkspaceRoot('work/repo')).toBe(false);
	});
});

describe('workspace resolution', () => {
	const manifest = makeManifest({ workspaces });

	test('explicit id takes precedence over cwd', () => {
		const result = resolveWorkspace(
			manifest,
			makeCall({ workspaceId: 'repo', workingDirectory: '/work/repo/packages/app' })
		);
		expect(result.workspace?.id).toBe('repo');
		expect(result.source).toBe('explicit');
	});

	test('unknown explicit id falls back to cwd and retains the requested id', () => {
		const result = resolveWorkspace(manifest, makeCall({ workspaceId: 'missing', workingDirectory: '/work/repo' }));
		expect(result.workspace?.id).toBe('repo');
		expect(result.requestedWorkspaceId).toBe('missing');
		expect(result.source).toBe('root');
	});

	test('unknown explicit id remains unresolved when cwd does not match', () => {
		const result = resolveWorkspace(manifest, makeCall({ workspaceId: 'missing', workingDirectory: '/other' }));
		expect(result.workspace).toBeUndefined();
		expect(result.requestedWorkspaceId).toBe('missing');
		expect(result.source).toBe('unresolved');
	});

	test('longest matching root wins', () => {
		const result = resolveWorkspace(manifest, makeCall({ workingDirectory: '/work/repo/packages/app/src' }));
		expect(result.workspace?.id).toBe('package');
		expect(result.source).toBe('root');
	});

	test('Windows paths match case-insensitively', () => {
		const result = resolveWorkspace(manifest, makeCall({ workingDirectory: 'c:/work/CLIENT/src' }));
		expect(result.workspace?.id).toBe('windows');
	});

	test('wsl.localhost UNC paths resolve with either slash style and case', () => {
		expect(
			resolveWorkspace(
				manifest,
				makeCall({ workingDirectory: '\\\\WSL.LOCALHOST\\Ubuntu-24.04\\home\\kyle\\development\\repos\\hlid\\src' })
			).workspace?.id
		).toBe('wsl-unc');
		expect(
			resolveWorkspace(
				manifest,
				makeCall({ workingDirectory: '//wsl.localhost/Ubuntu-24.04/home/kyle/development/repos/hlid/src' })
			).workspace?.id
		).toBe('wsl-unc');
	});

	test('Windows drive and UNC traversal spellings cannot bypass root matching', () => {
		expect(resolveWorkspace(manifest, makeCall({ workingDirectory: 'C:/../../Work/Client/src' })).workspace?.id).toBe(
			'windows'
		);
		expect(
			resolveWorkspace(manifest, makeCall({ workingDirectory: '\\\\server\\share\\..\\repo\\src' })).workspace?.id
		).toBe('unc');
	});

	test('unmatched calls remain global', () => {
		expect(resolveWorkspace(manifest, makeCall({ workingDirectory: '/other' })).source).toBe('global');
	});
});
