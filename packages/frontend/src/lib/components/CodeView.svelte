<script lang="ts">
	import FileTree from './FileTree.svelte';
	import Editor from './Editor.svelte';
	import { RefreshCw } from 'lucide-svelte';

	let {
		projectId,
		files = [],
		currentFile = '',
		fileContent = '',
		onFileSelect,
		onEditorChange,
		onRefreshFiles,
		isSaving = false
	}: {
		projectId: string;
		files: any[];
		currentFile: string;
		fileContent: string;
		onFileSelect: (path: string) => void;
		onEditorChange: (content: string) => void;
		onRefreshFiles: () => void;
		isSaving: boolean;
	} = $props();
</script>

<div class="code-view">
	<aside class="file-panel">
		<div class="panel-header">
			<span class="label">FILES</span>
			<button onclick={onRefreshFiles} class="icon-button" title="Refresh files">
				<RefreshCw size={16} />
			</button>
		</div>
		<div class="file-tree-container">
			<FileTree {files} {projectId} onSelect={onFileSelect} onRefresh={onRefreshFiles} />
		</div>
	</aside>

	<div class="editor-panel">
		{#if isSaving}
			<div class="save-indicator">Saving...</div>
		{/if}
		<Editor {currentFile} content={fileContent} onChange={onEditorChange} />
	</div>
</div>

<style>
	.code-view {
		display: flex;
		height: 100%;
		background: var(--color-bg-primary);
	}

	.file-panel {
		width: 250px;
		border-right: 1px solid var(--color-border);
		display: flex;
		flex-direction: column;
		background: var(--color-bg-secondary);
	}

	.panel-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.75rem 1rem;
		border-bottom: 1px solid var(--color-border);
	}

	.label {
		font-size: 0.75rem;
		font-weight: 600;
		letter-spacing: 0.05em;
		color: var(--color-text-secondary);
	}

	.icon-button {
		background: none;
		border: none;
		font-size: 0.875rem;
		padding: 0.25rem;
		cursor: pointer;
		border-radius: 4px;
		transition: background 0.15s;
	}

	.icon-button:hover {
		background: var(--color-bg-tertiary);
	}

	.file-tree-container {
		flex: 1;
		overflow-y: auto;
		padding: 0.5rem;
	}

	.editor-panel {
		flex: 1;
		position: relative;
		overflow: hidden;
	}

	.save-indicator {
		position: absolute;
		top: 0.5rem;
		right: 0.5rem;
		background: var(--color-accent);
		color: white;
		padding: 0.25rem 0.75rem;
		border-radius: 4px;
		font-size: 0.75rem;
		z-index: 10;
		pointer-events: none;
	}
</style>
