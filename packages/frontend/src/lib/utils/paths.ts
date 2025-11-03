import { base } from '$app/paths';

/**
 * Resolves a path relative to the app's base path
 * @param path - The path to resolve (e.g., '/api/projects')
 * @returns The full path including base (e.g., '/site-studio/api/projects')
 */
export function resolvePath(path: string): string {
	// Remove leading slash from path to avoid double slashes
	const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
	// If base is empty, just return the path with leading slash
	return base ? `${base}/${normalizedPath}` : `/${normalizedPath}`;
}
