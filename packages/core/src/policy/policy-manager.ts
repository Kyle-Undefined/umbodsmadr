import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { EvaluationResult, Manifest, ToolCall } from '../core/types.ts';
import { parseManifestSource } from '../config/manifest.ts';
import { errorMessage } from '../utils/errors.ts';
import { PolicyEngine } from './engine.ts';

export type PolicyReloadStatus = 'active' | 'error';

export interface PolicyStatus {
	sourceHash: string;
	activeHash: string;
	loadedAt: string;
	generation: number;
	reloadStatus: PolicyReloadStatus;
	reloadError?: string;
}

export interface PolicyEvaluation {
	result: EvaluationResult;
	status: PolicyStatus;
	manifest: Manifest;
}

interface ActivePolicy {
	manifest: Manifest;
	engine: PolicyEngine;
	status: PolicyStatus;
}

function hashSource(source: string): string {
	return createHash('sha256').update(source).digest('hex');
}

function normalizedHash(manifest: Manifest): string {
	return hashSource(JSON.stringify(manifest));
}

export class PolicyManager {
	private active: ActivePolicy;
	private sourceHash: string;
	private reloadError?: string;
	private reloadAttempt = 0;

	constructor(manifest: Manifest, sourceHash = normalizedHash(manifest)) {
		this.sourceHash = sourceHash;
		this.active = {
			manifest,
			engine: new PolicyEngine(manifest),
			status: {
				sourceHash,
				activeHash: sourceHash,
				loadedAt: new Date().toISOString(),
				generation: 1,
				reloadStatus: 'active',
			},
		};
	}

	static async load(manifestPath: string): Promise<PolicyManager> {
		const source = await readFile(manifestPath, 'utf8');
		return new PolicyManager(parseManifestSource(source, manifestPath), hashSource(source));
	}

	// fallow-ignore-next-line unused-class-member -- public host API and dynamic server dependency
	get manifest(): Manifest {
		return this.active.manifest;
	}

	status(): PolicyStatus {
		return {
			...this.active.status,
			sourceHash: this.sourceHash,
			reloadStatus: this.reloadError === undefined ? 'active' : 'error',
			...(this.reloadError === undefined ? {} : { reloadError: this.reloadError }),
		};
	}

	// fallow-ignore-next-line unused-class-member -- public host API and dynamic server dependency
	evaluate(call: ToolCall): PolicyEvaluation {
		const snapshot = this.active;
		return { result: snapshot.engine.evaluate(call), status: snapshot.status, manifest: snapshot.manifest };
	}

	// fallow-ignore-next-line unused-class-member -- public host API and filesystem watcher callback
	async reload(manifestPath: string): Promise<PolicyStatus> {
		const attempt = ++this.reloadAttempt;
		try {
			const source = await readFile(manifestPath, 'utf8');
			const sourceHash = hashSource(source);
			if (attempt !== this.reloadAttempt) return this.status();
			this.sourceHash = sourceHash;
			if (sourceHash === this.active.status.activeHash) {
				this.reloadError = undefined;
				return this.status();
			}
			const manifest = parseManifestSource(source, manifestPath);
			const engine = new PolicyEngine(manifest);
			if (attempt !== this.reloadAttempt) return this.status();
			if (
				manifest.env.name !== this.active.manifest.env.name ||
				manifest.server.host !== this.active.manifest.server.host ||
				manifest.server.port !== this.active.manifest.server.port
			) {
				throw new Error('manifest env.name and server host/port require a restart');
			}
			const previous = this.active;
			this.active = {
				manifest,
				engine,
				status: {
					sourceHash: this.sourceHash,
					activeHash: this.sourceHash,
					loadedAt: new Date().toISOString(),
					generation: previous.status.generation + 1,
					reloadStatus: 'active',
				},
			};
			this.reloadError = undefined;
		} catch (error) {
			if (attempt !== this.reloadAttempt) return this.status();
			this.reloadError = errorMessage(error);
		}
		return this.status();
	}
}
