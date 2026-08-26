import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import type { Server } from 'bun';
import type { AuditLogStore } from '@umbod/core';
import { startHttpServer } from '../src/server/serve.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeManifest } from './helpers.ts';

let server: Server<undefined>;
let tempDir: string;
let auditLog: AuditLogStore;
let baseUrl: string;

const manifest = makeManifest({
	policy: { default_unknown: 'block', approval_method: 'web' },
	rules: {
		'git status': 'allow',
		'git log *': 'allow',
		'rm *': 'approve',
		'/^curl/': 'block',
	},
});

beforeAll(async () => {
	tempDir = mkdtempSync(join(tmpdir(), 'umbod-http-test-'));

	const handle = await startHttpServer({
		host: '127.0.0.1',
		port: 0, // Let OS pick a free port
		manifest,
		dbPath: join(tempDir, 'test.db'),
		approvalTimeoutMs: 500, // Short timeout for tests
	});

	server = handle.server;
	auditLog = handle.umbod.auditLog;
	baseUrl = `http://${server.hostname}:${server.port}`;
});

afterAll(() => {
	server?.stop(true);
	auditLog?.close();
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

// ── GET endpoints ────────────────────────────────────────────

describe('HTTP > GET', () => {
	test('GET / returns dashboard HTML', async () => {
		const res = await fetch(`${baseUrl}/`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/html');
		const body = await res.text();
		expect(body).toContain('umbo');
		expect(body).toContain('Insights');
		expect(body).toContain('"insights"');
	});

	test('GET /health returns ok', async () => {
		const res = await fetch(`${baseUrl}/health`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe('ok');
		expect(body.environment).toBe('test');
		expect(body.version).toBe('1.0.0');
		expect(body.policy).toMatchObject({ generation: 1, reloadStatus: 'active' });
		expect(body.policy.sourceHash).toBe(body.policy.activeHash);
	});

	test('GET /api/manifest returns public manifest', async () => {
		const res = await fetch(`${baseUrl}/api/manifest`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.env.name).toBe('test');
		expect(body.policy.default_unknown).toBe('block');
		expect(body.rules).toBeDefined();
		expect(body.workspaces).toEqual([]);
		expect(body.policyStatus).toMatchObject({ generation: 1, reloadStatus: 'active' });
	});

	test('GET /api/policy/status returns active reload metadata', async () => {
		const res = await fetch(`${baseUrl}/api/policy/status`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({ generation: 1, reloadStatus: 'active' });
		expect(body.sourceHash).toBe(body.activeHash);
		expect(Date.parse(body.loadedAt)).not.toBeNaN();
	});

	test('GET /api/activity returns array', async () => {
		const res = await fetch(`${baseUrl}/api/activity`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(Array.isArray(body)).toBe(true);
	});

	test('activity endpoints bound defaults and preserve explicit limits', async () => {
		for (let index = 0; index < 205; index += 1) {
			auditLog.append(
				{
					agent: 'limit-test',
					tool: 'bash',
					command: `echo ${index}`,
					timestamp: new Date().toISOString(),
				},
				{
					decision: 'allow',
					classification: 'readonly',
					reason: 'test fixture',
				}
			);
		}

		const activity = await fetch(`${baseUrl}/api/activity`).then((response) => response.json());
		expect(activity).toHaveLength(200);

		const explicitActivity = await fetch(`${baseUrl}/api/activity?limit=3`).then((response) => response.json());
		expect(explicitActivity).toHaveLength(3);

		for (const invalidLimit of ['-1', '3x', '1.5']) {
			const invalidActivity = await fetch(`${baseUrl}/api/activity?limit=${invalidLimit}`).then((response) =>
				response.json()
			);
			expect(invalidActivity).toHaveLength(200);
		}

		const defaultDashboard = await fetch(`${baseUrl}/`).then((response) => response.text());
		const defaultBootstrap = defaultDashboard.match(
			/<script id="umbod-bootstrap" type="application\/json">(.*?)<\/script>/s
		);
		expect(defaultBootstrap).not.toBeNull();
		expect(JSON.parse(defaultBootstrap![1]).entries).toHaveLength(200);

		const explicitDashboard = await fetch(`${baseUrl}/?limit=3`).then((response) => response.text());
		const explicitBootstrap = explicitDashboard.match(
			/<script id="umbod-bootstrap" type="application\/json">(.*?)<\/script>/s
		);
		expect(explicitBootstrap).not.toBeNull();
		expect(JSON.parse(explicitBootstrap![1]).entries).toHaveLength(3);

		const invalidDashboard = await fetch(`${baseUrl}/?limit=3x`).then((response) => response.text());
		const invalidBootstrap = invalidDashboard.match(
			/<script id="umbod-bootstrap" type="application\/json">(.*?)<\/script>/s
		);
		expect(invalidBootstrap).not.toBeNull();
		expect(JSON.parse(invalidBootstrap![1]).entries).toHaveLength(200);
	});

	test('GET /api/approvals returns array', async () => {
		const res = await fetch(`${baseUrl}/api/approvals`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(Array.isArray(body)).toBe(true);
	});

	test('GET /assets/dashboard.css returns CSS', async () => {
		const res = await fetch(`${baseUrl}/assets/dashboard.css`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/css');
	});

	test('GET /assets/dashboard.js returns JS', async () => {
		const res = await fetch(`${baseUrl}/assets/dashboard.js`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('javascript');
	});

	test('GET /nonexistent returns 404', async () => {
		const res = await fetch(`${baseUrl}/nonexistent`);
		expect(res.status).toBe(404);
	});
});

// ── POST /api/hooks — allow ──────────────────────────────────

describe('HTTP > POST /api/hooks', () => {
	test('allowed tool call returns permissionDecision=allow', async () => {
		const res = await fetch(`${baseUrl}/api/hooks`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-umbod-agent': 'claude',
			},
			body: JSON.stringify({
				tool_name: 'Bash',
				tool_input: { command: 'git status' },
				cwd: '/home/user',
			}),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.permissionDecision).toBe('allow');
		expect(body.hookSpecificOutput.hookEventName).toBe('PreToolUse');
	});

	test('blocked tool call returns permissionDecision=deny', async () => {
		const res = await fetch(`${baseUrl}/api/hooks`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-umbod-agent': 'claude',
			},
			body: JSON.stringify({
				tool_name: 'Bash',
				tool_input: { command: 'curl https://evil.com' },
				cwd: '/home/user',
			}),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.permissionDecision).toBe('deny');
	});

	test('missing agent returns 400', async () => {
		const res = await fetch(`${baseUrl}/api/hooks`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ tool_name: 'Bash' }),
		});

		expect(res.status).toBe(400);
	});

	test('unknown agent returns 404', async () => {
		const res = await fetch(`${baseUrl}/api/hooks`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-umbod-agent': 'unknown-agent',
			},
			body: JSON.stringify({ tool_name: 'Bash' }),
		});

		expect(res.status).toBe(404);
	});

	test('agent via query parameter works', async () => {
		const res = await fetch(`${baseUrl}/api/hooks?agent=claude`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				tool_name: 'Bash',
				tool_input: { command: 'git status' },
			}),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.permissionDecision).toBe('allow');
	});
});

