import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import CodeView from './CodeView.svelte';
import Toaster from './Toaster.svelte';
import { toasts } from '$lib/toast.svelte';

describe('CodeView downloads', () => {
	beforeEach(() => {
		toasts.splice(0, toasts.length);
	});

	it('contains a rejected download, shows the existing toast, and leaves retry available', async () => {
		const user = userEvent.setup({ delay: null });
		const onDownloadFile = vi
			.fn<(path: string) => Promise<void>>()
			.mockRejectedValueOnce(new Error('network unavailable'))
			.mockResolvedValueOnce();
		render(Toaster);
		render(CodeView, {
			props: {
				projectId: 'project-a',
				files: [],
				currentFile: 'assets/report.pdf',
				fileContent: '',
				currentFileIsText: false,
				currentFileContentType: 'application/pdf',
				onFileSelect: vi.fn(),
				onEditorChange: vi.fn(),
				onDownloadFile,
				onRefreshFiles: vi.fn(),
				isSaving: false
			}
		});

		const download = screen.getByRole('button', { name: 'Download file' });
		await user.click(download);
		expect(await screen.findByRole('alert')).toHaveTextContent(
			'Failed to download file. Please try again.'
		);

		await user.click(download);
		expect(onDownloadFile).toHaveBeenCalledTimes(2);
		expect(download).toBeEnabled();
	});
});
