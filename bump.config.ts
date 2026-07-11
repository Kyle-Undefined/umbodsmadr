import { defineConfig } from 'bumpp';

export default defineConfig({
	confirm: false,
	commit: false,
	tag: false,
	push: false,
	files: ['package.json', 'packages/core/package.json', 'packages/cli/package.json'],
});
