import { describe, expect, test } from 'bun:test';

import { renderTomlSnippet } from '../../src/analytics/toml.ts';
import type { RuleSuggestion } from '../../src/analytics/types.ts';

const suggestion: RuleSuggestion = {
	pattern: 'git status',
	decision: 'allow',
	kind: 'promote-approved',
	rationale: 'approved repeatedly',
	evidence: {
		occurrences: 3,
		approvedCount: 3,
		deniedCount: 0,
		distinctCommands: 1,
		sampleCommands: ['git status'],
	},
	conflicts: [],
};

describe('analytics > TOML suggestions', () => {
	test('renders global suggestions as live rule entries', () => {
		const snippet = renderTomlSnippet([suggestion], {});

		expect(snippet).toContain('[rules]');
		expect(snippet).toContain('\n"git status" = "allow"\n');
	});

	test('keeps workspace suggestions inert until placed in the named table', () => {
		const snippet = renderTomlSnippet([suggestion], {}, 'client');

		expect(snippet).toContain('Workspace target: "client"');
		expect(snippet).toContain('\n# "git status" = "allow"\n');
		expect(snippet).not.toContain('\n[workspaces.rules]\n');
	});
});
