import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getCsrfToken, invalidateCsrfToken, csrfFetch } from './csrf';

// resolvePath depends on $app/paths (aliased to a test stub returning base '').
// So /api/csrf resolves to '/api/csrf' here.

const CSRF_COOKIE = 'cail_csrf_sitestudio';

/** Overwrite document.cookie so the client reads exactly this token (or none). */
function setCookieToken(token: string | null): void {
	// jsdom's document.cookie is a real accessor; clearing it needs an expiry.
	if (token === null) {
		document.cookie = `${CSRF_COOKIE}=; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
		return;
	}
	document.cookie = `${CSRF_COOKIE}=${token}`;
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
		// Reset module cache and the cookie between tests so caching/cookie
		// assertions are isolated.
		invalidateCsrfToken();
		setCookieToken(null);
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		invalidateCsrfToken();
		setCookieToken(null);
	});

	it('reads the token from the cookie without any network request when present', async () => {
		setCookieToken('tok-cookie');

		const token = await getCsrfToken();

		expect(token).toBe('tok-cookie');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('caches the token: two getCsrfToken calls make at most one network request', async () => {
		// Cookie absent → the client hits /api/csrf, which sets the cookie.
		fetchMock.mockImplementation(async () => {
			setCookieToken('tok-1');
			return new Response(null, { status: 204 });
		});

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

		// The server delivers the token via Set-Cookie; simulate by setting it
		// before the fetch resolves.
		setCookieToken('tok-concurrent');
		resolveFetch(new Response(null, { status: 204 }));
		const [a, b] = await Promise.all([p1, p2]);

		expect(a).toBe('tok-concurrent');
		expect(b).toBe('tok-concurrent');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('csrfFetch sets the X-CSRF-Token header on a POST', async () => {
		setCookieToken('tok-post');
		fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

		await csrfFetch('/api/projects', { method: 'POST', body: '{}' });

		const requestCall = fetchMock.mock.calls.find((c) => !isTokenFetch(c));
		expect(requestCall).toBeDefined();
		const init = requestCall![1] as RequestInit;
		const headers = new Headers(init.headers);
		expect(headers.get('X-CSRF-Token')).toBe('tok-post');
		expect(init.credentials).toBe('include');
	});

	it('csrfFetch does NOT set the header on a GET and passes through', async () => {
		setCookieToken('tok-get');
		fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

		await csrfFetch('/api/projects', { method: 'GET' });

		// GET must not trigger a token fetch, and must not carry the CSRF header.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [, init] = fetchMock.mock.calls[0];
		const headers = new Headers((init as RequestInit).headers);
		expect(headers.has('X-CSRF-Token')).toBe(false);
		expect((init as RequestInit).credentials).toBe('include');
	});

	it('csrfFetch treats a method-less request as GET (no header)', async () => {
		setCookieToken('tok-x');
		fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

		await csrfFetch('/api/projects');

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [, init] = fetchMock.mock.calls[0];
		const headers = new Headers((init as RequestInit | undefined)?.headers);
		expect(headers.has('X-CSRF-Token')).toBe(false);
	});

	it('on csrf_verification_failed 403: re-fetches /api/csrf, re-reads the cookie, retries once', async () => {
		// Seed a stale token so the first attempt uses it.
		setCookieToken('tok-stale');

		let tokenFetches = 0;
		let requestAttempts = 0;
		fetchMock.mockImplementation(async (input: unknown) => {
			if (typeof input === 'string' && input.endsWith('/api/csrf')) {
				tokenFetches += 1;
				// The refresh Set-Cookie delivers a fresh token.
				setCookieToken('tok-fresh');
				return new Response(null, { status: 204 });
			}
			requestAttempts += 1;
			// First attempt gets a CSRF rejection; the retry succeeds.
			return requestAttempts === 1 ? csrfFailure() : new Response('{}', { status: 200 });
		});

		const response = await csrfFetch('/api/projects', { method: 'POST', body: '{}' });

		expect(response.status).toBe(200);
		// One refresh fetch and two request attempts (original + one retry).
		expect(tokenFetches).toBe(1);
		expect(requestAttempts).toBe(2);

		// The retry used the fresh token read from the refreshed cookie.
		const requestCalls = fetchMock.mock.calls.filter((c) => !isTokenFetch(c));
		expect(requestCalls).toHaveLength(2);
		const firstHeaders = new Headers((requestCalls[0][1] as RequestInit).headers);
		expect(firstHeaders.get('X-CSRF-Token')).toBe('tok-stale');
		const retryHeaders = new Headers((requestCalls[1][1] as RequestInit).headers);
		expect(retryHeaders.get('X-CSRF-Token')).toBe('tok-fresh');
	});

	it('does not retry on a non-CSRF 403', async () => {
		setCookieToken('tok-x');
		let requestAttempts = 0;
		fetchMock.mockImplementation(async (input: unknown) => {
			if (typeof input === 'string' && input.endsWith('/api/csrf')) {
				return new Response(null, { status: 204 });
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
