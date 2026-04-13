import type { ToolCall } from '../core/types.ts';

const MAX_STRING_LEN = 8192;
const MAX_DEPTH = 12;

const PATH_FIELD_NAMES = new Set([
	'file_path',
	'filePath',
	'path',
	'paths',
	'pattern',
	'old_file_path',
	'new_file_path',
	'dir_path',
	'relative_workspace_path',
	'command',
	'shell_command',
]);

function collectInputStrings(value: unknown, out: Set<string>, depth: number): void {
	if (depth > MAX_DEPTH) return;

	if (typeof value === 'string') {
		const t = value.trim();
		if (t.length > 0 && t.length <= MAX_STRING_LEN) {
			out.add(t);
		}
		return;
	}

	if (Array.isArray(value)) {
		for (const item of value) {
			collectInputStrings(item, out, depth + 1);
		}
		return;
	}

	if (value && typeof value === 'object') {
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (depth === 0 || PATH_FIELD_NAMES.has(k)) {
				collectInputStrings(v, out, depth + 1);
			}
		}
	}
}

export function looksLikeFilePath(s: string): boolean {
	const t = s.trim();
	if (t.length === 0 || t.length > MAX_STRING_LEN) return false;
	if (t.startsWith('/') || t.startsWith('./') || t.startsWith('../')) return true;
	if (t.includes('/.') || t.includes('\\.')) return true;
	if (/^[A-Za-z]:[/\\]/.test(t)) return true;
	if (/^[.][^./\\]/.test(t)) return true;
	return false;
}

export function ruleMatchCandidates(call: ToolCall): string[] {
	const seen = new Set<string>();
	const out: string[] = [];

	const add = (s: string) => {
		const n = s.trim();
		if (n.length === 0 || seen.has(n)) return;
		seen.add(n);
		out.push(n);
	};

	add(call.command);
	if (call.command?.includes('\\')) {
		add(call.command.replaceAll('\\', '/'));
	}

	const tool = call.tool.toLowerCase().trim();

	if (tool.length > 0) {
		const fromInputs = new Set<string>();
		// Restrict to the tool's actual input parameters — top-level payload fields
		// like session_id, transcript_path, and cwd are agent metadata, not operation
		// targets, and can cause false positives against dotfile/path block rules.
		const rawInputs = call.inputs as Record<string, unknown>;
		const toolInput = rawInputs?.tool_input ?? rawInputs?.toolInput ?? rawInputs?.input ?? call.inputs;
		collectInputStrings(toolInput, fromInputs, 0);

		for (const raw of fromInputs) {
			if (!looksLikeFilePath(raw)) continue;
			const normalized = raw.trim().replaceAll('\\', '/');
			add(`${tool} ${normalized}`);
		}
	}

	return out;
}
