#!/usr/bin/env bun

import { runConfigureCommand } from './commands/configure.ts';
import { runStartCommand } from './commands/start.ts';
import { errorMessage } from './utils/errors.ts';
import { logger } from './utils/logger.ts';

function readFlag(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);

	if (index === -1) {
		return undefined;
	}

	const value = args[index + 1];

	if (value === undefined || value.startsWith('--')) {
		throw new Error(`missing value for ${name}`);
	}

	return value;
}

function readIntFlag(args: string[], name: string): number | undefined {
	const value = readFlag(args, name);
	if (value === undefined) {
		return undefined;
	}

	const parsed = Number.parseInt(value, 10);
	if (Number.isNaN(parsed) || String(parsed) !== value) {
		throw new Error(`${name} must be an integer`);
	}

	return parsed;
}

function showHelp(): void {
	console.log(`umbod

Usage:
  umbod start [--env path] [--port 9090] [--host 127.0.0.1]
  umbod configure [--agent codex|cursor|claude|gemini] [--url http://127.0.0.1:9090] [--output .umbod]

Commands:
  start       Load a manifest, start the local server, and initialize SQLite.
  configure   Create configuration for agent settings files.
`);
}

async function main(): Promise<void> {
	const [command, ...args] = Bun.argv.slice(2);

	if (!command || command === '--help' || command === '-h') {
		showHelp();
		return;
	}

	if (command === 'start') {
		await runStartCommand({
			envPath: readFlag(args, '--env'),
			port: readIntFlag(args, '--port'),
			host: readFlag(args, '--host'),
		});
		return;
	}

	if (command === 'configure') {
		await runConfigureCommand({
			agent: readFlag(args, '--agent'),
			outputDir: readFlag(args, '--output'),
			url: readFlag(args, '--url'),
		});
		return;
	}

	throw new Error(`unknown command "${command}"`);
}

main().catch((error: unknown) => {
	logger.error('umbod failed', { error: errorMessage(error) });
	process.exitCode = 1;
});
