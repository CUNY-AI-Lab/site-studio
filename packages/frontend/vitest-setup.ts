import { expect, afterEach, vi } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';
import { cleanup } from '@testing-library/svelte';

const OVERLAY_BODY_CLEANUP_MS = 25;

// Register jest-dom matchers (toBeInTheDocument, toBeDisabled, etc.) against
// vitest's expect explicitly. Importing the /vitest entry does not reliably
// extend expect under our ESM + globals config, so we extend manually.
expect.extend(matchers);

// After every test: unmount rendered components for a clean DOM, and restore
// real timers. The timer reset is a safety net — a test that installs fake
// timers (e.g. Toaster's auto-dismiss tests) and fails an assertion before its
// own useRealTimers would otherwise LEAK fake timers into the next file, where
// userEvent's internal delays stall and unrelated tests flake intermittently.
afterEach(async () => {
	const fakeTimers = vi.isFakeTimers();
	cleanup();

	// bits-ui deliberately restores its shared body scroll lock on a 24 ms
	// timer so a same-tick replacement overlay can acquire the lock first.
	// jsdom must stay alive until that teardown callback has run; otherwise the
	// callback can touch document.body after Vitest has destroyed the environment.
	const overlayCleanupPending =
		typeof document !== 'undefined' &&
		(document.body.style.overflow === 'hidden' ||
			document.body.style.pointerEvents === 'none' ||
			document.body.style.getPropertyValue('--scrollbar-width') !== '');
	if (overlayCleanupPending) {
		if (fakeTimers) {
			await vi.advanceTimersByTimeAsync(OVERLAY_BODY_CLEANUP_MS);
		} else {
			await new Promise((resolve) => window.setTimeout(resolve, OVERLAY_BODY_CLEANUP_MS));
		}
	}
	vi.useRealTimers();
});
