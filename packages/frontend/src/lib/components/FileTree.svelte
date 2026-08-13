<script lang="ts" module>
	export interface FileNode {
		name: string;
		path: string;
		type: 'file' | 'directory';
		contentType?: string;
		isText?: boolean;
		children?: FileNode[];
	}
</script>

<script lang="ts">
	import { Folder, File, Download, Upload, Trash2, Edit3 } from 'lucide-svelte';
	import { resolvePath } from '$lib/utils/paths';
	import { csrfFetch } from '$lib/api/csrf';
	import { apiResponseFetch, getErrorMessage, handleApiError } from '$lib/api/errors';
	import { toast } from '$lib/toast.svelte';

	let {
		files = [],
		projectId,
		onSelect,
		onRefresh
	}: {
		files: FileNode[],
		projectId: string,
		onSelect: (path: string) => void,
		onRefresh: () => void
	} = $props();

	let fileInput: HTMLInputElement;
	let isUploading = $state(false);

	async function handleUpload(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];

		if (!file) return;

		try {
			isUploading = true;
			const formData = new FormData();
			formData.append('file', file);

			const response = await csrfFetch(resolvePath(`/api/projects/${projectId}/upload`), {
				method: 'POST',
				body: formData
			});

			if (!response.ok) await handleApiError(response);

			// Refresh file list
			onRefresh();

			// Clear input
			input.value = '';
		} catch (error) {
			console.error('Error uploading file:', error);
			toast.error(`Couldn't upload file. ${getErrorMessage(error)}`);
		} finally {
			isUploading = false;
		}
	}

	async function handleDownload(filePath: string) {
		try {
			const response = await apiResponseFetch(resolvePath(`/api/projects/${projectId}/download?path=${encodeURIComponent(filePath)}`), {
				credentials: 'include'
			});

			if (!response.ok) throw new Error('Download failed');

			const blob = await response.blob();
			const url = window.URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = filePath.split('/').pop() || 'download';
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			window.URL.revokeObjectURL(url);
		} catch (error) {
			console.error('Error downloading file:', error);
			toast.error("We couldn't download that file. Try again in a moment.");
		}
	}

	async function handleDelete(filePath: string) {
		const filename = filePath.split('/').pop();
		if (!confirm(`Are you sure you want to delete "${filename}"?`)) return;

		try {
			const response = await csrfFetch(resolvePath(`/api/projects/${projectId}/files?path=${encodeURIComponent(filePath)}`), {
				method: 'DELETE'
			});

			if (!response.ok) {
				await handleApiError(response);
			}

			// Refresh file list
			onRefresh();
		} catch (error: any) {
			console.error('Error deleting file:', error);
			toast.error(`Couldn't delete that file. ${getErrorMessage(error)}`);
		}
	}

	async function handleRename(filePath: string) {
		const filename = filePath.split('/').pop() || '';
		const newName = prompt('Enter new filename:', filename);

		if (!newName || newName === filename) return;

		try {
			// Reconstruct the path with the new filename
			const pathParts = filePath.split('/');
			pathParts[pathParts.length - 1] = newName;
			const newPath = pathParts.join('/');

			const response = await csrfFetch(resolvePath(`/api/projects/${projectId}/files/rename`), {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ oldPath: filePath, newPath })
			});

			if (!response.ok) {
				await handleApiError(response);
			}

			// Refresh file list
			onRefresh();
		} catch (error: any) {
			console.error('Error renaming file:', error);
			toast.error(`Couldn't rename that file. ${getErrorMessage(error)}`);
		}
	}
</script>

