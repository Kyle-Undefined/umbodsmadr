import { isRecord } from '../utils/guards.ts';
import type { SessionLogSource } from './types.ts';

export function stringAt(value: unknown, key: string): string | undefined {
	return isRecord(value) && typeof value[key] === 'string' ? value[key] : undefined;
}

export function timestampInSourceWindow(timestamp: string, source: SessionLogSource): boolean {
	return !(source.since && timestamp < source.since) && !(source.until && timestamp > source.until);
}
