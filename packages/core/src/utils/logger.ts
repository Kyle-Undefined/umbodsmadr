type LogLevel = 'info' | 'warn' | 'error';

function emit(level: LogLevel, message: string, data?: unknown): void {
	const stamp = new Date().toISOString();
	let payload = '';

	if (data !== undefined) {
		try {
			payload = ` ${JSON.stringify(data)}`;
		} catch {
			payload = ' [unserializable]';
		}
	}

	const formatted = `[${stamp}] ${level.toUpperCase()} ${message}${payload}`;

	switch (level) {
		case 'error':
			console.error(formatted);
			break;
		case 'warn':
			console.warn(formatted);
			break;
		default:
			console.info(formatted);
			break;
	}
}

export const logger = {
	info(message: string, data?: unknown): void {
		emit('info', message, data);
	},
	warn(message: string, data?: unknown): void {
		emit('warn', message, data);
	},
	error(message: string, data?: unknown): void {
		emit('error', message, data);
	},
};
