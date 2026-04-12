import type { ApprovalDecision, EvaluationResult, Manifest, ToolCall } from '../core/types.ts';
import { classifyToolCall } from './classifier.ts';
import { findMatchingRule } from './rule-matcher.ts';
import { ruleMatchCandidates } from './rule-candidates.ts';

function findFirstMatchingRule(
	candidates: string[],
	rules: Manifest['rules']
): [pattern: string, decision: ApprovalDecision] | undefined {
	for (const input of candidates) {
		const match = findMatchingRule(input, rules);
		if (match) return match;
	}

	return undefined;
}

export class PolicyEngine {
	constructor(private readonly manifest: Manifest) {}

	evaluate(call: ToolCall): EvaluationResult {
		const classification = classifyToolCall(call);
		const candidates = ruleMatchCandidates(call);
		const match = findFirstMatchingRule(candidates, this.manifest.rules);

		if (match) {
			const [pattern, decision] = match;

			return {
				decision,
				classification,
				matchedRule: pattern,
				reason: `matched rule "${pattern}"`,
			};
		}

		if (classification === 'readonly') {
			// Grep/glob on a directory can expose hidden files via ripgrep's
			// implicit --hidden search.  Before auto-allowing, probe whether a
			// hidden file at the same path would be blocked by any rule.
			if (/^(grep|glob)$/.test(call.tool)) {
				if (!call.command) {
					return {
						decision: this.manifest.policy.default_unknown,
						classification,
						reason: 'readonly tool call with empty command',
					};
				}
				const probe = `${call.command}/.hidden_probe`;
				const probeMatch = findMatchingRule(probe, this.manifest.rules);
				if (probeMatch && probeMatch[1] !== 'allow') {
					return {
						decision: this.manifest.policy.default_unknown,
						classification,
						reason: 'directory search may expose hidden files protected by block rules',
					};
				}
			}

			return {
				decision: 'allow',
				classification,
				reason: 'auto-allowed readonly tool call',
			};
		}

		return {
			decision: this.manifest.policy.default_unknown,
			classification,
			reason: `no matching rule, fell back to policy.default_unknown=${this.manifest.policy.default_unknown}`,
		};
	}
}
