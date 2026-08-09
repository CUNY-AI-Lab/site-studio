import type { SaveSnapshot } from './autosave';

interface KeepaliveSaveOptions {
	csrfToken: string;
	url: string;
	baseEtag?: string | null;
}

export function buildKeepaliveSave(
	snapshot: SaveSnapshot,
	options: KeepaliveSaveOptions
): { url: string; init: RequestInit } {
	return {
		url: options.url,
		init: {
			method: 'POST',
			keepalive: true,
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json',
				'X-CSRF-Token': options.csrfToken
			},
			body: JSON.stringify({
				path: snapshot.filePath,
				content: snapshot.content,
				...(options.baseEtag ? { baseEtag: options.baseEtag } : {})
			})
		}
	};
}
