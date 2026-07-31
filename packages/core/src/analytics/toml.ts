import type { AnalyticsWindow, RuleSuggestion } from './types.ts';

function tomlKey(pattern: string): string {
	return JSON.stringify(pattern);
}

/**
 * Renders suggestions as a TOML block. Global additive suggestions appear as
 * live keys. Workspace suggestions remain commented because TOML cannot target
 * an existing array-of-tables entry by workspace id; the user must move them
 * into the intended workspace's rules table.
 */
export function renderTomlSnippet(
	suggestions: RuleSuggestion[],
	window: AnalyticsWindow,
	workspaceId?: string
): string {
	if (suggestions.length === 0) {
		return '';
	}

	const windowNote = window.since !== undefined ? ` (since ${window.since})` : '';
	const lines: string[] = [
		`# Suggested by umbod rule analysis on ${new Date().toISOString().slice(0, 10)}${windowNote}`,
		'# Review before pasting — rule order is first-match-wins.',
		...(workspaceId
			? [
					`# Workspace target: ${JSON.stringify(workspaceId)}.`,
					"# Move and uncomment each proposed entry inside that workspace's existing [workspaces.rules] table.",
				]
			: ['[rules]']),
	];

	const additive = suggestions.filter((s) => s.kind === 'promote-approved' || s.kind === 'block-denied');
	const hygiene = suggestions.filter((s) => s.kind !== 'promote-approved' && s.kind !== 'block-denied');

	for (const suggestion of additive) {
		lines.push(`# ${suggestion.rationale}`);
		for (const conflict of suggestion.conflicts) {
			lines.push(`# CONFLICT: ${conflict}`);
		}
		const entry = `${tomlKey(suggestion.pattern)} = ${JSON.stringify(suggestion.decision)}`;
		lines.push(workspaceId ? `# ${entry}` : entry);
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
