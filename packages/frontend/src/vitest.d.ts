// Augments vitest's `expect` with the jest-dom matchers registered in
// vitest-setup.ts, so `toBeInTheDocument()` et al. type-check under svelte-check.
import 'vitest';
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

declare module 'vitest' {
	interface Assertion<T = any> extends TestingLibraryMatchers<T, void> {}
	interface AsymmetricMatchersContaining extends TestingLibraryMatchers<unknown, void> {}
}
