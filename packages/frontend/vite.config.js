import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit()
	],
	build: {
		rollupOptions: {
			output: {
				manualChunks(id) {
					const normalizedId = id.replace(/\\/g, '/');

					if (
						normalizedId.includes('/node_modules/@codemirror/lang-') ||
						normalizedId.includes('/node_modules/@lezer/')
					) {
						return 'vendor-codemirror-lang';
					}

					if (normalizedId.includes('/node_modules/@codemirror/')) {
						return 'vendor-codemirror-core';
					}

					if (normalizedId.includes('/node_modules/codemirror/')) {
						return 'vendor-codemirror-kit';
					}

					if (
						normalizedId.includes('/node_modules/marked/') ||
						normalizedId.includes('/node_modules/marked-highlight/') ||
						normalizedId.includes('/node_modules/highlight.js/')
					) {
						return 'vendor-markdown';
					}

					if (normalizedId.includes('/node_modules/driver.js/')) {
						return 'vendor-onboarding';
					}
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
			'/sites': {
				target: 'http://localhost:8792',
				changeOrigin: true
			}
		}
	}
});
