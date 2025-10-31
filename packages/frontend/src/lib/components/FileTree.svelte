<script lang="ts">
	import { Folder, File, Download, Upload } from 'lucide-svelte';

	interface FileNode {
		name: string;
		path: string;
		type: 'file' | 'directory';
		children?: FileNode[];
	}

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

			const response = await fetch(`/api/projects/${projectId}/upload`, {
				method: 'POST',
				body: formData
			});

			if (!response.ok) throw new Error('Upload failed');

			// Refresh file list
			onRefresh();

			// Clear input
			input.value = '';
		} catch (error) {
			console.error('Error uploading file:', error);
			alert('Failed to upload file');
		} finally {
			isUploading = false;
		}
	}

	async function handleDownload(filePath: string) {
		try {
			const response = await fetch(`/api/projects/${projectId}/download?path=${encodeURIComponent(filePath)}`);

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
			alert('Failed to download file');
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
		>
			<Upload size={14} />
			<span>{isUploading ? 'Uploading...' : 'Upload'}</span>
		</button>
	</div>

	{#if files.length === 0}
		<p class="empty-state">No files yet. Ask the agent to create some!</p>
	{:else}
		{#each files as file}
			{@render FileTreeNode({ file, onSelect, onDownload: handleDownload })}
		{/each}
	{/if}
</div>

<!-- Recursive tree node component -->
{#snippet FileTreeNode({ file, onSelect, onDownload }: { file: FileNode, onSelect: (path: string) => void, onDownload: (path: string) => void })}
	<div class="tree-node">
		{#if file.type === 'directory'}
			<details open>
				<summary>
					<Folder size={16} class="icon" />
					<span>{file.name}</span>
				</summary>
				<div class="tree-children">
					{#each file.children || [] as child}
						{@render FileTreeNode({ file: child, onSelect, onDownload })}
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
				<button
					class="download-button"
					onclick={(e) => {
						e.stopPropagation();
						onDownload(file.path);
					}}
					type="button"
					title="Download file"
				>
					<Download size={14} />
				</button>
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

	.download-button {
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
		opacity: 0;
	}

	.file-row:hover .download-button {
		opacity: 1;
	}

	.download-button:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-accent);
	}

	:global(.file-tree .icon) {
		flex-shrink: 0;
		color: var(--color-text-secondary);
	}
</style>
