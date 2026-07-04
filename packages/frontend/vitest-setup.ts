import { expect, afterEach } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';
import { cleanup } from '@testing-library/svelte';

// Register jest-dom matchers (toBeInTheDocument, toBeDisabled, etc.) against
// vitest's expect explicitly. Importing the /vitest entry does not reliably
// extend expect under our ESM + globals config, so we extend manually.
expect.extend(matchers);

// Unmount any components rendered in a test so each test starts from a clean DOM.
afterEach(() => {
	cleanup();
});