<div class="file-tree">
	<div class="tree-header">
		<input
			type="file"
			bind:this={fileInput}
			onchange={handleUpload}
			style="display: none;"
		/>
		<button
			onclick={() => fileInput.click()}
			disabled={isUploading}
			class="upload-button"
			title="Upload file"
			aria-label={isUploading ? 'Uploading file' : 'Upload file'}
		>
			<Upload size={14} />
			<span>{isUploading ? 'Uploading...' : 'Upload'}</span>
		</button>
	</div>

	{#if files.length === 0}
		<p class="empty-state">No files yet. Describe what you want in chat and the assistant will create them.</p>
	{:else}
		{#each files as file}
			{@render FileTreeNode({ file, onSelect, onDownload: handleDownload, onRename: handleRename, onDelete: handleDelete })}
		{/each}
	{/if}
</div>

<!-- Recursive tree node component -->
{#snippet FileTreeNode({ file, onSelect, onDownload, onRename, onDelete }: { file: FileNode, onSelect: (path: string) => void, onDownload: (path: string) => void, onRename: (path: string) => void, onDelete: (path: string) => void })}
	<div class="tree-node">
		{#if file.type === 'directory'}
			<details open>
				<summary>
					<Folder size={16} class="icon" />
					<span>{file.name}</span>
				</summary>
				<div class="tree-children">
					{#each file.children || [] as child}
						{@render FileTreeNode({ file: child, onSelect, onDownload, onRename, onDelete })}
					{/each}
				</div>
			</details>
		{:else}
			<div class="file-row">
				<button
					class="file-item"
					onclick={() => onSelect(file.path)}
					type="button"
				>
					<File size={16} class="icon" />
					<span class="file-name">{file.name}</span>
				</button>
				<div class="file-actions">
					<button
						class="action-button"
						onclick={(e) => {
							e.stopPropagation();
							onRename(file.path);
						}}
						type="button"
						title="Rename file"
						aria-label={`Rename ${file.name}`}
					>
						<Edit3 size={14} />
					</button>
					<button
						class="action-button"
						onclick={(e) => {
							e.stopPropagation();
							onDownload(file.path);
						}}
						type="button"
						title="Download file"
						aria-label={`Download ${file.name}`}
					>
						<Download size={14} />
					</button>
					<button
						class="action-button delete-button"
						onclick={(e) => {
							e.stopPropagation();
							onDelete(file.path);
						}}
						type="button"
						title="Delete file"
						aria-label={`Delete ${file.name}`}
					>
						<Trash2 size={14} />
					</button>
				</div>
			</div>
		{/if}
	</div>
{/snippet}

<style>
	.file-tree {
		font-size: 0.875rem;
	}

	.tree-header {
		padding: 0.5rem;
		border-bottom: 1px solid var(--color-border);
		margin-bottom: 0.5rem;
	}

	.upload-button {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.4rem 0.75rem;
		background: var(--color-accent);
		color: white;
		border: none;
		border-radius: 4px;
		font-size: 0.8rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.15s;
	}

	.upload-button:hover:not(:disabled) {
		background: var(--color-accent-hover);
	}

	.upload-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.empty-state {
		color: var(--color-text-secondary);
		font-size: 0.875rem;
		font-style: italic;
		padding: 0 0.5rem;
	}

	.tree-node {
		margin-bottom: 0.25rem;
	}

	details summary {
		cursor: pointer;
		user-select: none;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.25rem 0.5rem;
		border-radius: 4px;
		transition: background 0.15s;
	}

	details summary:hover {
		background: var(--color-bg-tertiary);
	}

	details summary::marker {
		font-size: 0.75rem;
	}

	.tree-children {
		padding-left: 1rem;
		border-left: 1px solid var(--color-border);
		margin-left: 0.5rem;
	}

	.file-row {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}

	.file-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: 1;
		padding: 0.25rem 0.5rem;
		background: none;
		border: none;
		color: var(--color-text-primary);
		text-align: left;
		border-radius: 4px;
		transition: background 0.15s;
		cursor: pointer;
	}

	.file-item:hover {
		background: var(--color-bg-tertiary);
	}

	.file-name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.file-actions {
		display: flex;
		align-items: center;
		gap: 0.125rem;
		opacity: 0;
		transition: opacity 0.15s;
	}

	.file-row:hover .file-actions {
		opacity: 1;
	}

	.file-row:focus-within .file-actions {
		opacity: 1;
	}

	.action-button {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0.25rem;
		background: none;
		border: none;
		color: var(--color-text-secondary);
		border-radius: 4px;
		cursor: pointer;
		transition: all 0.15s;
	}

	.action-button:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-accent);
	}

	.action-button:focus-visible {
		outline: 2px solid var(--color-primary, var(--color-accent));
		outline-offset: 2px;
	}

	.action-button.delete-button:hover {
		color: #ef4444;
	}

	:global(.file-tree .icon) {
		flex-shrink: 0;
		color: var(--color-text-secondary);
	}
</style>
