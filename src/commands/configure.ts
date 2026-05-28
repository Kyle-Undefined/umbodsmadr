import { chmodSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { selectAdapters } from '../adapters/index.ts';
import type { ConfigureOptions } from '../core/types.ts';
import { DEFAULT_HOST, DEFAULT_PORT } from '../core/types.ts';
import { logger } from '../utils/logger.ts';
import { ensureDir, resolveOutputDir } from '../utils/paths.ts';

interface ConfigureContext {
	url: string;
	timeoutSeconds: number;
}

// Reads umbod.toml from the current directory to infer hook settings.
// Falls back to the default host/port and no timeout when no manifest is found.
function inferConfigureContext(options: ConfigureOptions): ConfigureContext {
	const fallbackUrl = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;

	try {
		const manifestPath = path.resolve('umbod.toml');
		const source = readFileSync(manifestPath, 'utf-8');
		const parsed = Bun.TOML.parse(source) as Record<string, unknown>;
		const env = parsed.env as Record<string, unknown> | undefined;
		const server = parsed.server as Record<string, unknown> | undefined;

		const host = typeof server?.host === 'string' ? server.host : DEFAULT_HOST;
		const port = typeof server?.port === 'number' ? server.port : DEFAULT_PORT;
		const timeoutSeconds = typeof env?.timeout === 'number' && env.timeout >= 0 ? env.timeout : 0;
		return {
			url: options.url ? options.url.replace(/\/$/, '') : `http://${host}:${port}`,
			timeoutSeconds,
		};
	} catch {
		// No manifest found or parse error, use defaults
	}

	return {
		url: options.url ? options.url.replace(/\/$/, '') : fallbackUrl,
		timeoutSeconds: 0,
	};
}

export async function runConfigureCommand(options: ConfigureOptions): Promise<void> {
	const { url, timeoutSeconds } = inferConfigureContext(options);
	const outputDir = resolveOutputDir(options.outputDir);
	const selected = selectAdapters(options.agent);
	const writtenAssets = new Set<string>();

	if (selected.length === 0) {
		throw new Error(`unknown agent "${options.agent}"`);
	}

	for (const adapter of selected) {
		const result = adapter.install({ url, outputDir, timeoutSeconds });

		for (const asset of result.assets) {
			const outputPath = path.resolve(outputDir, asset.relativePath);
			const relativeOutputPath = path.normalize(path.relative(outputDir, outputPath));

			if (
				relativeOutputPath === '..' ||
				relativeOutputPath.startsWith(`..${path.sep}`) ||
				path.isAbsolute(relativeOutputPath)
			) {
				throw new Error(`invalid asset path "${asset.relativePath}" escapes ${outputDir}`);
			}

			if (writtenAssets.has(outputPath)) {
				continue;
			}

			ensureDir(path.dirname(outputPath));
			await Bun.write(outputPath, asset.contents);

			if (asset.executable && process.platform !== 'win32') {
				chmodSync(outputPath, 0o755);
			}

			writtenAssets.add(outputPath);
			logger.info(`wrote ${adapter.displayName} asset`, { outputPath });
		}

		const { fileName, settingsPath, contents } = result.config;
		const configPath = path.resolve(outputDir, fileName);
		const normalizedRelativeConfigPath = path.normalize(path.relative(outputDir, configPath));

		if (
			normalizedRelativeConfigPath === '..' ||
			normalizedRelativeConfigPath.startsWith(`..${path.sep}`) ||
			path.isAbsolute(normalizedRelativeConfigPath)
		) {
			throw new Error(`invalid config path "${fileName}" escapes ${outputDir}`);
		}

		if (!writtenAssets.has(configPath)) {
			await Bun.write(configPath, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2) + '\n');
			writtenAssets.add(configPath);
			logger.info(`wrote ${adapter.displayName} config snippet`, {
				outputPath: configPath,
				installTo: settingsPath,
			});
		}
	}
}
