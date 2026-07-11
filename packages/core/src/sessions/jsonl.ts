const MAX_CARRY_BYTES = 16 * 1024 * 1024;

interface JsonlState {
	carry: string;
	discardingOversizedLine: boolean;
}

function parseRecord(line: string): unknown | undefined {
	if (line.length === 0 || line.length > MAX_CARRY_BYTES) return undefined;
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}

function consumeLines(text: string, state: JsonlState): unknown[] {
	const records: unknown[] = [];
	let start = 0;
	for (let newline = text.indexOf('\n'); newline !== -1; newline = text.indexOf('\n', start)) {
		const record = parseRecord(text.slice(start, newline).trim());
		if (record !== undefined) records.push(record);
		start = newline + 1;
	}
	state.carry = text.slice(start);
	if (state.carry.length > MAX_CARRY_BYTES) {
		state.carry = '';
		state.discardingOversizedLine = true;
	}
	return records;
}

async function* fileChunks(path: string): AsyncGenerator<Uint8Array> {
	const reader = Bun.file(path).stream().getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			yield value;
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Reads newline-delimited JSON without loading an entire transcript into memory.
 * A malformed or oversized line is ignored so a damaged transcript cannot stop
 * analysis of the rest of the session.
 */
export async function* jsonlRecords(path: string): AsyncGenerator<unknown> {
	const decoder = new TextDecoder();
	const state: JsonlState = { carry: '', discardingOversizedLine: false };

	for await (const chunk of fileChunks(path)) {
		let text = decoder.decode(chunk, { stream: true });
		if (state.discardingOversizedLine) {
			const newline = text.indexOf('\n');
			if (newline === -1) continue;
			text = text.slice(newline + 1);
			state.discardingOversizedLine = false;
		}
		for (const record of consumeLines(state.carry + text, state)) yield record;
	}

	if (state.discardingOversizedLine) return;
	for (const record of consumeLines(state.carry + decoder.decode(), state)) yield record;
	const finalRecord = parseRecord(state.carry.trim());
	if (finalRecord !== undefined) yield finalRecord;
}
