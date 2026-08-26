import type { CallClassification } from '../core/types.ts';
import { matchesPattern } from './rule-matcher.ts';

const READONLY = ['git status', 'git diff *', 'git log *', 'ls', 'ls *', 'cat', 'cat *', 'pwd', 'find', 'find *'];
const DESTRUCTIVE = [
	/^(?:\/\S+\/)?(?:rm|mv|chmod|chown|truncate|cp|install|ln)(?:\s|$)/,
	/^git\s+(?:push|reset|clean)(?:\s|$)/,
	/>>?\s*(?!\/dev\/null\b|&)\S/,
	/^(?:\/\S+\/)?(?:tee|dd)(?:\s|$)/,
	/^xargs(?:\s|$)/,
	/(?:^|\s)-(?:exec|execdir|ok|okdir|delete|fprint|fls|fprintf)\b/,
	/^npm\s+install(?:\s|$)/,
	/--output[\s=]/,
];
const EXTERNAL = [/^(?:\/\S+\/)?(?:curl|wget|scp|ssh)(?:\s|$)/, /^gh(?:\s|$)/, /^npm\s+publish(?:\s|$)/];
const AMBIGUOUS = [
	/\$\(/,
	/`/,
	/^(?:eval|(?:ba)?sh\s+-c)(?:\s|$)/,
	/^(?:python[23]?|perl|ruby|node|deno|bun)(?:\s|$)/,
	/^(?:while|for|until|if|case|select)\b/,
	/\{[^{}]*,[^{}]*\}/,
];
const RANK: Record<Exclude<CallClassification, 'unknown'>, number> = {
	readonly: 0,
	stateful: 1,
	external: 2,
	destructive: 3,
};

export interface ShellOperationAnalysis {
	components: Array<{ command: string; classification: Exclude<CallClassification, 'unknown'> }>;
	compound: boolean;
	classification: CallClassification;
}

// fallow-ignore-next-line complexity -- bounded quote-aware tokenizer keeps shell state in one auditable pass.
function splitCompound(command: string): string[] | undefined {
	const parts: string[] = [];
	let current = '';
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (let index = 0; index < command.length; index += 1) {
		const char = command[index]!;
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === '\\' && quote !== "'") {
			current += char;
			escaped = true;
			continue;
		}
		if (quote) {
			current += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			current += char;
			continue;
		}
		if (char === ';' || char === '|' || char === '\n' || (char === '&' && command[index + 1] === '&')) {
			if (!current.trim()) return undefined;
			parts.push(current.trim());
			current = '';
			if ((char === '|' || char === '&') && command[index + 1] === char) index += 1;
			continue;
		}
		current += char;
	}
	if (quote || escaped || !current.trim()) return undefined;
	parts.push(current.trim());
	return parts;
}

function classifyComponent(command: string): Exclude<CallClassification, 'unknown'> | undefined {
	if (AMBIGUOUS.some((pattern) => pattern.test(command))) return undefined;
	if (DESTRUCTIVE.some((pattern) => pattern.test(command))) return 'destructive';
	if (READONLY.some((pattern) => matchesPattern(command, pattern))) return 'readonly';
	if (EXTERNAL.some((pattern) => pattern.test(command))) return 'external';
	return 'stateful';
}

export function analyzeShellCommand(command: string): ShellOperationAnalysis {
	const parts = splitCompound(command.trim());
	if (!parts) return { components: [], compound: false, classification: 'unknown' };
	const components: ShellOperationAnalysis['components'] = [];
	for (const part of parts) {
		const classification = classifyComponent(part);
		if (!classification) return { components: [], compound: parts.length > 1, classification: 'unknown' };
		components.push({ command: part, classification });
	}
	const classification = components.reduce(
		(strictest, component) => (RANK[component.classification] > RANK[strictest] ? component.classification : strictest),
		'readonly' as Exclude<CallClassification, 'unknown'>
	);
	return { components, compound: components.length > 1, classification };
}
