import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import FileTree from './FileTree.svelte';
import { invalidateCsrfToken } from '$lib/api/csrf';
import { toasts } from '$lib/toast.svelte';

type FetchFunction = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
let fetchMock: Mock<FetchFunction>;

function uploadResponse(path: string, filename: string, size: number): Response {
	return new Response(
		JSON.stringify({
			success: true,
			filename,
			path,
			size,
			message: `Uploaded ${filename}`
		}),
		{ status: 200, headers: { 'Content-Type': 'application/json' } }
	);
}

function open(onRefresh: () => void | Promise<void>) {
	return render(FileTree, {
		props: {
			files: [],
			projectId: 'project-a',
			onSelect: vi.fn(),
			onRefresh
		}
	});
}

describe('FileTree uploads', () => {
	beforeEach(() => {
		invalidateCsrfToken();
		document.cookie = 'cail_csrf_sitestudio=test-csrf-token';
		fetchMock = vi.fn<FetchFunction>();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		toasts.splice(0);
		vi.unstubAllGlobals();
		invalidateCsrfToken();
		document.cookie = 'cail_csrf_sitestudio=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
	});

	it('reports a refresh failure as a partial success after the upload is stored', async () => {
		const user = userEvent.setup({ delay: null });
		const onRefresh = vi.fn().mockRejectedValue(new Error('file list unavailable'));
		fetchMock.mockResolvedValue(uploadResponse('notes.txt', 'notes.txt', 11));
		open(onRefresh);

		const input = document.querySelector('input[type="file"]');
		if (!(input instanceof HTMLInputElement)) throw new Error('expected file input');
		const file = new File(['exact bytes'], 'notes.txt', { type: 'text/plain' });
		await user.upload(input, file);

		await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
		await waitFor(() =>
			expect(toasts).toContainEqual(
				expect.objectContaining({
					kind: 'error',
					message:
						'File uploaded as notes.txt, but the file list could not refresh. Click Refresh files to try again.'
				})
			)
		);
		expect(toasts).not.toContainEqual(expect.objectContaining({ message: expect.stringContaining("Couldn't upload file") }));
	});

	it('ignores a stale upload after switching away and back to the same project', async () => {
		const user = userEvent.setup({ delay: null });
		const onRefresh = vi.fn();
		let resolveUpload!: (response: Response) => void;
		fetchMock.mockReturnValue(
			new Promise<Response>((resolve) => {
				resolveUpload = resolve;
			})
		);
		const view = open(onRefresh);

		const input = document.querySelector('input[type="file"]');
		if (!(input instanceof HTMLInputElement)) throw new Error('expected file input');
		await user.upload(input, new File(['old project'], 'old.txt', { type: 'text/plain' }));
		await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

		await view.rerender({ projectId: 'project-b' });
		await view.rerender({ projectId: 'project-a' });
		resolveUpload(uploadResponse('old.txt', 'old.txt', 11));
		await Promise.resolve();
		await Promise.resolve();

		expect(onRefresh).not.toHaveBeenCalled();
		expect(toasts).toHaveLength(0);
		expect(screen.queryByRole('button', { name: 'Uploading file' })).not.toBeInTheDocument();

		fetchMock.mockResolvedValue(uploadResponse('new.txt', 'new.txt', 10));
		await user.upload(input, new File(['new project'], 'new.txt', { type: 'text/plain' }));
		await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
	});
});
