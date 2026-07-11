import { mkdirSync } from 'node:fs';
import path from 'node:path';

export function resolveEnvPath(input?: string): string {
	return path.resolve(input ?? 'umbod.toml');
}

export function ensureDir(dirPath: string): string {
	mkdirSync(dirPath, { recursive: true });
	return dirPath;
}

export function resolveOutputDir(input?: string): string {
	return ensureDir(path.resolve(input ?? '.umbod'));
}

export function defaultDatabasePath(manifestPath: string, envName: string): string {
	return path.join(path.dirname(manifestPath), `umbod.${envName}.db`);
}
