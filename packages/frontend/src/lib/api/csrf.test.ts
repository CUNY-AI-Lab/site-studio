import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getCsrfToken, invalidateCsrfToken, csrfFetch } from './csrf';

// resolvePath depends on $app/paths (aliased to a test stub returning base '').
// So /api/csrf resolves to '/api/csrf' here.

function tokenResponse(token: string): Response {
	return new Response(JSON.stringify({ token }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' }
	});
}

function csrfFailure(): Response {
	return new Response(
		JSON.stringify({ error: 'csrf_verification_failed', message: 'stale token' }),
		{ status: 403, headers: { 'Content-Type': 'application/json' } }
	);
}

let fetchMock: ReturnType<typeof vi.fn>;

/** True if the request was a token fetch to /api/csrf. */
function isTokenFetch(call: unknown[]): boolean {
	return typeof call[0] === 'string' && (call[0] as string).endsWith('/api/csrf');
}

describe('csrf token client', () => {
	beforeEach(() => {
		// Reset module cache between tests so caching assertions are isolated.
		invalidateCsrfToken();
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		invalidateCsrfToken();
	});

	it('caches the token: two getCsrfToken calls make one network request', async () => {
		fetchMock.mockResolvedValue(tokenResponse('tok-1'));

		const first = await getCsrfToken();
		const second = await getCsrfToken();

		expect(first).toBe('tok-1');
		expect(second).toBe('tok-1');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('dedupes concurrent fetches into a single in-flight request', async () => {
		let resolveFetch!: (r: Response) => void;
		fetchMock.mockReturnValue(
			new Promise<Response>((resolve) => {
				resolveFetch = resolve;
			})
		);

		const p1 = getCsrfToken();
		const p2 = getCsrfToken();

		// Both callers are waiting on the same in-flight promise.
		expect(fetchMock).toHaveBeenCalledTimes(1);

		resolveFetch(tokenResponse('tok-concurrent'));
		const [a, b] = await Promise.all([p1, p2]);

		expect(a).toBe('tok-concurrent');
		expect(b).toBe('tok-concurrent');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('csrfFetch sets the X-CAIL-CSRF header on a POST', async () => {
		fetchMock.mockImplementation(async (input: unknown) => {
			if (typeof input === 'string' && input.endsWith('/api/csrf')) {
				return tokenResponse('tok-post');
			}
			return new Response('{}', { status: 200 });
		});

		await csrfFetch('/api/projects', { method: 'POST', body: '{}' });

		const requestCall = fetchMock.mock.calls.find((c) => !isTokenFetch(c));
		expect(requestCall).toBeDefined();
		const init = requestCall![1] as RequestInit;
		const headers = new Headers(init.headers);
		expect(headers.get('X-CAIL-CSRF')).toBe('tok-post');
		expect(init.credentials).toBe('include');
	});

	it('csrfFetch does NOT set the header on a GET and passes through', async () => {
		fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

		await csrfFetch('/api/projects', { method: 'GET' });

		// GET must not trigger a token fetch, and must not carry the CSRF header.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [, init] = fetchMock.mock.calls[0];
		const headers = new Headers((init as RequestInit).headers);
		expect(headers.has('X-CAIL-CSRF')).toBe(false);
		expect((init as RequestInit).credentials).toBe('include');
	});

	it('csrfFetch treats a method-less request as GET (no header)', async () => {
		fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

		await csrfFetch('/api/projects');

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [, init] = fetchMock.mock.calls[0];
		const headers = new Headers((init as RequestInit | undefined)?.headers);
		expect(headers.has('X-CAIL-CSRF')).toBe(false);
	});

	it('on csrf_verification_failed 403: invalidates, refetches token, retries exactly once', async () => {
		let tokenFetches = 0;
		let requestAttempts = 0;
		fetchMock.mockImplementation(async (input: unknown) => {
			if (typeof input === 'string' && input.endsWith('/api/csrf')) {
				tokenFetches += 1;
				return tokenResponse(`tok-${tokenFetches}`);
			}
			requestAttempts += 1;
			// First attempt gets a CSRF rejection; the retry succeeds.
			return requestAttempts === 1 ? csrfFailure() : new Response('{}', { status: 200 });
		});

		const response = await csrfFetch('/api/projects', { method: 'POST', body: '{}' });

		expect(response.status).toBe(200);
		// Two token fetches (initial + refetch) and two request attempts (original + one retry).
		expect(tokenFetches).toBe(2);
		expect(requestAttempts).toBe(2);

		// The retry used the fresh token.
		const requestCalls = fetchMock.mock.calls.filter((c) => !isTokenFetch(c));
		expect(requestCalls).toHaveLength(2);
		const retryHeaders = new Headers((requestCalls[1][1] as RequestInit).headers);
		expect(retryHeaders.get('X-CAIL-CSRF')).toBe('tok-2');
	});

	it('does not retry on a non-CSRF 403', async () => {
		let requestAttempts = 0;
		fetchMock.mockImplementation(async (input: unknown) => {
			if (typeof input === 'string' && input.endsWith('/api/csrf')) {
				return tokenResponse('tok-x');
			}
			requestAttempts += 1;
			return new Response(JSON.stringify({ error: 'forbidden' }), {
				status: 403,
				headers: { 'Content-Type': 'application/json' }
			});
		});

		const response = await csrfFetch('/api/projects', { method: 'POST', body: '{}' });

		expect(response.status).toBe(403);
		expect(requestAttempts).toBe(1);
	});
});
