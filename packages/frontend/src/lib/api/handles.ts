import { resolvePath } from '$lib/utils/paths';
import { apiFetch } from './errors';
import { csrfFetch } from './csrf';
import { z } from 'zod';

const API_BASE = resolvePath('/api');

export type HandleTransport = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface HandleCheckResult {
	handle: string;
	valid: boolean;
	available: boolean;
	reason?: string;
}

export type ClaimHandleResult =
	| { ok: true; handle: string; alreadyOwned: boolean }
	| { ok: false; message: string };

interface HandleResponse {
	handle?: string;
	alreadyOwned?: boolean;
	message?: string;
	error?: string;
}

const handleResponseSchema = z.object({
	handle: z.string().optional(),
	alreadyOwned: z.boolean().optional(),
	message: z.string().optional(),
	error: z.string().optional()
});

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
export async function claimHandle(
	handle: string,
	request: HandleTransport = csrfFetch
): Promise<ClaimHandleResult> {
	const response = await request(`${API_BASE}/handle`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ handle })
	});

	// Tri-state parse (align with errors.ts's rigor — never fabricate success):
	// a body that isn't JSON is a distinct failure, not an empty object we can
	// read fields off. Track that explicitly instead of coercing to `{}`.
	let data: HandleResponse | null;
	try {
		const parsed = handleResponseSchema.safeParse(JSON.parse(await response.text()));
		data = parsed.success ? parsed.data : null;
	} catch {
		data = null;
	}

	if (response.ok) {
		// A 200 with no usable handle string is a malformed success — the old code
		// returned { ok: true, handle: undefined }, silently claiming success with
		// no handle. Validate the handle is a non-empty string before trusting ok.
		const handle = data?.handle ?? '';
		if (handle) {
			return {
				ok: true,
				handle,
				alreadyOwned: data?.alreadyOwned === true
			};
		}
		return { ok: false, message: "We couldn't save that address." };
	}

	const message = data?.message || data?.error || "We couldn't save that address.";
	return { ok: false, message };
}
