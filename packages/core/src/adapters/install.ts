import { homedir } from 'node:os';
import path from 'node:path';

import { buildCurlWrapperScript, buildPowerShellWrapperScript } from '../hooks/adapter-utils.ts';
import { normalizeHookTimeoutSeconds, type GeneratedHookAsset, type HookInstallOptions } from './base.ts';

type HookTarget = 'generic' | 'cursor' | 'gemini' | 'codex';

export function hookInstallScaffold(
	options: HookInstallOptions,
	agent: string,
	hookTarget: HookTarget
): {
	targetPath: typeof path.posix;
	targetHome: string;
	command: string;
	asset: GeneratedHookAsset;
} {
	const isWindows = options.platform ? options.platform === 'windows' : process.platform === 'win32';
	const targetPath = isWindows ? path.win32 : path.posix;
	const targetHome = options.homeDir ?? homedir();
	const scriptFile = isWindows ? `hook-${agent}.ps1` : `hook-${agent}.sh`;
	const scriptPath = targetPath.join(options.outputDir, scriptFile);
	const timeoutSeconds = normalizeHookTimeoutSeconds(options.timeoutSeconds);
	return {
		targetPath,
		targetHome,
		command: isWindows ? `powershell.exe -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"` : scriptPath,
		asset: {
			relativePath: scriptFile,
			contents: isWindows
				? buildPowerShellWrapperScript(options.url, agent, timeoutSeconds, hookTarget)
				: buildCurlWrapperScript(options.url, agent, timeoutSeconds, hookTarget),
			executable: !isWindows,
		},
	};
}
