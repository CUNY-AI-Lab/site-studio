import { expect, afterEach, vi } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';
import { cleanup } from '@testing-library/svelte';

// Register jest-dom matchers (toBeInTheDocument, toBeDisabled, etc.) against
// vitest's expect explicitly. Importing the /vitest entry does not reliably
// extend expect under our ESM + globals config, so we extend manually.
expect.extend(matchers);

// After every test: unmount rendered components for a clean DOM, and restore
// real timers. The timer reset is a safety net — a test that installs fake
// timers (e.g. Toaster's auto-dismiss tests) and fails an assertion before its
// own useRealTimers would otherwise LEAK fake timers into the next file, where
// userEvent's internal delays stall and unrelated tests flake intermittently.
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});
