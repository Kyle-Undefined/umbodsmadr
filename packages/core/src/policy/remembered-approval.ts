import { createHash } from 'node:crypto';
import type { Manifest, ToolCall } from '../core/types.ts';
import { isAbsoluteWorkspaceRoot, normalizeWorkspaceRoot, resolveWorkspace } from './workspace.ts';

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, item]) => [key, stableValue(item)])
		);
	}
	return value;
}

/** No agent/session IDs: all adapters sharing this database share the same grant. */
export function rememberedApprovalKey(manifest: Manifest, call: ToolCall): string | undefined {
	const resolution = resolveWorkspace(manifest, call);
	if (resolution.source === 'unresolved') return undefined;
	const cwd = call.workingDirectory;
	if (!cwd || !isAbsoluteWorkspaceRoot(cwd)) return undefined;
	const tool = call.tool.toLowerCase();
	// These two timing tools have no targets or mutations. Duration changes do
	// not require a new grant. Other tools retain their exact command and input.
	// Codex's native hook names concatenate the namespace and tool (clocksleep).
	const clock = /^(?:mcp__)?clock(?:__|\.|)(curr_time|currtime|sleep)$/.exec(tool);
	const scope = resolution.workspace ? ['workspace', resolution.workspace.id] : ['cwd', normalizeWorkspaceRoot(cwd)];
	const input = call.inputs ?? {};
	const toolInput = input.tool_input ?? input.toolInput ?? input.arguments ?? input.input ?? input;
	const requestInput =
		tool === 'bash' && toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)
			? Object.fromEntries(Object.entries(toolInput).filter(([key]) => key !== 'command' && key !== 'cmd'))
			: toolInput;
	const identity = clock
		? [scope, `clock.${clock[1] === 'currtime' ? 'curr_time' : clock[1]}`]
		: [
				scope,
				normalizeWorkspaceRoot(cwd),
				tool,
				call.operation ?? null,
				tool === 'bash' ? call.command : null,
				call.args ?? [],
				stableValue(requestInput),
			];
	return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
