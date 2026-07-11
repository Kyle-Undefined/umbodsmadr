import type { ToolCall } from '../core/types.ts';
import { isRecord } from '../utils/guards.ts';

export function parseEvaluatePayload(payload: unknown): ToolCall {
	if (!isRecord(payload)) {
		throw new Error('invalid tool call payload');
	}

	if (typeof payload.agent !== 'string' || payload.agent.trim().length === 0) {
		throw new Error('invalid tool call: missing agent');
	}

	if (typeof payload.tool !== 'string' || payload.tool.trim().length === 0) {
		throw new Error('invalid tool call: missing tool');
	}

	if (typeof payload.command !== 'string' || payload.command.trim().length === 0) {
		throw new Error('invalid tool call: missing command');
	}

	if (
		payload.args !== undefined &&
		(!Array.isArray(payload.args) || payload.args.some((entry) => typeof entry !== 'string'))
	) {
		throw new Error('invalid tool call: args must be a string array');
	}

	if (payload.workingDirectory !== undefined && typeof payload.workingDirectory !== 'string') {
		throw new Error('invalid tool call: workingDirectory must be a string');
	}

	if (payload.inputs !== undefined && !isRecord(payload.inputs)) {
		throw new Error('invalid tool call: inputs must be an object');
	}

	if (payload.timestamp !== undefined && typeof payload.timestamp !== 'string') {
		throw new Error('invalid tool call: timestamp must be a string');
	}

	if (payload.sessionId !== undefined && typeof payload.sessionId !== 'string') {
		throw new Error('invalid tool call: sessionId must be a string');
	}

	if (payload.toolUseId !== undefined && typeof payload.toolUseId !== 'string') {
		throw new Error('invalid tool call: toolUseId must be a string');
	}

	return {
		agent: payload.agent,
		tool: payload.tool,
		command: payload.command,
		args: payload.args as string[] | undefined,
		workingDirectory: payload.workingDirectory,
		inputs: payload.inputs as Record<string, unknown> | undefined,
		timestamp: payload.timestamp ?? new Date().toISOString(),
		sessionId: payload.sessionId,
		toolUseId: payload.toolUseId,
	};
}

export function resolveAgentId(req: Request, url: URL): string | undefined {
	const headerAgent = req.headers.get('x-umbod-agent');
	if (headerAgent && headerAgent.trim().length > 0) {
		return headerAgent.trim();
	}

	const queryAgent = url.searchParams.get('agent');
	if (queryAgent && queryAgent.trim().length > 0) {
		return queryAgent.trim();
	}

	return undefined;
}
