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

	const data = await response.json().catch(() => ({}) as Record<string, unknown>);

	if (response.ok) {
		return {
			ok: true,
			handle: (data as { handle: string }).handle,
			alreadyOwned: Boolean((data as { alreadyOwned?: boolean }).alreadyOwned)
		};
	}

	const message =
		(data as { message?: string }).message ||
		(data as { error?: string }).error ||
		'Could not claim that handle.';
	return { ok: false, message };
}
