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

	it('keeps the editor unavailable while the selected file is loading', async () => {
		const user = userEvent.setup({ delay: null });
		const onEditorChange = vi.fn();
		render(CodeView, {
			props: {
				projectId: 'project-a',
				files: [],
				currentFile: 'index.html',
				fileContent: '<h1>stale content</h1>',
				currentFileIsText: true,
				currentFileContentType: 'text/html',
				currentFileLoading: true,
				onFileSelect: vi.fn(),
				onEditorChange,
				onDownloadFile: vi.fn(),
				onRefreshFiles: vi.fn(),
				isSaving: false
			}
		});

		expect(screen.getByRole('status')).toHaveTextContent(
			'Editing is disabled until the saved contents are available.'
		);
		expect(screen.queryByText('stale content')).not.toBeInTheDocument();
		expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
		await user.keyboard('user input');
		expect(onEditorChange).not.toHaveBeenCalled();
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
