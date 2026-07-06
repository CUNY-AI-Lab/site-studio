import { resolvePath } from '$lib/utils/paths';
import { apiFetch } from './errors';
import { csrfFetch } from './csrf';

const API_BASE = resolvePath('/api');

export interface HandleCheckResult {
	handle: string;
	valid: boolean;
	available: boolean;
	reason?: string;
}

export type ClaimHandleResult =
	| { ok: true; handle: string; alreadyOwned: boolean }
	| { ok: false; message: string };

/** The current user's handle, or null if they have not claimed one. */
export async function getHandle(): Promise<string | null> {
	const data = await apiFetch<{ handle: string | null }>(`${API_BASE}/handle`);
	return data.handle;
}

/** Validate + availability check for a candidate handle. */
export async function checkHandle(handle: string): Promise<HandleCheckResult> {
	return apiFetch<HandleCheckResult>(
		`${API_BASE}/handle/check?handle=${encodeURIComponent(handle)}`
	);
}

/**
 * Claim a handle for the current user. Returns a typed result rather than
 * throwing on the expected 400/409 (taken / already-have-one / invalid) so the
 * dialog can show inline feedback.
 */
export async function claimHandle(handle: string): Promise<ClaimHandleResult> {
	const response = await csrfFetch(`${API_BASE}/handle`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ handle })
	});

	// Tri-state parse (align with errors.ts's rigor — never fabricate success):
	// a body that isn't JSON is a distinct failure, not an empty object we can
	// read fields off. Track that explicitly instead of coercing to `{}`.
	let data: Record<string, unknown> | null;
	try {
		data = (await response.json()) as Record<string, unknown>;
	} catch {
		data = null;
	}

	if (response.ok) {
		// A 200 with no usable handle string is a malformed success — the old code
		// returned { ok: true, handle: undefined }, silently claiming success with
		// no handle. Validate the handle is a non-empty string before trusting ok.
		const handle = data && typeof data.handle === 'string' ? data.handle : '';
		if (handle) {
			return {
				ok: true,
				handle,
				alreadyOwned: Boolean((data as { alreadyOwned?: boolean }).alreadyOwned)
			};
		}
		return { ok: false, message: 'Could not claim that handle.' };
	}

	const message =
		(data && typeof data.message === 'string' && data.message) ||
		(data && typeof data.error === 'string' && data.error) ||
		'Could not claim that handle.';
	return { ok: false, message };
}
