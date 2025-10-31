import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit()
	],
	server: {
		port: 5173,
		proxy: {
			'/api': {
				target: 'http://localhost:3001',
				changeOrigin: true
			},
			'/preview': {
				target: 'http://localhost:3001',
				changeOrigin: true
			}
		}
	}
});
