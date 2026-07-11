import * as readline from 'node:readline';

import type { ApprovalDecision, ToolCall } from '@umbod/core';

function formatPrompt(call: ToolCall, reason: string): string {
	const lines = [
		'',
		'┌─ APPROVAL REQUIRED ─────────────────────────────────────────',
		`│  Agent   : ${call.agent}`,
		`│  Tool    : ${call.tool}`,
		`│  Command : ${call.command}`,
		`│  Reason  : ${reason}`,
		'└─────────────────────────────────────────────────────────────',
		'',
	];
	return lines.join('\n');
}

async function promptDecision(call: ToolCall, reason: string): Promise<ApprovalDecision> {
	return new Promise((resolve) => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		let settled = false;

		const settle = (decision: ApprovalDecision) => {
			if (settled) return;
			settled = true;
			resolve(decision);
		};

		process.stdout.write(formatPrompt(call, reason));
		rl.on('close', () => {
			settle('block');
		});

		rl.question('Approve? [y/n] ', (answer) => {
			settle(answer.trim().toLowerCase() === 'y' ? 'allow' : 'block');
			rl.close();
		});
	});
}

type QueueItem = {
	call: ToolCall;
	reason: string;
	resolve: (decision: ApprovalDecision) => void;
};

export class CliApprovalQueue {
	private readonly queue: QueueItem[] = [];
	private processing = false;

	// fallow-ignore-next-line unused-class-member -- passed to core as the CLI approval callback
	async request(call: ToolCall, reason: string): Promise<ApprovalDecision> {
		return new Promise((resolve) => {
			this.queue.push({ call, reason, resolve });
			if (!this.processing) {
				void this.drain();
			}
		});
	}

	private async drain(): Promise<void> {
		this.processing = true;

		try {
			while (this.queue.length > 0) {
				const item = this.queue.shift()!;

				try {
					const decision = await promptDecision(item.call, item.reason);
					item.resolve(decision);
				} catch {
					item.resolve('block');
				}
			}
		} finally {
			this.processing = false;
		}
	}
}
