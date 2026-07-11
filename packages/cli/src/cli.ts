#!/usr/bin/env bun

import { errorMessage, logger, runConfigureCommand } from '@umbod/core';

import { runStartCommand } from './commands/start.ts';
import { runAnalyzeCommand, type AnalyzeTarget } from './commands/analyze.ts';

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

function hasFlag(args: string[], name: string): boolean {
	return args.includes(name);
}

function showHelp(): void {
	console.log(`umbod

Usage:
  umbod start [--env path] [--port 9090] [--host 127.0.0.1]
  umbod configure [--agent codex|cursor|claude|gemini] [--url http://127.0.0.1:9090] [--output .umbod]
  umbod analyze tools|rules|coverage [--env path] [--since 14d] [--project dir] [--agent name] [--json]

Commands:
  start       Load a manifest, start the local server, and initialize SQLite.
  configure   Create configuration for agent settings files.
  analyze     Report tool usage, rule health, or transcript coverage.
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

	if (command === 'analyze') {
		const [target, ...analyzeArgs] = args;
		if (target !== 'tools' && target !== 'rules' && target !== 'coverage') {
			throw new Error('analyze requires one of: tools, rules, coverage');
		}
		await runAnalyzeCommand(target as AnalyzeTarget, {
			envPath: readFlag(analyzeArgs, '--env'),
			since: readFlag(analyzeArgs, '--since'),
			until: readFlag(analyzeArgs, '--until'),
			project: readFlag(analyzeArgs, '--project'),
			agent: readFlag(analyzeArgs, '--agent'),
			minOccurrences: readIntFlag(analyzeArgs, '--min-occurrences'),
			json: hasFlag(analyzeArgs, '--json'),
		});
		return;
	}

	throw new Error(`unknown command "${command}"`);
}

main().catch((error: unknown) => {
	logger.error('umbod failed', { error: errorMessage(error) });
	process.exitCode = 1;
});
