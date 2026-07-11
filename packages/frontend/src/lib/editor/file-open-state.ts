/**
 * Load-lifecycle state for the file currently open in the code editor.
 *
 * The editor page keeps the buffer (`fileContent`) and the selected path
 * (`currentFile`) in separate reactive variables, and switching files replaces
 * the path BEFORE the new file's content arrives. This status tracks whether
 * the buffer really holds the selected file's loaded content:
 *
 * - 'idle'    — no file selected yet (or selection reset on project switch).
 * - 'loading' — a file is selected but its content is still in flight; the
 *               buffer still holds the PREVIOUS file's text.
 * - 'loaded'  — the buffer holds the selected file's content (text files), or
 *               the selected file is a non-text asset with an empty buffer.
 * - 'failed'  — the selected file's content could NOT be loaded; the buffer
 *               was cleared and must not be presented or saved as this file.
 */
export type FileOpenStatus = 'idle' | 'loading' | 'loaded' | 'failed';

/**
 * SS-47: autosave may queue a write only when the buffer provably holds the
 * CURRENT file's loaded text. While 'loading' the buffer still shows the
 * previous file, and after 'failed' it holds nothing trustworthy — a queued
 * save in either state would write stale (or empty) content over the newly
 * selected file: silent cross-file data destruction. A failed load also nulls
 * the file's etag, so nothing would even catch the overwrite as a conflict.
 */
export function canQueueFileSave(status: FileOpenStatus, isText: boolean): boolean {
	return status === 'loaded' && isText;
}
