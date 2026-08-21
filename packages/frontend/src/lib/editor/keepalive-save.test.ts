import { describe, expect, it } from 'vitest';
import type { SaveSnapshot } from './autosave';
import { buildKeepaliveSave } from './keepalive-save';

const snapshot: SaveSnapshot = {
	projectId: 'project-1',
	filePath: 'index.html',
	content: '<h1>Hello</h1>'
};

function parseBody(init: RequestInit) {
	const body = init.body;
	if (body === null || body === undefined) throw new Error('expected a request body');
	return JSON.parse(body.toString());
}

describe('buildKeepaliveSave', () => {
	it('builds a credentialed keepalive POST with CSRF and base etag', () => {
		const request = buildKeepaliveSave(snapshot, {
			csrfToken: 'csrf-token',
			url: '/api/projects/project-1/file',
			baseEtag: 'etag-1'
		});

		expect(request.url).toBe('/api/projects/project-1/file');
		expect(request.init.method).toBe('POST');
		expect(request.init.keepalive).toBe(true);
		expect(request.init.credentials).toBe('include');
		expect(request.init.headers).toMatchObject({
			'Content-Type': 'application/json',
			'X-CSRF-Token': 'csrf-token'
		});
		expect(parseBody(request.init)).toEqual({
			path: 'index.html',
			content: '<h1>Hello</h1>',
			baseEtag: 'etag-1'
		});
	});

});
