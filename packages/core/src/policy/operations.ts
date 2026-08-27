import { splitShellCommand } from './shell-analyzer.ts';

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

function shellComponentOperation(command: string): string | undefined {
	const normalized = command.trim().replace(/^(?:\S+[\\/])?/, '');
	const git = /^git\s+([a-z-]+)/i.exec(normalized)?.[1]?.toLowerCase();
	if (git) {
		const operations: Record<string, string> = {
			status: 'git.read',
			diff: 'git.read',
			log: 'git.read',
			show: 'git.read',
			commit: 'git.commit',
			push: 'git.push',
			pull: 'git.pull',
			fetch: 'git.fetch',
			reset: 'git.reset',
			clean: 'git.clean',
			checkout: 'git.checkout',
			switch: 'git.checkout',
		};
		return operations[git];
	}
	if (/^(?:curl|wget)\b/i.test(normalized)) return 'network.fetch';
	if (/^gh\s+(?:release\s+create|pr\s+create)\b/i.test(normalized)) return 'network.publish';
	if (/^(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|update)\b/i.test(normalized)) return 'package.modify';
	if (/^(?:npm|pnpm|yarn|bun)\s+publish\b/i.test(normalized)) return 'package.publish';
	if (/(?:^|\s)(?:\d*)>>?\s*/.test(normalized)) return 'filesystem.write';
	return undefined;
}

const OPERATION_RANK: Record<string, number> = {
	'git.read': 0,
	'filesystem.read': 0,
	'git.fetch': 1,
	'network.fetch': 1,
	'git.pull': 2,
	'git.checkout': 2,
	'git.commit': 3,
	'filesystem.write': 3,
	'package.modify': 3,
	'git.push': 4,
	'network.publish': 4,
	'package.publish': 4,
	'git.reset': 5,
	'git.clean': 5,
};

function shellOperation(command: string): string | undefined {
	return (splitShellCommand(command) ?? [command])
		.map(shellComponentOperation)
		.filter((operation): operation is string => operation !== undefined)
		.sort((left, right) => (OPERATION_RANK[right] ?? 2) - (OPERATION_RANK[left] ?? 2))[0];
}

export function inferredOperation(tool: string, command: string): string | undefined {
	const normalizedTool = tool.toLowerCase();
	if (normalizedTool === 'bash') return shellOperation(command);
	if (/^(?:hlid_)?(?:obsidian|vault)[._-]/.test(normalizedTool)) {
		return /(?:write|create|update|delete|trash|move|rename)/.test(normalizedTool) ? 'vault.write' : 'vault.read';
	}
	return inferredToolOperation(normalizedTool);
}

export function isCanonicalOperation(value: string): boolean {
	return /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/.test(value);
}