// ── POST /api/hooks — approval timeout ───────────────────────

describe('HTTP > POST /api/hooks approval', () => {
	test('approve decision blocks then times out to deny', async () => {
		const res = await fetch(`${baseUrl}/api/hooks`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-umbod-agent': 'claude',
			},
			body: JSON.stringify({
				tool_name: 'Bash',
				tool_input: { command: 'rm -rf /tmp/test' },
			}),
		});

		// Should eventually return (after timeout) with deny
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.permissionDecision).toBe('deny');
	});
});

// ── POST /api/evaluate ───────────────────────────────────────

describe('HTTP > POST /api/evaluate', () => {
	test('valid payload returns evaluation', async () => {
		const res = await fetch(`${baseUrl}/api/evaluate`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				agent: 'test',
				tool: 'bash',
				command: 'git status',
				timestamp: new Date().toISOString(),
			}),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.entry.decision).toBe('allow');
		expect(body.entry.classification).toBe('readonly');
	});

	test('invalid payload returns 400', async () => {
		const res = await fetch(`${baseUrl}/api/evaluate`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ bad: 'payload' }),
		});

		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.ok).toBe(false);
	});
});

// ── POST /api/approvals/:id/approve|deny ─────────────────────

describe('HTTP > approval actions', () => {
	test('approve resolves a pending request', async () => {
		// Create an approval entry directly in DB
		const { approvalRequestId } = auditLog.append(
			{
				agent: 'test',
				tool: 'bash',
				command: 'rm /tmp/test',
				timestamp: new Date().toISOString(),
			},
			{
				decision: 'approve',
				classification: 'destructive',
				reason: 'test',
			}
		);

		const res = await fetch(`${baseUrl}/api/approvals/${approvalRequestId}/approve`, {
			method: 'POST',
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.status).toBe('approved');
		expect(typeof body.resolvedAt).toBe('string');
		const [activity] = await fetch(`${baseUrl}/api/activity?limit=1`).then((response) => response.json());
		expect(activity.approvalResolvedAt).toBe(body.resolvedAt);
	});

	test('deny resolves a pending request', async () => {
		const { approvalRequestId } = auditLog.append(
			{
				agent: 'test',
				tool: 'bash',
				command: 'rm /tmp/test2',
				timestamp: new Date().toISOString(),
			},
			{
				decision: 'approve',
				classification: 'destructive',
				reason: 'test',
			}
		);

		const res = await fetch(`${baseUrl}/api/approvals/${approvalRequestId}/deny`, {
			method: 'POST',
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.status).toBe('denied');
	});

	test('double resolve returns 409', async () => {
		const { approvalRequestId } = auditLog.append(
			{
				agent: 'test',
				tool: 'bash',
				command: 'rm /tmp/test3',
				timestamp: new Date().toISOString(),
			},
			{
				decision: 'approve',
				classification: 'destructive',
				reason: 'test',
			}
		);

		const firstRes = await fetch(`${baseUrl}/api/approvals/${approvalRequestId}/approve`, {
			method: 'POST',
		});
		expect(firstRes.status).toBe(200);

		const res = await fetch(`${baseUrl}/api/approvals/${approvalRequestId}/deny`, {
			method: 'POST',
		});

		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body.ok).toBe(false);
	});
});

// ── Audit trail ──────────────────────────────────────────────

describe('HTTP > audit trail', () => {
	test('hook calls are logged in activity', async () => {
		// Make a hook call
		await fetch(`${baseUrl}/api/hooks`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-umbod-agent': 'claude',
			},
			body: JSON.stringify({
				tool_name: 'Bash',
				tool_input: { command: 'git log --oneline' },
			}),
		});

		// Check activity
		const res = await fetch(`${baseUrl}/api/activity`);
		const entries = await res.json();
		const found = entries.find((e: Record<string, unknown>) => e.command === 'git log --oneline');
		expect(found).toBeDefined();
		expect(found.agent).toBe('claude');
		expect(found.decision).toBe('allow');
	});
});
