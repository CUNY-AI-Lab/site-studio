export const SOCKET_MAX_AGE_MS = 4 * 60 * 1000;

export function shouldRefreshSocket(
	openedAt: number | null,
	now: number,
	maxAgeMs = SOCKET_MAX_AGE_MS
): boolean {
	return openedAt !== null && now - openedAt > maxAgeMs;
}
