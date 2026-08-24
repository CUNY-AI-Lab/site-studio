import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { JsonValue } from '$lib/contracts';
import type { HandleTransport } from './handles';

import { claimHandle } from './handles';

const csrfFetch: Mock<HandleTransport> = vi.fn<HandleTransport>();

function jsonResponse(body: JsonValue, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

function htmlResponse(status = 200): Response {
	return new Response('<!doctype html><title>oops</title>', {
		status,
		headers: { 'Content-Type': 'text/html' }
	});
}

describe('claimHandle response parsing (tri-state)', () => {
	beforeEach(() => {
		csrfFetch.mockReset();
	});

	it('returns ok with the handle on a well-formed 200', async () => {
		csrfFetch.mockResolvedValue(jsonResponse({ handle: 'jane', alreadyOwned: false }));
		const result = await claimHandle('jane', csrfFetch);
		expect(result).toEqual({ ok: true, handle: 'jane', alreadyOwned: false });
	});

	it('carries alreadyOwned through', async () => {
		csrfFetch.mockResolvedValue(jsonResponse({ handle: 'jane', alreadyOwned: true }));
		const result = await claimHandle('jane', csrfFetch);
		expect(result).toEqual({ ok: true, handle: 'jane', alreadyOwned: true });
	});

	it('does NOT fabricate ok:true on a 200 with no handle (tri-state)', async () => {
		// The old code returned { ok: true, handle: undefined } here.
		csrfFetch.mockResolvedValue(jsonResponse({ alreadyOwned: true }));
		const result = await claimHandle('jane', csrfFetch);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toBe("We couldn't save that address.");
		}
	});

	it('does NOT fabricate ok:true on a non-JSON 200 (tri-state)', async () => {
		// The old code coerced the unparseable body to {} and returned
		// { ok: true, handle: undefined }.
		csrfFetch.mockResolvedValue(htmlResponse(200));
		const result = await claimHandle('jane', csrfFetch);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toBe("We couldn't save that address.");
		}
	});

	it('surfaces the server message on a 409', async () => {
		csrfFetch.mockResolvedValue(jsonResponse({ message: 'That address is taken.' }, 409));
		const result = await claimHandle('jane', csrfFetch);
		expect(result).toEqual({ ok: false, message: 'That address is taken.' });
	});

	it('falls back to the error field then a default on failures', async () => {
		csrfFetch.mockResolvedValue(jsonResponse({ error: 'nope' }, 400));
		expect(await claimHandle('jane', csrfFetch)).toEqual({ ok: false, message: 'nope' });

		csrfFetch.mockResolvedValue(htmlResponse(500));
		expect(await claimHandle('jane', csrfFetch)).toEqual({
			ok: false,
			message: "We couldn't save that address."
		});
	});
});
