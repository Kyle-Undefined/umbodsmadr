const MAX_CARRY_BYTES = 16 * 1024 * 1024;

/**
 * Reads newline-delimited JSON without loading an entire transcript into memory.
 * A malformed or oversized line is ignored so a damaged transcript cannot stop
 * analysis of the rest of the session.
 */
export async function* jsonlRecords(path: string): AsyncGenerator<unknown> {
	const decoder = new TextDecoder();
	let carry = '';
	let discardingOversizedLine = false;

	const consume = function* (text: string): Generator<unknown> {
		let start = 0;
		while (true) {
			const newline = text.indexOf('\n', start);
			if (newline === -1) break;
			const line = text.slice(start, newline).trim();
			start = newline + 1;
			if (line.length === 0 || line.length > MAX_CARRY_BYTES) continue;
			try {
				yield JSON.parse(line);
			} catch {
				// Session logs may be interrupted mid-write; ignore that record.
			}
		}
		carry = text.slice(start);
		if (carry.length > MAX_CARRY_BYTES) {
			carry = '';
			discardingOversizedLine = true;
		}
	};

	for await (const chunk of Bun.file(path).stream()) {
		let text = decoder.decode(chunk, { stream: true });
		if (discardingOversizedLine) {
			const newline = text.indexOf('\n');
			if (newline === -1) continue;
			text = text.slice(newline + 1);
			discardingOversizedLine = false;
		}
		for (const record of consume(carry + text)) yield record;
	}

	if (!discardingOversizedLine) {
		for (const record of consume(carry + decoder.decode())) yield record;
		const line = carry.trim();
		if (line.length > 0 && line.length <= MAX_CARRY_BYTES) {
			try {
				yield JSON.parse(line);
			} catch {
				// Ignore a truncated final record.
			}
		}
	}
}
