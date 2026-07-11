import type { Manifest } from '@umbod/core';

export function makeManifest(overrides: Partial<Manifest> = {}): Manifest {
	return {
		env: { name: 'test', version: '1.0.0', timeout: 5 },
		policy: { default_unknown: 'block', approval_method: 'web' },
		rules: {},
		server: { host: '127.0.0.1', port: 9090 },
		...overrides,
	};
}
