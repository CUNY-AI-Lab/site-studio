import { resolvePath } from '$lib/utils/paths';
import { browserWindow } from '$lib/contracts';

export function resolveWebSocketPath(
	path: string,
	query?: Record<string, string>
): string {
	const browser = browserWindow();
	if (!browser) {
		throw new Error('WebSocket URLs can only be resolved in the browser');
	}

	const url = new URL(resolvePath(path), browser.location.origin);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

	// Merge extra params without clobbering any already present on `path`.
	if (query) {
		for (const [key, value] of Object.entries(query)) {
			url.searchParams.set(key, value);
		}
	}

	return url.toString();
}
