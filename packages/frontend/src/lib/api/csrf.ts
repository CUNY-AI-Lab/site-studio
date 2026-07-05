import { resolvePath } from '$lib/utils/paths';

/**
 * Anti-CSRF token client (CAIL INTEGRATION.md §3¾).
 *
 * Every state-changing request to /api/* must carry an `X-CAIL-CSRF` header, and
 * agent WebSocket connects must append `?csrf=<token>`. The token is fetched from
 * `GET /api/csrf` (session-cookie authenticated) and cached in module state so we
 * make at most one network round-trip per session. If the session rotates the
 * server rejects a stale token with 403 `{ error: "csrf_verification_failed" }`;
 * `csrfFetch` transparently refetches once and retries the request one time.
 */

const CSRF_HEADER = 'X-CAIL-CSRF';
const CSRF_ERROR_CODE = 'csrf_verification_failed';

/** Methods that mutate server state and therefore require the CSRF header. */
const SAFE_METHODS = new Set(['GET', 'HEAD']);

let cachedToken: string | null = null;
/** Single in-flight fetch so concurrent callers share one network request. */
let inFlight: Promise<string> | null = null;

/**
 * Resolve the current CSRF token, fetching (and caching) it if necessary.
 * Concurrent calls before the first fetch resolves share the same promise.
 */
export async function getCsrfToken(): Promise<string> {
	if (cachedToken) {
		return cachedToken;
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
				throw new Error(`Failed to fetch CSRF token (status ${response.status})`);
			}

			const data = (await response.json()) as { token?: unknown };
			if (typeof data.token !== 'string' || data.token.length === 0) {
				throw new Error('CSRF token response missing token');
			}

			cachedToken = data.token;
			return cachedToken;
		} finally {
			inFlight = null;
		}
	})();

	return inFlight;
}

/** Clear the cached token so the next request refetches it. */
export function invalidateCsrfToken(): void {
	cachedToken = null;
	inFlight = null;
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
	const raw =
		init?.method ??
		(typeof input === 'object' && input !== null && 'method' in input
			? (input as Request).method
			: undefined) ??
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
		const data = (await response.clone().json()) as { error?: unknown };
		return data.error === CSRF_ERROR_CODE;
	} catch {
		return false;
	}
}

/**
 * `fetch` wrapper that attaches the CSRF token to state-changing requests and
 * always sends credentials. GET/HEAD pass through unchanged (no header). On a
 * `csrf_verification_failed` 403 it invalidates the cache, refetches the token,
 * and retries the request exactly once before surfacing the response.
 */
export async function csrfFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const method = methodOf(input, init);

	if (SAFE_METHODS.has(method)) {
		return fetch(input, { credentials: 'include', ...init });
	}

	const token = await getCsrfToken();
	const response = await fetch(input, withCsrfHeader(init, token));

	if (await isCsrfFailure(response)) {
		invalidateCsrfToken();
		const freshToken = await getCsrfToken();
		return fetch(input, withCsrfHeader(init, freshToken));
	}

	return response;
}
