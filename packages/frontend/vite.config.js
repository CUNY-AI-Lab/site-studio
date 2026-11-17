import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

/**
 * Base path for deployment under a subdirectory, from PUBLIC_BASE_PATH
 * (production builds use '/site-studio'). Leave it unset for a root deployment.
 * @param {string | undefined} value
 * @returns {'' | `/${string}`}
 */
function basePath(value) {
	if (!value) return '';
	if (value.startsWith('/') && !value.endsWith('/')) return /** @type {`/${string}`} */ (value);
	throw new Error(`PUBLIC_BASE_PATH must start with '/' and not end with '/': ${value}`);
}

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			preprocess: vitePreprocess({ script: true }),
			adapter: adapter({
				fallback: 'index.html'
			}),
			paths: {
				base: basePath(process.env.PUBLIC_BASE_PATH)
			}
		})
	],
	build: {
		rolldownOptions: {
			output: {
				// SvelteKit 3 owns Rolldown's codeSplitting (manualChunks is ignored), so
				// vendor chunks are groups it merges with its own manifest group.
				codeSplitting: {
					groups: [
						{
							// Keep the CodeMirror stack together. Splitting lang/core/kit separately
							// produced circular chunk imports in the built editor bundle.
							name: 'vendor-codemirror',
							test: /[\\/]node_modules[\\/](@codemirror|@lezer|codemirror)[\\/]/
						},
						{
							name: 'vendor-markdown',
							test: /[\\/]node_modules[\\/](marked|marked-highlight|highlight\.js)[\\/]/
						},
						{
							name: 'vendor-onboarding',
							test: /[\\/]node_modules[\\/]driver\.js[\\/]/
						}
					]
				}
			}
		}
	},
	server: {
		port: 5173,
		proxy: {
			'/api': {
				target: 'http://localhost:8792',
				changeOrigin: true,
				ws: true
			},
			'/preview': {
				target: 'http://localhost:8792',
				changeOrigin: true
			},
			'/u': {
				target: 'http://localhost:8792',
				changeOrigin: true
			}
		}
	}
});
