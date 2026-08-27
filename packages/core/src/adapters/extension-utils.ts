import path from 'node:path';

import type { GeneratedHookAsset, HookInstallOptions } from './base.ts';

function jsString(value: string): string {
	return JSON.stringify(value);
}

export function extensionTarget(
	options: HookInstallOptions,
	agent: string
): {
	targetPath: typeof path.posix;
	targetHome: string;
	assetPath: string;
	asset: GeneratedHookAsset;
} {
	const isWindows = options.platform ? options.platform === 'windows' : process.platform === 'win32';
	const targetPath = isWindows ? path.win32 : path.posix;
	const targetHome = options.homeDir ?? (isWindows ? (process.env.USERPROFILE ?? '~') : (process.env.HOME ?? '~'));
	const relativePath = `${agent}-umbod.ts`;

	return {
		targetPath,
		targetHome,
		assetPath: targetPath.join(options.outputDir, relativePath),
		asset: { relativePath, contents: '' },
	};
}

export function authorizationFunction(serverUrl: string, agent: string, timeoutSeconds: number): string {
	const endpoint = `${serverUrl.replace(/\/$/, '')}/api/hooks`;
	return `async function authorize(payload: unknown): Promise<{ allowed: boolean; reason: string }> {
	try {
		const response = await fetch(${jsString(endpoint)}, {
			method: "POST",
			headers: { "content-type": "application/json", "x-umbod-agent": ${jsString(agent)} },
			body: JSON.stringify(payload),
			${timeoutSeconds > 0 ? `signal: AbortSignal.timeout(${timeoutSeconds * 1000}),` : ''}
		});
		if (!response.ok) return { allowed: false, reason: \`Umbod returned HTTP \${response.status}.\` };
		const result = await response.json() as { permissionDecision?: string; reason?: string };
		return {
			allowed: result.permissionDecision === "allow",
			reason: result.reason ?? "Blocked by Umbod policy. See the Umbod dashboard for details.",
		};
	} catch (error) {
		return { allowed: false, reason: \`Umbod hook request failed: \${String(error)}\` };
	}
}`;
}
