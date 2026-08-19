import type { SaveSnapshot } from './autosave';

interface KeepaliveSaveOptions {
	csrfToken: string;
	url: string;
	baseEtag?: string | null;
}

interface KeepalivePayload {
	path: string;
	content: string;
	baseEtag?: string;
}

interface KeepaliveRequest {
	url: string;
	init: RequestInit;
}

export function buildKeepaliveSave(
	snapshot: SaveSnapshot,
	options: KeepaliveSaveOptions
): KeepaliveRequest {
	const payload: KeepalivePayload = {
		path: snapshot.filePath,
		content: snapshot.content
	};
	if (options.baseEtag) {
		payload.baseEtag = options.baseEtag;
	}

	const init: RequestInit = {
		method: 'POST',
		keepalive: true,
		credentials: 'include',
		headers: {
			'Content-Type': 'application/json',
			'X-CSRF-Token': options.csrfToken
		},
		body: JSON.stringify(payload)
	};

	return { url: options.url, init };
}
