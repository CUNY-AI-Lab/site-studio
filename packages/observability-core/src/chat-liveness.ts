/**
 * Inactivity boundary shared by the Site Studio chat server and browser.
 *
 * AIChatAgent's `chatStreamStallTimeoutMs` is the platform watchdog for a
 * model stream. The browser uses the same value as its last-resort boundary
 * when a terminal frame is lost after the stream has started. This is a
 * liveness contract, not a cap on model execution: each protocol frame
 * re-arms the boundary.
 */
export const SITE_STUDIO_CHAT_STREAM_STALL_TIMEOUT_MS = 60_000 as const;
