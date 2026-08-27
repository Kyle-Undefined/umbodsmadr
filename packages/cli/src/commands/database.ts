import {
	AuditLogStore,
	defaultDatabasePath,
	loadManifest,
	resolveEnvPath,
	type AuditCleanupExecution,
	type AuditCleanupPreview,
	type DatabaseCompactionResult,
	type DatabaseMaintenanceStatus,
} from '@umbod/core';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

export type DatabaseAction = 'status' | 'cleanup' | 'compact';

export interface DatabaseCommandOptions {
	envPath?: string;
	databasePath?: string;
	olderThanDays?: number;
	dryRun?: boolean;
	previewReceipt?: string;
	execute?: boolean;
	json?: boolean;
}

export type DatabaseCommandResult =
	| DatabaseMaintenanceStatus
	| AuditCleanupPreview
	| AuditCleanupExecution
	| DatabaseCompactionResult;

async function resolveDatabasePath(options: DatabaseCommandOptions): Promise<string> {
	if (options.databasePath) return resolve(options.databasePath);
	const manifestPath = resolveEnvPath(options.envPath);
	const manifest = await loadManifest(manifestPath);
	return defaultDatabasePath(manifestPath, manifest.env.name);
}

function output(result: DatabaseCommandResult, json: boolean | undefined): void {
	if (json) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}
	if ('previewReceipt' in result) {
		console.log(`Cleanup preview: ${result.eligibleAuditRows} eligible, ${result.retainedAuditRows} retained`);
		console.log(`Cutoff: ${result.cutoff}`);
		console.log(`Preview receipt: ${result.previewReceipt}`);
		return;
	}
	if ('deletedAuditRows' in result) {
		console.log(`Cleanup complete: ${result.deletedAuditRows} deleted, ${result.retainedAuditRows} retained`);
		console.log(result.message);
		return;
	}
	if ('filesBefore' in result) {
		console.log(
			`Compaction complete: main ${result.filesBefore.mainBytes} -> ${result.filesAfter.mainBytes} bytes; WAL ${result.filesBefore.walBytes} -> ${result.filesAfter.walBytes} bytes`
		);
		return;
	}
	console.log(`Audit rows: ${result.auditRows}`);
	console.log(
		`Database: ${result.databasePath}; main ${result.files.mainBytes} bytes; WAL ${result.files.walBytes} bytes; journal ${result.journalMode}`
	);
}

async function confirmDestructive(action: 'cleanup' | 'compaction', json: boolean | undefined): Promise<void> {
	if (json) return;
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error(`${action} requires --json for non-interactive execution`);
	}
	const prompt = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await prompt.question(`Type ${action} to confirm destructive database ${action}: `);
		if (answer !== action) throw new Error(`${action} cancelled`);
	} finally {
		prompt.close();
	}
}

// fallow-ignore-next-line complexity -- explicit destructive-mode state machine prevents ambiguous CLI combinations.
export async function runDatabaseCommand(
	action: DatabaseAction,
	options: DatabaseCommandOptions
): Promise<DatabaseCommandResult> {
	const databasePath = await resolveDatabasePath(options);
	const readOnlyOperation = action === 'status' || (action === 'cleanup' && options.dryRun === true);
	const store = new AuditLogStore(databasePath, {
		schemaMode: readOnlyOperation ? 'require-current' : 'migrate',
	});
	try {
		let result: DatabaseCommandResult;
		if (action === 'status') {
			if (options.dryRun || options.execute || options.previewReceipt) {
				throw new Error('database status does not accept cleanup or execution options');
			}
			result = store.databaseStatus(
				options.olderThanDays === undefined ? undefined : { olderThanDays: options.olderThanDays }
			);
		} else if (action === 'cleanup' && options.dryRun) {
			if (options.execute || options.previewReceipt) {
				throw new Error('--dry-run cannot be combined with --execute or --preview-receipt');
			}
			if (options.olderThanDays === undefined) throw new Error('cleanup --dry-run requires --older-than-days');
			result = store.previewCleanup({ olderThanDays: options.olderThanDays });
		} else if (action === 'cleanup') {
			if (!options.execute) throw new Error('cleanup execution requires --execute');
			if (!options.previewReceipt) throw new Error('cleanup execution requires --preview-receipt');
			await confirmDestructive('cleanup', options.json);
			result = store.executeCleanup({
				previewReceipt: options.previewReceipt,
				olderThanDays: options.olderThanDays,
				execute: true,
			});
		} else {
			if (!options.execute) throw new Error('compaction requires --execute');
			if (options.dryRun || options.previewReceipt || options.olderThanDays !== undefined) {
				throw new Error('compaction does not accept cleanup retention options');
			}
			await confirmDestructive('compaction', options.json);
			result = store.compactDatabase({ execute: true });
		}
		output(result, options.json);
		return result;
	} finally {
		store.close();
	}
}
