import type { AffectedPath, ToolCall } from '../core/types.ts';
import { splitShellCommand } from './shell-analyzer.ts';

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

// fallow-ignore-next-line complexity -- bounded recursive traversal handles the supported JSON value shapes.
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

export function rulePathCandidates(call: ToolCall): string[] {
	return affectedPaths(call).map((entry) => entry.path);
}

function normalizePath(path: string): string {
	return path
		.trim()
		.replaceAll('\\', '/')
		.replace(/^['"]|['"]$/g, '');
}

function pathAccess(tool: string, key = ''): AffectedPath['access'] {
	if (/delete|remove|unlink/i.test(tool) || /old_file_path/i.test(key)) return 'delete';
	if (/write|edit|apply|patch/i.test(tool) || /new_file_path/i.test(key)) return 'write';
	if (/read|grep|glob|search|list/i.test(tool)) return 'read';
	return 'unknown';
}

// fallow-ignore-next-line complexity -- bounded recursive traversal handles provider JSON arrays and objects.
function collectProviderPaths(value: unknown, out: AffectedPath[], tool: string, depth: number, key = ''): void {
	if (depth > MAX_DEPTH) return;
	if (typeof value === 'string') {
		if (looksLikeFilePath(value)) {
			out.push({ path: normalizePath(value), access: pathAccess(tool, key), source: 'provider-input' });
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectProviderPaths(item, out, tool, depth + 1, key);
		return;
	}
	if (!value || typeof value !== 'object') return;
	for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
		if (tool.toLowerCase() === 'bash' && (childKey === 'command' || childKey === 'shell_command')) continue;
		if (depth === 0 || PATH_FIELD_NAMES.has(childKey)) {
			collectProviderPaths(child, out, tool, depth + 1, childKey);
		}
	}
}

function patchPaths(command: string): AffectedPath[] {
	const paths: AffectedPath[] = [];
	for (const line of command.split(/\r?\n/)) {
		const marker = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
		if (marker) {
			paths.push({
				path: normalizePath(marker[2] as string),
				access: marker[1] === 'Delete' ? 'delete' : 'write',
				source: 'apply-patch',
			});
			continue;
		}
		const unified = /^(?:---|\+\+\+) (?:[ab]\/)?(.+)$/.exec(line);
		if (unified && unified[1] !== '/dev/null') {
			paths.push({ path: normalizePath(unified[1] as string), access: 'write', source: 'apply-patch' });
		}
	}
	return paths;
}

function redirectionPaths(command: string): AffectedPath[] {
	const paths: AffectedPath[] = [];
	for (const component of splitShellCommand(command) ?? []) {
		const pattern = /(?:^|\s)(?:\d*)>>?\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;
		for (const match of component.matchAll(pattern)) {
			const path = match[1] ?? match[2] ?? match[3];
			if (path && path !== '/dev/null' && looksLikeFilePath(path)) {
				paths.push({ path: normalizePath(path), access: 'write', source: 'shell-redirection' });
			}
		}
	}
	return paths;
}

export function affectedPaths(call: ToolCall): AffectedPath[] {
	const paths: AffectedPath[] = [];
	const rawInputs = call.inputs as Record<string, unknown>;
	const toolInput = rawInputs?.tool_input ?? rawInputs?.toolInput ?? rawInputs?.input ?? call.inputs;
	collectProviderPaths(toolInput, paths, call.tool, 0);
	if (/apply_patch|patch|edit/i.test(call.tool) || call.command.includes('*** Begin Patch')) {
		paths.push(...patchPaths(call.command));
	}
	if (call.tool === 'bash') paths.push(...redirectionPaths(call.command));

	if (call.tool.toLowerCase() !== 'bash' && looksLikeFilePath(call.command)) {
		paths.push({ path: normalizePath(call.command), access: pathAccess(call.tool), source: 'command' });
	}
	const deduplicated = new Map<string, AffectedPath>();
	for (const entry of paths) deduplicated.set(`${entry.path}:${entry.access}`, entry);
	return [...deduplicated.values()];
}

export function looksLikeFilePath(s: string): boolean {
	const t = s.trim();
	if (t.length === 0 || t.length > MAX_STRING_LEN) return false;
	if (t.includes('\n') || t.includes('\r')) return false;
	if (t.startsWith('/') || t.startsWith('./') || t.startsWith('../')) return true;
	if (t.includes('/.') || t.includes('\\.')) return true;
	if (/^[A-Za-z]:[/\\]/.test(t)) return true;
	if (/^(?:[^\s/\\]+[/\\])+[^\s/\\]+$/.test(t)) return true;
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
