const TOOL_OPERATIONS: Record<string, string> = {
	read: 'filesystem.read',
	grep: 'filesystem.search',
	glob: 'filesystem.search',
	edit: 'filesystem.edit',
	write: 'filesystem.write',
	apply_patch: 'filesystem.edit',
	webfetch: 'network.fetch',
	websearch: 'network.search',
};

export function inferredToolOperation(tool: string): string | undefined {
	return TOOL_OPERATIONS[tool.toLowerCase()];
}

export function isCanonicalOperation(value: string): boolean {
	return /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/.test(value);
}
