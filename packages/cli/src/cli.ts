#!/usr/bin/env bun

import { errorMessage, logger, runConfigureCommand } from '@umbod/core';

import { runStartCommand } from './commands/start.ts';
import { runAnalyzeCommand, type AnalyzeTarget } from './commands/analyze.ts';
import { runPolicySimulateCommand, type SimulationFailure } from './commands/policy.ts';

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

// fallow-ignore-next-line complexity -- bounded hand-rolled CLI parsing mirrors the existing single-flag helper.
function readFlags(args: string[], name: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] !== name) continue;
		const value = args[index + 1];
		if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${name}`);
		values.push(value);
	}
	return values;
}

function showHelp(): void {
	console.log(`umbod

Usage:
  umbod start [--env path] [--port 9090] [--host 127.0.0.1]
  umbod configure [--agent codex|cursor|claude|gemini] [--url http://127.0.0.1:9090] [--output .umbod]
  umbod analyze tools|rules|coverage [--env path] [--since 14d] [--project dir] [--workspace id] [--agent name] [--json]
  umbod policy simulate <candidate.toml> [--env baseline.toml] [--database path] [--since 30d] [--limit 2000|--all] [--fail-on check] [--json]

Commands:
  start       Load a manifest, start the local server, and initialize SQLite.
  configure   Create configuration for agent settings files.
  analyze     Report tool usage, rule health, or transcript coverage.
  policy      Simulate a candidate manifest against historical audit calls without activating it.
`);
}

function analyzeTarget(value: string | undefined): AnalyzeTarget {
	if (value === 'tools' || value === 'rules' || value === 'coverage') return value;
	throw new Error('analyze requires one of: tools, rules, coverage');
}

async function runAnalyzeCli(args: string[]): Promise<void> {
	const [target, ...analyzeArgs] = args;
	await runAnalyzeCommand(analyzeTarget(target), {
		envPath: readFlag(analyzeArgs, '--env'),
		since: readFlag(analyzeArgs, '--since'),
		until: readFlag(analyzeArgs, '--until'),
		project: readFlag(analyzeArgs, '--project'),
		workspace: readFlag(analyzeArgs, '--workspace'),
		agent: readFlag(analyzeArgs, '--agent'),
		minOccurrences: readIntFlag(analyzeArgs, '--min-occurrences'),
		json: hasFlag(analyzeArgs, '--json'),
	});
}

const SIMULATION_FAILURES = new Set<SimulationFailure>([
	'blocked-to-allow',
	'approve-to-allow',
	'previously-denied-to-allow',
	'unresolved-workspace',
	'truncated',
]);
const POLICY_VALUE_FLAGS = new Set([
	'--env',
	'--database',
	'--since',
	'--until',
	'--project',
	'--workspace',
	'--agent',
	'--limit',
	'--fail-on',
]);
const POLICY_BOOLEAN_FLAGS = new Set(['--all', '--json']);

// fallow-ignore-next-line complexity -- strict validation walks the small hand-rolled option grammar once.
function validatePolicyArgs(args: string[]): void {
	const seen = new Set<string>();
	for (let index = 0; index < args.length; index += 1) {
		const flag = args[index] as string;
		if (!POLICY_VALUE_FLAGS.has(flag) && !POLICY_BOOLEAN_FLAGS.has(flag)) {
			throw new Error(`unknown policy simulate argument "${flag}"`);
		}
		if (flag !== '--fail-on' && seen.has(flag)) throw new Error(`duplicate policy simulate argument "${flag}"`);
		seen.add(flag);
		if (POLICY_VALUE_FLAGS.has(flag)) {
			const value = args[index + 1];
			if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
			index += 1;
		}
	}
}

function simulationFailures(args: string[]): SimulationFailure[] {
	return readFlags(args, '--fail-on').map((value) => {
		if (!SIMULATION_FAILURES.has(value as SimulationFailure)) {
			throw new Error(`unknown --fail-on check "${value}"`);
		}
		return value as SimulationFailure;
	});
}

// fallow-ignore-next-line complexity -- this is the policy subcommand's argument-to-options boundary.
async function runPolicyCli(args: string[]): Promise<void> {
	const [action, candidatePath, ...policyArgs] = args;
	if (action !== 'simulate' || !candidatePath || candidatePath.startsWith('--')) {
		throw new Error('policy requires: policy simulate <candidate.toml>');
	}
	validatePolicyArgs(policyArgs);
	const { failed } = await runPolicySimulateCommand(candidatePath, {
		baselinePath: readFlag(policyArgs, '--env'),
		databasePath: readFlag(policyArgs, '--database'),
		since: readFlag(policyArgs, '--since'),
		until: readFlag(policyArgs, '--until'),
		project: readFlag(policyArgs, '--project'),
		workspace: readFlag(policyArgs, '--workspace'),
		agent: readFlag(policyArgs, '--agent'),
		limit: readIntFlag(policyArgs, '--limit'),
		all: hasFlag(policyArgs, '--all'),
		json: hasFlag(policyArgs, '--json'),
		failOn: simulationFailures(policyArgs),
	});
	if (failed.length > 0) {
		console.error(`Policy simulation failed checks: ${failed.join(', ')}`);
		process.exitCode = 2;
	}
}

// fallow-ignore-next-line complexity -- the top-level hand-rolled command router is intentionally explicit.
async function runCommand(command: string, args: string[]): Promise<void> {
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
	if (command === 'analyze') return runAnalyzeCli(args);
	if (command === 'policy') return runPolicyCli(args);
	throw new Error(`unknown command "${command}"`);
}

async function main(): Promise<void> {
	const [command, ...args] = Bun.argv.slice(2);
	if (!command || command === '--help' || command === '-h') {
		showHelp();
		return;
	}
	await runCommand(command, args);
}

main().catch((error: unknown) => {
	logger.error('umbod failed', { error: errorMessage(error) });
	process.exitCode = 1;
});
