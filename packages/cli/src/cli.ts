#!/usr/bin/env bun

import { errorMessage, logger, runConfigureCommand } from '@umbod/core';

import { runStartCommand } from './commands/start.ts';
import { runAnalyzeCommand, type AnalyzeTarget } from './commands/analyze.ts';
import { runDatabaseCommand, type DatabaseAction } from './commands/database.ts';
import {
	runPolicyLintCommand,
	runPolicyDraftCommand,
	runPolicySimulateCommand,
	runPolicyTestCommand,
	type SimulationFailure,
} from './commands/policy.ts';

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
  umbod configure [--agent codex|cursor|claude|gemini|opencode|pi|other] [--url http://127.0.0.1:9090] [--output .umbod]
  umbod analyze tools|rules|coverage [--env path] [--since 14d] [--project dir] [--workspace id] [--agent name] [--json]
  umbod policy simulate <candidate.toml> [--env baseline.toml] [--database path] [--since 30d] [--limit 2000|--all] [--fail-on check] [--json]
  umbod policy test <manifest.toml>
  umbod policy lint <manifest.toml> [--json] [--fail-on-warnings]
  umbod policy draft [--env baseline.toml] [--database path] [--limit 2000] [--max-rules 25] [--json]
  umbod database status [--env path|--database path] [--older-than-days 90] [--json]
  umbod database cleanup --older-than-days 90 --dry-run [--env path|--database path] [--json]
  umbod database cleanup --preview-receipt receipt --execute [--env path|--database path] [--json]
  umbod database compact --execute [--env path|--database path] [--json]

Commands:
  start       Load a manifest, start the local server, and initialize SQLite.
  configure   Create configuration for agent settings files.
  analyze     Report tool usage, rule health, or transcript coverage.
  policy      Simulate a candidate manifest against historical audit calls without activating it.
  database    Inspect, preview cleanup, explicitly prune, or compact the Umbod-owned audit database.
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
	if (action === 'test' && candidatePath && !candidatePath.startsWith('--') && policyArgs.length === 0) {
		const report = await runPolicyTestCommand(candidatePath);
		if (report.failed > 0) process.exitCode = 2;
		return;
	}
	if (action === 'lint' && candidatePath && !candidatePath.startsWith('--')) {
		const allowed = new Set(['--json', '--fail-on-warnings']);
		for (const argument of policyArgs)
			if (!allowed.has(argument)) throw new Error(`unknown policy lint argument "${argument}"`);
		const findings = await runPolicyLintCommand(candidatePath, hasFlag(policyArgs, '--json'));
		if (findings.length > 0 && hasFlag(policyArgs, '--fail-on-warnings')) process.exitCode = 2;
		return;
	}
	if (action === 'draft') {
		const draftArgs = candidatePath === undefined ? policyArgs : [candidatePath, ...policyArgs];
		const valueFlags = new Set(['--env', '--database', '--limit', '--max-rules']);
		for (let index = 0; index < draftArgs.length; index += 1) {
			const flag = draftArgs[index] as string;
			if (flag === '--json') continue;
			if (!valueFlags.has(flag)) throw new Error(`unknown policy draft argument "${flag}"`);
			if (draftArgs[index + 1] === undefined) throw new Error(`missing value for ${flag}`);
			index += 1;
		}
		await runPolicyDraftCommand({
			baselinePath: readFlag(draftArgs, '--env'),
			databasePath: readFlag(draftArgs, '--database'),
			limit: readIntFlag(draftArgs, '--limit'),
			maxRules: readIntFlag(draftArgs, '--max-rules'),
			json: hasFlag(draftArgs, '--json'),
		});
		return;
	}
	if (action !== 'simulate' || !candidatePath || candidatePath.startsWith('--')) {
		throw new Error('policy requires: policy simulate, policy test, or policy lint with a manifest path');
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

function databaseAction(value: string | undefined): DatabaseAction {
	if (value === 'status' || value === 'cleanup' || value === 'compact') return value;
	throw new Error('database requires one of: status, cleanup, compact');
}

const DATABASE_VALUE_FLAGS = new Set(['--env', '--database', '--older-than-days', '--preview-receipt']);
const DATABASE_BOOLEAN_FLAGS = new Set(['--dry-run', '--execute', '--json', '--compact-after-cleanup']);

// fallow-ignore-next-line complexity -- strict validation walks the small database option grammar once.
function validateDatabaseArgs(args: string[]): void {
	const seen = new Set<string>();
	for (let index = 0; index < args.length; index += 1) {
		const flag = args[index] as string;
		if (!DATABASE_VALUE_FLAGS.has(flag) && !DATABASE_BOOLEAN_FLAGS.has(flag)) {
			throw new Error(`unknown database argument "${flag}"`);
		}
		if (seen.has(flag)) throw new Error(`duplicate database argument "${flag}"`);
		seen.add(flag);
		if (DATABASE_VALUE_FLAGS.has(flag)) {
			const value = args[index + 1];
			if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
			index += 1;
		}
	}
}

async function runDatabaseCli(args: string[]): Promise<void> {
	const [action, ...databaseArgs] = args;
	validateDatabaseArgs(databaseArgs);
	await runDatabaseCommand(databaseAction(action), {
		envPath: readFlag(databaseArgs, '--env'),
		databasePath: readFlag(databaseArgs, '--database'),
		olderThanDays: readIntFlag(databaseArgs, '--older-than-days'),
		dryRun: hasFlag(databaseArgs, '--dry-run'),
		previewReceipt: readFlag(databaseArgs, '--preview-receipt'),
		execute: hasFlag(databaseArgs, '--execute'),
		json: hasFlag(databaseArgs, '--json'),
		compactAfterCleanup: hasFlag(databaseArgs, '--compact-after-cleanup') ? true : undefined,
	});
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
	if (command === 'database') return runDatabaseCli(args);
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
