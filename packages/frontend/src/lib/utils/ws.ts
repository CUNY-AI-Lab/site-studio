import { resolvePath } from '$lib/utils/paths';

export function resolveWebSocketPath(path: string): string {
	if (typeof window === 'undefined') {
		throw new Error('WebSocket URLs can only be resolved in the browser');
	}

	const url = new URL(resolvePath(path), window.location.origin);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	return url.toString();
}
