import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess({ script: true }),

	kit: {
		adapter: adapter({
			fallback: 'index.html'
		}),
		// Base path for deployment under a subdirectory
		// Set PUBLIC_BASE_PATH environment variable to configure (e.g., '/site-studio')
		// Leave empty or '/' for root deployment
		paths: {
			base: process.env.PUBLIC_BASE_PATH || ''
		}
	}
};

export default config;
