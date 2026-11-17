import { resolve } from '$app/paths';

/**
 * The app's base path: '' at the root, '/site-studio' in production.
 * SvelteKit 3 no longer exports `base`; `resolve('')` is the base followed by '/'.
 */
export function appBasePath(): string {
	return resolve('').slice(0, -1);
}

/** The project dashboard: the base path, or '/' at the root. */
export function dashboardPath(): string {
	return appBasePath() || '/';
}

/** The editor page for one project. */
export function editorPath(projectId: string): string {
	return `${appBasePath()}/editor/${projectId}`;
}

/**
 * Resolves a path relative to the app's base path
 * @param path - The path to resolve (e.g., '/api/projects')
 * @returns The full path including base (e.g., '/site-studio/api/projects')
 */
export function resolvePath(path: string): string {
	// Remove leading slash from path to avoid double slashes
	const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
	const base = appBasePath();
	// If base is empty, just return the path with leading slash
	return base ? `${base}/${normalizedPath}` : `/${normalizedPath}`;
}
