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
				pathname: '/editor/project-1',
				search: '?panel=code',
				assign: assignMock
			}
		});
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
			'/login?rt=%2Feditor%2Fproject-1%3Fpanel%3Dcode'
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
});
