import type { AnalyticsWindow, RuleSuggestion } from './types.ts';

function tomlKey(pattern: string): string {
	return JSON.stringify(pattern);
}

/**
 * Renders suggestions as a ready-to-paste TOML block. Additive suggestions
 * appear as live keys; hygiene findings (dead/invalid/shadowed rules) are
 * emitted as comments since they describe existing manifest lines.
 */
export function renderTomlSnippet(suggestions: RuleSuggestion[], window: AnalyticsWindow): string {
	if (suggestions.length === 0) {
		return '';
	}

	const windowNote = window.since !== undefined ? ` (since ${window.since})` : '';
	const lines: string[] = [
		`# Suggested by umbod rule analysis on ${new Date().toISOString().slice(0, 10)}${windowNote}`,
		'# Review before pasting — rule order is first-match-wins.',
		'[rules]',
	];

	const additive = suggestions.filter((s) => s.kind === 'promote-approved' || s.kind === 'block-denied');
	const hygiene = suggestions.filter((s) => s.kind !== 'promote-approved' && s.kind !== 'block-denied');

	for (const suggestion of additive) {
		lines.push(`# ${suggestion.rationale}`);
		for (const conflict of suggestion.conflicts) {
			lines.push(`# CONFLICT: ${conflict}`);
		}
		lines.push(`${tomlKey(suggestion.pattern)} = ${JSON.stringify(suggestion.decision)}`);
	}

	if (hygiene.length > 0) {
		if (additive.length > 0) lines.push('');
		lines.push('# Existing rules to revisit:');
		for (const suggestion of hygiene) {
			lines.push(`# ${suggestion.kind}: ${tomlKey(suggestion.pattern)} — ${suggestion.rationale}`);
		}
	}

	return `${lines.join('\n')}\n`;
}
