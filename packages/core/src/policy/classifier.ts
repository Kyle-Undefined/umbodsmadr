import type { CallClassification, ToolCall } from '../core/types.ts';
import { analyzeShellCommand } from './shell-analyzer.ts';

export function classifyToolCall(call: ToolCall): CallClassification {
	if (call.tool === 'bash') {
		const command = call.command?.trim() ?? '';
		if (!command) {
			return 'unknown';
		}

		return analyzeShellCommand(command).classification;
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
