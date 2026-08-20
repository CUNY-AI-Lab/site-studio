// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiResponseFetch } from './errors';

let fetchMock: ReturnType<typeof vi.fn>;
let assignMock: ReturnType<typeof vi.fn>;

describe('apiResponseFetch', () => {
	beforeEach(() => {
		fetchMock = vi.fn();
		assignMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		vi.stubGlobal('window', {
			location: {
				origin: 'https://studio.example.edu',
				pathname: '/editor/project-1',
				search: '?panel=code',
				assign: assignMock
			}
		});
	});

	it.each([
		['protocol-relative', '//evil.example/login'],
		['backslash-normalized', '/\\evil.example/login'],
		['dot-segment scheme-relative', '/..//evil.example/login'],
		['encoded dot-segment scheme-relative', '/foo/%2e%2e//evil.example/login'],
		['absolute', 'https://evil.example/login'],
		['non-path relative', 'login'],
		['non-URL scheme', 'javascript:alert(1)']
	])('ignores a %s login URL and uses the protected Site Studio path', async (_label, loginUrl) => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ error: 'authentication_required', login_url: loginUrl }), {
				status: 401,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		await expect(apiResponseFetch('/api/projects')).rejects.toBeInstanceOf(ApiError);

		expect(assignMock).toHaveBeenCalledWith(
			'https://tools.ailab.gc.cuny.edu/site-studio/editor/project-1?panel=code'
		);
	});

	it('preserves the current Site Studio path and query instead of trusting envelope URLs', async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					error: 'authentication_required',
					login_url: '/site-studio/?profile=production#ignored'
				}),
				{ status: 401, headers: { 'Content-Type': 'application/json' } }
			)
		);

		await expect(apiResponseFetch('/api/projects')).rejects.toBeInstanceOf(ApiError);

		expect(assignMock).toHaveBeenCalledWith(
			'https://tools.ailab.gc.cuny.edu/site-studio/editor/project-1?panel=code'
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('redirects to login and throws ApiError for authentication_required envelopes', async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					error: 'authentication_required',
					login_url: '/login'
				}),
				{ status: 401, headers: { 'Content-Type': 'application/json' } }
			)
		);

		await expect(apiResponseFetch('/api/projects')).rejects.toBeInstanceOf(ApiError);

		expect(assignMock).toHaveBeenCalledWith(
			'https://tools.ailab.gc.cuny.edu/site-studio/editor/project-1?panel=code'
		);
	});

	it('returns a non-envelope 401 response without redirecting', async () => {
		const response = new Response(JSON.stringify({ error: 'unauthorized' }), {
			status: 401,
			headers: { 'Content-Type': 'application/json' }
		});
		fetchMock.mockResolvedValue(response);

		await expect(apiResponseFetch('/api/projects')).resolves.toBe(response);

		expect(assignMock).not.toHaveBeenCalled();
	});

	it('returns a malformed 401 response without redirecting', async () => {
		const response = new Response('not-json', { status: 401 });
		fetchMock.mockResolvedValue(response);

		await expect(apiResponseFetch('/api/projects')).resolves.toBe(response);

		expect(assignMock).not.toHaveBeenCalled();
	});
});
