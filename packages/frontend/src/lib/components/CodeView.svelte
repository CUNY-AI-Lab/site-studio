<script lang="ts">
	import type { ProjectFile } from '$lib/api/projects';
	import FileTree from './FileTree.svelte';
	import Editor from './Editor.svelte';
	import * as Resizable from '$lib/components/ui/resizable';
	import { RefreshCw } from 'lucide-svelte';

	let {
		projectId,
		files = [],
		filesLoadError = null,
		currentFile = '',
		fileContent = '',
		currentFileIsText = true,
		currentFileContentType = '',
		currentFileLoadFailed = false,
		onFileSelect,
		onEditorChange,
		onDownloadFile,
		onRefreshFiles,
		isSaving = false
	}: {
		projectId: string;
		files: ProjectFile[];
		/** SS-48: set when the file list could not be LOADED (not an empty project). */
		filesLoadError?: string | null;
		currentFile: string;
		fileContent: string;
		currentFileIsText: boolean;
		currentFileContentType: string;
		/** SS-47: set when the selected file's content failed to load. */
		currentFileLoadFailed?: boolean;
		onFileSelect: (path: string) => void;
		onEditorChange: (content: string) => void;
		onDownloadFile: (path: string) => void;
		onRefreshFiles: () => void;
		isSaving: boolean;
	} = $props();
</script>

<div class="code-view">
	<Resizable.PaneGroup direction="horizontal">
		<!-- File Tree Panel (resizable) -->
		<Resizable.Pane
			defaultSize={25}
			minSize={15}
			maxSize={50}
			collapsible={true}
		>
			<aside class="file-panel">
				<div class="panel-header">
					<span class="label">FILES</span>
					<button onclick={onRefreshFiles} class="icon-button" title="Refresh files">
						<RefreshCw size={16} />
					</button>
				</div>
				<div class="file-tree-container">
					{#if filesLoadError}
						<!-- SS-48: an unloadable file list is an error, not an empty project. -->
						<div class="files-error" role="alert">
							<p class="files-error-title">Files could not be loaded.</p>
							<p class="files-error-detail">Your files are still there; this is a loading problem, not a deletion.</p>
							<button class="files-error-retry" type="button" onclick={onRefreshFiles}>Retry</button>
						</div>
					{:else}
						<FileTree {files} {projectId} onSelect={onFileSelect} onRefresh={onRefreshFiles} />
					{/if}
				</div>
			</aside>
		</Resizable.Pane>

		<Resizable.Handle withHandle />

		<!-- Editor Panel -->
		<Resizable.Pane defaultSize={75} minSize={40}>
			<div class="editor-panel">
				{#if isSaving && currentFileIsText}
					<div class="save-indicator">Saving...</div>
				{/if}
				{#if currentFile && currentFileLoadFailed}
					<!-- SS-47: the buffer does not hold this file; never present stale or
					     empty content as it, and keep editing (and autosave) disabled. -->
					<div class="binary-view" role="alert">
						<div class="binary-header">
							<span class="binary-filename">{currentFile}</span>
						</div>
						<div class="binary-body">
							<p class="binary-title">This file could not be loaded.</p>
							<p class="binary-description">
								The file itself was not changed. Editing is disabled so stale content cannot be saved over it.
							</p>
							<button class="download-current-file" type="button" onclick={() => onFileSelect(currentFile)}>
								Try again
							</button>
						</div>
					</div>
				{:else if currentFile && !currentFileIsText}
					<div class="binary-view">
						<div class="binary-header">
							<span class="binary-filename">{currentFile}</span>
						</div>
						<div class="binary-body">
							<p class="binary-title">This file is not editable as text.</p>
							<p class="binary-description">
								{currentFileContentType || 'Binary content'} files open as assets or downloads. Use the agent's document tool for PDFs, or download the file directly.
							</p>
							<button class="download-current-file" type="button" onclick={() => onDownloadFile(currentFile)}>
								Download file
							</button>
						</div>
					</div>
				{:else}
					<Editor {currentFile} content={fileContent} onChange={onEditorChange} />
				{/if}
			</div>
		</Resizable.Pane>
	</Resizable.PaneGroup>
</div>

<style>
	.code-view {
		display: flex;
		height: 100%;
		background: var(--color-bg-primary);
	}

	.file-panel {
		height: 100%;
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

	.files-error {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.75rem;
		text-align: left;
	}

	.files-error-title {
		margin: 0;
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.files-error-detail {
		margin: 0;
		font-size: 0.75rem;
		color: var(--color-text-secondary);
		line-height: 1.4;
	}

	.files-error-retry {
		align-self: flex-start;
		padding: 0.375rem 0.75rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-bg-secondary);
		color: var(--color-text-primary);
		font-size: 0.75rem;
		cursor: pointer;
		transition: background 0.15s ease, border-color 0.15s ease;
	}

	.files-error-retry:hover {
		background: var(--color-bg-tertiary);
		border-color: var(--color-border-hover);
	}

	.editor-panel {
		height: 100%;
		position: relative;
		overflow: hidden;
	}

	.binary-view {
		height: 100%;
		display: flex;
		flex-direction: column;
		background: var(--color-bg-primary);
	}

	.binary-header {
		padding: 0.75rem 1rem;
		border-bottom: 1px solid var(--color-border);
		background: var(--color-bg-secondary);
	}

	.binary-filename {
		font-size: 0.875rem;
		font-family: monospace;
		color: var(--color-text-secondary);
	}

	.binary-body {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 2rem;
		text-align: center;
		gap: 0.75rem;
	}

	.binary-title {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.binary-description {
		max-width: 28rem;
		margin: 0;
		color: var(--color-text-secondary);
		line-height: 1.5;
	}

	.download-current-file {
		padding: 0.625rem 0.95rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-bg-secondary);
		color: var(--color-text-primary);
		cursor: pointer;
		transition: background 0.15s ease, border-color 0.15s ease;
	}

	.download-current-file:hover {
		background: var(--color-bg-tertiary);
		border-color: var(--color-border-hover);
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
