import { isPathWithinWorkspaceRoot, normalizeWorkspaceRoot } from '../policy/workspace.ts';
import type { SessionLogSource } from './types.ts';

function longestMatchingRoot(cwd: string, roots: string[] | undefined): number | undefined {
	let longest: number | undefined;
	for (const root of roots ?? []) {
		if (!isPathWithinWorkspaceRoot(cwd, root)) continue;
		const length = normalizeWorkspaceRoot(root).length;
		if (longest === undefined || length > longest) longest = length;
	}
	return longest;
}

export function sessionSourceMatchesCwd(source: SessionLogSource, cwd: string | undefined): boolean {
	if (source.project !== undefined && cwd !== source.project) return false;
	if (cwd === undefined) {
		return (
			source.project === undefined &&
			(!source.projectRoots || source.projectRoots.length === 0) &&
			(!source.projectRootExclusions || source.projectRootExclusions.length === 0) &&
			(!source.scopeProjectRoots || source.scopeProjectRoots.length === 0)
		);
	}
	if (source.projectRootExclusions?.some((root) => isPathWithinWorkspaceRoot(cwd, root))) return false;
	if (source.projectRoots?.length && longestMatchingRoot(cwd, source.projectRoots) === undefined) return false;
	if (!source.scopeProjectRoots || source.scopeProjectRoots.length === 0) return true;
	const includedLength = longestMatchingRoot(cwd, source.scopeProjectRoots);
	if (includedLength === undefined) return false;
	const competingLength = longestMatchingRoot(cwd, source.competingProjectRoots);
	return competingLength === undefined || includedLength > competingLength;
}
