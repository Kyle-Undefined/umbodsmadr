import { defaultDatabasePath, loadManifest, logger, resolveEnvPath, type StartOptions } from '@umbod/core';

import { startHttpServer } from '../server/serve.ts';

export async function runStartCommand(options: StartOptions): Promise<void> {
	const manifestPath = resolveEnvPath(options.envPath);
	const manifest = await loadManifest(manifestPath);
	const host = options.host ?? manifest.server.host;
	const port = options.port ?? manifest.server.port;
	const approvalTimeoutMs = manifest.env.timeout * 1000;

	await startHttpServer({
		host,
		port,
		manifest,
		dbPath: defaultDatabasePath(manifestPath, manifest.env.name),
		approvalTimeoutMs,
	});

	logger.info('umbod started', {
		manifestPath,
		environment: manifest.env.name,
		host,
		port,
	});
}
