import type { ToolCall } from '../core/types.ts';
import { isRecord } from '../utils/guards.ts';

function requiredString(payload: Record<string, unknown>, field: string): string {
	const value = payload[field];
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`invalid tool call: missing ${field}`);
	}
	return value;
}

function optionalString(payload: Record<string, unknown>, field: string): string | undefined {
	const value = payload[field];
	if (value !== undefined && typeof value !== 'string') {
		throw new Error(`invalid tool call: ${field} must be a string`);
	}
	return value;
}

function optionalStringArray(payload: Record<string, unknown>, field: string): string[] | undefined {
	const value = payload[field];
	if (value !== undefined && (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))) {
		throw new Error(`invalid tool call: ${field} must be a string array`);
	}
	return value as string[] | undefined;
}

export function parseEvaluatePayload(payload: unknown): ToolCall {
	if (!isRecord(payload)) {
		throw new Error('invalid tool call payload');
	}

	if (payload.inputs !== undefined && !isRecord(payload.inputs)) {
		throw new Error('invalid tool call: inputs must be an object');
	}

	return {
		agent: requiredString(payload, 'agent'),
		tool: requiredString(payload, 'tool'),
		command: requiredString(payload, 'command'),
		args: optionalStringArray(payload, 'args'),
		workingDirectory: optionalString(payload, 'workingDirectory'),
		workspaceId: optionalString(payload, 'workspaceId'),
		inputs: payload.inputs as Record<string, unknown> | undefined,
		timestamp: optionalString(payload, 'timestamp') ?? new Date().toISOString(),
		sessionId: optionalString(payload, 'sessionId'),
		toolUseId: optionalString(payload, 'toolUseId'),
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
