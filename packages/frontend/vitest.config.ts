import { svelte } from '@sveltejs/vite-plugin-svelte';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Standalone vitest config for the frontend package. We use the `svelte()`
// plugin (not `sveltekit()`) so tests compile .svelte files without pulling in
// the full SvelteKit build graph. `$app/*` virtual modules aren't provided by
// the plain svelte plugin, so `$app/paths` is aliased to a test stub.
export default defineConfig({
	plugins: [
		svelte({
			preprocess: vitePreprocess(),
			// Compile in dev/browser mode so runes-based components mount and update
			// under jsdom the way they do in the app.
			compilerOptions: { dev: true }
		})
	],
	resolve: {
		alias: {
			$lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
			'$app/paths': fileURLToPath(new URL('./src/test-stubs/app-paths.ts', import.meta.url))
		},
		// @testing-library/svelte needs the browser build of svelte so mounting
		// works under jsdom.
		conditions: ['browser']
	},
	test: {
		environment: 'jsdom',
		globals: true,
		setupFiles: ['./vitest-setup.ts'],
		include: ['src/**/*.{test,spec}.{js,ts}'],
		// Keep test output quiet; components that log to console on error paths are
		// asserted explicitly where relevant.
		clearMocks: true,
		restoreMocks: true
	}
});
