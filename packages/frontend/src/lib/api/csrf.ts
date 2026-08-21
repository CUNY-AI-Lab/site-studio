import { resolvePath } from '$lib/utils/paths';
import { browserWindow } from '$lib/contracts';
import { z } from 'zod';
import { handleApiErrorResponse } from './error-handler';

/**
 * Anti-CSRF token client (CAIL INTEGRATION.md §3¾).
 *
 * Every state-changing request to /api/* must carry an `X-CSRF-Token` header, and
 * agent WebSocket connects must append `?csrf=<token>`. The token is DELIVERED by
 * the server as the `cail_csrf_sitestudio` cookie (rule 3 "Delivery") rather than
 * in a response body — a body token would be readable by any same-origin sibling
 * or published-site script. We read the token out of `document.cookie`; if it is absent
 * we hit `GET /api/csrf` (session-cookie authenticated) once to trigger the
 * Set-Cookie, then re-read. The token is cached in module state so we make at
 * most one network round-trip per session. If the session rotates the server
 * rejects a stale token with 403 `{ error: "csrf_verification_failed" }`;
 * `csrfFetch` transparently refetches (re-triggering the Set-Cookie) once and
 * retries the request one time.
 *
 * Path coupling: the server scopes the cookie to CSRF_COOKIE_PATH. When that is a
 * prefix (shared-host launch), `document.cookie` only exposes it to pages under
 * that prefix — which is exactly where this SPA is served, so reads still work;
 * siblings and published-site JS under other prefixes never see it.
 */

const CSRF_HEADER = 'X-CSRF-Token';
const CSRF_ERROR_CODE = 'csrf_verification_failed';
/** Name of the delivery cookie the server sets (server: lib/constants.ts). */
const CSRF_COOKIE_NAME = 'cail_csrf_sitestudio';
const csrfErrorEnvelopeSchema = z.object({ error: z.string().optional() });

/** Methods that mutate server state and therefore require the CSRF header. */
const SAFE_METHODS = new Set(['GET', 'HEAD']);

let cachedToken: string | null = null;
/** Single in-flight resolve so concurrent callers share one network round-trip. */
let inFlight: Promise<string> | null = null;

/**
 * Read a cookie value out of `document.cookie` by name, or null when absent.
 * Guards against a missing `document` (non-browser contexts).
 */
function readCookie(name: string): string | null {
	const document = browserWindow()?.document;
	if (!document?.cookie) {
		return null;
	}
	const prefix = `${name}=`;
	for (const part of document.cookie.split(';')) {
		const trimmed = part.trim();
		if (trimmed.startsWith(prefix)) {
			const value = trimmed.slice(prefix.length);
			return value.length > 0 ? decodeURIComponent(value) : null;
		}
	}
	return null;
}

/** Read the current delivery token synchronously for unload-safe requests. */
export function getCsrfTokenFromCookie(): string | null {
	return readCookie(CSRF_COOKIE_NAME);
}

/**
 * Resolve the current CSRF token from the delivery cookie, triggering the
 * server Set-Cookie once if the cookie is absent. Concurrent calls before the
 * first fetch resolves share the same promise.
 */
export async function getCsrfToken(): Promise<string> {
	if (cachedToken) {
		return cachedToken;
	}

	// The cookie may already be present (server set it on a prior request).
	const existing = getCsrfTokenFromCookie();
	if (existing) {
		cachedToken = existing;
		return existing;
	}

	if (inFlight) {
		return inFlight;
	}

	inFlight = (async () => {
		try {
			const response = await fetch(resolvePath('/api/csrf'), {
				credentials: 'include'
			});

			if (!response.ok) {
				await handleApiErrorResponse(response);
			}

			// The token is delivered as a Set-Cookie, not a body — re-read it.
			const token = getCsrfTokenFromCookie();
			if (!token) {
				throw new Error('CSRF cookie missing after /api/csrf');
			}

			cachedToken = token;
			return token;
		} finally {
			inFlight = null;
		}
	})();

	return inFlight;
}

/** Clear the cached token so the next request re-reads (and may refetch) it. */
export function invalidateCsrfToken(): void {
	cachedToken = null;
	inFlight = null;
}

/**
 * Force a server round-trip to refresh the delivery cookie, then re-read it.
 * Used on a stale-token 403: the cookie still holds the rejected token, so
 * merely re-reading it would loop — we must hit /api/csrf to receive a fresh
 * Set-Cookie that overwrites it.
 */
export async function refreshCsrfToken(): Promise<string> {
	invalidateCsrfToken();
	const response = await fetch(resolvePath('/api/csrf'), { credentials: 'include' });
	if (!response.ok) {
		await handleApiErrorResponse(response);
	}
	const token = getCsrfTokenFromCookie();
	if (!token) {
		throw new Error('CSRF cookie missing after /api/csrf refresh');
	}
	cachedToken = token;
	return token;
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
	const raw =
		init?.method ??
		(input instanceof Request ? input.method : undefined) ??
		'GET';
	return raw.toUpperCase();
}

function withCsrfHeader(init: RequestInit | undefined, token: string): RequestInit {
	const headers = new Headers(init?.headers);
	headers.set(CSRF_HEADER, token);
	return {
		...init,
		credentials: 'include',
		headers
	};
}

/**
 * Did this 403 come from CSRF verification (a stale token after session
 * rotation) rather than an ordinary authorization failure? Reads the cloned
 * body so the caller can still consume the original response.
 */
async function isCsrfFailure(response: Response): Promise<boolean> {
	if (response.status !== 403) {
		return false;
	}
	try {
		const parsed = csrfErrorEnvelopeSchema.safeParse(JSON.parse(await response.clone().text()));
		return parsed.success && parsed.data.error === CSRF_ERROR_CODE;
	} catch {
		return false;
	}
}

/**
 * `fetch` wrapper that attaches the CSRF token to state-changing requests and
 * always sends credentials. GET/HEAD pass through unchanged (no header). On a
 * `csrf_verification_failed` 403 it re-fetches /api/csrf to refresh the delivery
 * cookie, re-reads the token, and retries the request exactly once before
 * surfacing the response.
 */
export async function csrfFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const method = methodOf(input, init);

	if (SAFE_METHODS.has(method)) {
		return fetch(input, { credentials: 'include', ...init });
	}

	const token = await getCsrfToken();
	const response = await fetch(input, withCsrfHeader(init, token));

	if (await isCsrfFailure(response)) {
		const freshToken = await refreshCsrfToken();
		return fetch(input, withCsrfHeader(init, freshToken));
	}

	return response;
}
