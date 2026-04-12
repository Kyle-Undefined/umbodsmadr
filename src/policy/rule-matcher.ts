import type { ApprovalDecision } from '../core/types.ts';

const regexPatternRe = /^\/(.+)\/([gimsuy]*)$/;

function isRegexPattern(pattern: string): boolean {
	return regexPatternRe.test(pattern);
}

function matchesRegex(input: string, pattern: string): boolean {
	const match = regexPatternRe.exec(pattern);
	if (!match) return false;

	try {
		const re = new RegExp(match[1], match[2]);
		return re.test(input);
	} catch {
		return false;
	}
}

// Custom glob convention: a pattern ending with " *" (space-star) means
// "match the prefix exactly, or the prefix followed by any arguments".
// Example: "git *" matches "git status", "git log --oneline", and "git" itself.
// Standard glob wildcards: only "*" is supported (not "**", "?", or classes).
function matchesGlob(input: string, pattern: string): boolean {
	if (pattern.endsWith(' *')) {
		const prefix = pattern.slice(0, -2);
		if (input === prefix) {
			return true;
		}
	}

	let inputIndex = 0;
	let patternIndex = 0;
	let starIndex = -1;
	let matchIndex = 0;

	while (inputIndex < input.length) {
		if (patternIndex < pattern.length && pattern[patternIndex] === input[inputIndex]) {
			inputIndex += 1;
			patternIndex += 1;
			continue;
		}

		if (patternIndex < pattern.length && pattern[patternIndex] === '*') {
			starIndex = patternIndex;
			matchIndex = inputIndex;
			patternIndex += 1;
			continue;
		}

		if (starIndex !== -1) {
			patternIndex = starIndex + 1;
			matchIndex += 1;
			inputIndex = matchIndex;
			continue;
		}

		return false;
	}

	while (patternIndex < pattern.length && pattern[patternIndex] === '*') {
		patternIndex += 1;
	}

	return patternIndex === pattern.length;
}

export function matchesPattern(input: string, pattern: string): boolean {
	if (isRegexPattern(pattern)) {
		return matchesRegex(input, pattern);
	}

	return matchesGlob(input, pattern);
}

export function findMatchingRule(
	input: string,
	rules: Record<string, ApprovalDecision>
): [pattern: string, decision: ApprovalDecision] | undefined {
	for (const [pattern, decision] of Object.entries(rules)) {
		if (matchesPattern(input, pattern)) {
			return [pattern, decision];
		}
	}

	return undefined;
}
