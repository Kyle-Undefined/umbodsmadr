import { loadManifest } from '../config/manifest.ts';
import { PolicyEngine } from '../policy/engine.ts';
import { startHttpServer } from '../server/http.ts';
import type { StartOptions } from '../core/types.ts';
import { AuditLogStore } from '../db/audit-log.ts';
import { logger } from '../utils/logger.ts';
import { defaultDatabasePath, resolveEnvPath } from '../utils/paths.ts';

export async function runStartCommand(options: StartOptions): Promise<void> {
	const manifestPath = resolveEnvPath(options.envPath);
	const manifest = await loadManifest(manifestPath);
	const engine = new PolicyEngine(manifest);
	const auditLog = new AuditLogStore(defaultDatabasePath(manifestPath, manifest.env.name));
	const host = options.host ?? manifest.server.host;
	const port = options.port ?? manifest.server.port;
	const approvalTimeoutMs = manifest.env.timeout * 1000;

	await startHttpServer({
		host,
		port,
		manifest,
		auditLog,
		approvalTimeoutMs,
		evaluate(call) {
			return engine.evaluate(call);
		},
	});

	logger.info('umbod started', {
		manifestPath,
		environment: manifest.env.name,
		host,
		port,
	});
}
