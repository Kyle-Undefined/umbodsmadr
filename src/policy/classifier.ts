import type { CallClassification, ToolCall } from '../core/types.ts';
import { matchesPattern } from './rule-matcher.ts';

const READONLY_BASH_PATTERNS = [
	'git status',
	'git diff *',
	'git log *',
	'ls',
	'ls *',
	'cat',
	'cat *',
	'pwd',
	'find',
	'find *',
];

const DESTRUCTIVE_BASH_PATTERNS = [
	/(^|[\s;|&`()])(?:\/\S+\/)?rm(?=\s|$)/,
	/(^|[\s;|&`()])(?:\/\S+\/)?mv(?=\s|$)/,
	/(^|[\s;|&`()])(?:\/\S+\/)?chmod(?=\s|$)/,
	/(^|[\s;|&`()])(?:\/\S+\/)?chown(?=\s|$)/,
	/(^|[\s;|&`()])(?:\/\S+\/)?truncate(?=\s|$)/,
	/(^|[\s;|&`()])git\s+push(?=\s|$)/,
	/(^|[\s;|&`()])git\s+reset(?=\s|$)/,
	/(^|[\s;|&`()])git\s+clean(?=\s|$)/,
	/>>?\s*(?!\/dev\/null\b|&)\S/,
	/\$\(/,
	/`/,
	/(^|[\s;|&()])eval(?=\s|$)/,
	/(^|[\s;|&()])xargs(?=\s|$)/,
	/(^|[\s;|&()])(?:ba)?sh\s+-c/,
	/(^|[\s;|&()])(?:\/\S+\/)?tee(?=\s|$)/,
	/(^|[\s;|&()])(?:\/\S+\/)?dd(?=\s|$)/,
	/(^|[\s;|&()])(?:\/\S+\/)?cp(?=\s|$)/,
	/(^|[\s;|&()])(?:\/\S+\/)?install(?=\s|$)/,
	/(^|[\s;|&()])(?:\/\S+\/)?ln(?=\s|$)/,
	/-exec\b|-execdir\b|-ok\b|-okdir\b|-delete\b|-fprint\b|-fls\b|-fprintf\b/,
	/[|;\n]|&&/,
	/\b(?:while|for|until|if|case|select)\b/,
	/(^|[\s;|&()])(?:python[23]?|perl|ruby|node|deno|bun)\b/,
	/\{[^{}]*,[^{}]*\}/,
	/--output[\s=]/,
];

const EXTERNAL_BASH_PATTERNS = [
	/(^|[\s;|&`()])(?:\/\S+\/)?curl(?=\s|$)/,
	/(^|[\s;|&`()])(?:\/\S+\/)?wget(?=\s|$)/,
	/(^|[\s;|&`()])gh(?=\s|$)/,
	/(^|[\s;|&`()])npm\s+publish(?=\s|$)/,
	/(^|[\s;|&`()])scp(?=\s|$)/,
	/(^|[\s;|&`()])ssh(?=\s|$)/,
];

function matchesAny(input: string, patterns: string[]): boolean {
	return patterns.some((pattern) => matchesPattern(input, pattern));
}

export function classifyToolCall(call: ToolCall): CallClassification {
	if (call.tool === 'bash') {
		const command = call.command?.trim() ?? '';
		if (!command) {
			return 'unknown';
		}

		if (DESTRUCTIVE_BASH_PATTERNS.some((pattern) => pattern.test(command))) {
			return 'destructive';
		}

		if (matchesAny(command, READONLY_BASH_PATTERNS)) {
			return 'readonly';
		}

		if (EXTERNAL_BASH_PATTERNS.some((pattern) => pattern.test(command))) {
			return 'external';
		}

		return 'stateful';
	}

	if (/\b(?:read|search|list|glob|grep)\b/i.test(call.tool)) {
		return 'readonly';
	}

	if (/\b(?:write|edit|delete|apply)\b/i.test(call.tool)) {
		return 'destructive';
	}

	if (/\b(?:WebFetch|WebSearch)\b/i.test(call.tool)) {
		return 'external';
	}

	return 'unknown';
}
