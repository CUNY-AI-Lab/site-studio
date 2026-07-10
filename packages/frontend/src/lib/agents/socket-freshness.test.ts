import { describe, expect, it } from 'vitest';
import { SOCKET_MAX_AGE_MS, shouldRefreshSocket } from './socket-freshness';

describe('shouldRefreshSocket', () => {
	const now = 1_000_000;

	it('does not refresh when no socket-open time is known', () => {
		expect(shouldRefreshSocket(null, now)).toBe(false);
	});

	it('does not refresh a socket within the maximum age', () => {
		expect(shouldRefreshSocket(now - SOCKET_MAX_AGE_MS + 1, now)).toBe(false);
	});

	it('refreshes a socket older than the maximum age', () => {
		expect(shouldRefreshSocket(now - SOCKET_MAX_AGE_MS - 1, now)).toBe(true);
	});

	it('does not refresh at the exclusive boundary', () => {
		expect(shouldRefreshSocket(now - SOCKET_MAX_AGE_MS, now)).toBe(false);
	});
});
