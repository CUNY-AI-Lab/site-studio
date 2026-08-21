import { describe, expect, it } from 'vitest';
import { canQueueFileSave, type FileOpenStatus } from './file-open-state';

// SS-47 regression pin for the editor's autosave guard. Before this guard
// existed, a failed file load left the editor with the PREVIOUS file's text in
// the buffer, the NEW path selected, and the etag nulled — the next keystroke
// autosaved the old content over the file that failed to load (silent
// cross-file data destruction). The editor page routes its save-snapshot
// decision through canQueueFileSave; these tests pin that seam.
describe('canQueueFileSave (SS-47)', () => {
	it('allows saving only a fully loaded text file', () => {
		expect(canQueueFileSave('loaded', true, 'etag-1')).toBe(true);
	});

	it('blocks saving after a failed load — the buffer does not hold this file', () => {
		expect(canQueueFileSave('failed', true, null)).toBe(false);
	});

	it('blocks saving while the selected file is still loading — the buffer holds the previous file', () => {
		expect(canQueueFileSave('loading', true, null)).toBe(false);
	});

	it('blocks saving when nothing is selected', () => {
		expect(canQueueFileSave('idle', true, null)).toBe(false);
	});

	it('blocks saving a loaded text file without its concurrency token', () => {
		expect(canQueueFileSave('loaded', true, null)).toBe(false);
	});

	it('never allows text-saving a non-text file, in any state', () => {
		const statuses: FileOpenStatus[] = ['idle', 'loading', 'loaded', 'failed'];
		for (const status of statuses) {
			expect(canQueueFileSave(status, false, 'etag-1')).toBe(false);
		}
	});
});
