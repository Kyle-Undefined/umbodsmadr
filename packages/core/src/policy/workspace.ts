import path from 'node:path';

import type { Manifest, ToolCall, WorkspaceConfig } from '../core/types.ts';

export type WorkspaceResolutionSource = 'explicit' | 'root' | 'global' | 'unresolved';

export interface WorkspaceResolution {
	workspace?: WorkspaceConfig;
	source: WorkspaceResolutionSource;
	requestedWorkspaceId?: string;
}

export function isAbsoluteWorkspaceRoot(value: string): boolean {
	const normalized = value.trim().replaceAll('\\', '/');
	return normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized);
}

/**
 * Normalize paths lexically for stable manifest matching without touching the
 * filesystem. Windows drive and UNC paths compare case-insensitively; POSIX
 * paths retain case.
 */
export function normalizeWorkspaceRoot(value: string): string {
	const slashed = value.trim().replaceAll('\\', '/');
	if (slashed.length === 0) return '';
	const windowsLike = /^[a-zA-Z]:\//.test(slashed) || slashed.startsWith('//');
	let normalized = windowsLike ? path.win32.normalize(slashed).replaceAll('\\', '/') : path.posix.normalize(slashed);
	if (normalized.length > 1 && normalized.endsWith('/') && !/^[a-zA-Z]:\/$/.test(normalized)) {
		normalized = normalized.slice(0, -1);
	}
	return windowsLike ? normalized.toLowerCase() : normalized;
}

function pathWithinRoot(candidate: string, root: string): boolean {
	return candidate === root || candidate.startsWith(root.endsWith('/') ? root : `${root}/`);
}

export function isPathWithinWorkspaceRoot(value: string, root: string): boolean {
	return pathWithinRoot(normalizeWorkspaceRoot(value), normalizeWorkspaceRoot(root));
}

function workspaceForRoot(manifest: Manifest, workingDirectory: string | undefined): WorkspaceConfig | undefined {
	if (!workingDirectory?.trim()) return undefined;
	const candidate = normalizeWorkspaceRoot(workingDirectory);
	let selected: { workspace: WorkspaceConfig; length: number } | undefined;

	for (const workspace of manifest.workspaces ?? []) {
		for (const root of workspace.roots) {
			const normalizedRoot = normalizeWorkspaceRoot(root);
			if (!pathWithinRoot(candidate, normalizedRoot)) continue;
			if (!selected || normalizedRoot.length > selected.length) {
				selected = { workspace, length: normalizedRoot.length };
			}
		}
	}

	return selected?.workspace;
}

/**
 * Resolve a tool call to a configured workspace.
 *
 * A known explicit ID wins. An unknown explicit ID falls back to the longest
 * matching working-directory root while retaining the requested ID for audit
 * telemetry. If neither resolves, the result remains unresolved so the policy
 * engine can fail closed and report the unknown ID.
 */
export function resolveWorkspace(
	manifest: Manifest,
	call: Pick<ToolCall, 'workspaceId' | 'workingDirectory'>
): WorkspaceResolution {
	const requestedWorkspaceId = call.workspaceId?.trim();
	if (requestedWorkspaceId) {
		const workspace = manifest.workspaces?.find((entry) => entry.id === requestedWorkspaceId);
		if (workspace) return { workspace, source: 'explicit', requestedWorkspaceId };
	}

	const workspace = workspaceForRoot(manifest, call.workingDirectory);
	if (workspace) {
		return requestedWorkspaceId ? { workspace, source: 'root', requestedWorkspaceId } : { workspace, source: 'root' };
	}

	return requestedWorkspaceId ? { source: 'unresolved', requestedWorkspaceId } : { source: 'global' };
}
