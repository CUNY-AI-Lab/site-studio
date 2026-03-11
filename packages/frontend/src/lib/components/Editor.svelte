<script lang="ts">
	import { createEditorInstance } from './editor-instance';

	let { currentFile = '', content = '', onChange }: {
		currentFile: string;
		content: string;
		onChange: (content: string) => void;
	} = $props();

	let editorElement = $state<HTMLDivElement | null>(null);
	let editorView: ReturnType<typeof createEditorInstance> | null = null;
	let mountedFile = '';

	$effect(() => {
		if (!currentFile || !editorElement) {
			if (editorView) {
				editorView.destroy();
				editorView = null;
				mountedFile = '';
			}
			return;
		}

		if (!editorView || mountedFile !== currentFile) {
			editorView?.destroy();
			editorView = createEditorInstance(editorElement, currentFile, content, onChange);
			mountedFile = currentFile;
			return;
		}

		if (content !== editorView.state.doc.toString()) {
			// Update content if it changed
			editorView.dispatch({
				changes: {
					from: 0,
					to: editorView.state.doc.length,
					insert: content
				}
			});
		}
	});

	$effect(() => {
		return () => {
			if (editorView) {
				editorView.destroy();
				editorView = null;
				mountedFile = '';
			}
		};
	});
</script>

<div class="editor">
	{#if currentFile}
		<div class="editor-header">
			<span class="filename">{currentFile}</span>
		</div>
		<div class="editor-content" bind:this={editorElement}></div>
	{:else}
		<div class="empty-state">
			<p>Select a file to edit, or ask the agent to create one</p>
		</div>
	{/if}
</div>

<style>
	.editor {
		height: 100%;
		display: flex;
		flex-direction: column;
		background: var(--color-bg-primary);
	}

	.editor-header {
		padding: 0.75rem 1rem;
		border-bottom: 1px solid var(--color-border);
		background: var(--color-bg-secondary);
	}

	.filename {
		font-size: 0.875rem;
		font-family: monospace;
		color: var(--color-text-secondary);
	}

	.editor-content {
		flex: 1;
		overflow: auto;
	}

	.editor-content :global(.cm-editor) {
		height: 100%;
	}

	.editor-content :global(.cm-scroller) {
		font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', 'source-code-pro', monospace;
		font-size: 14px;
	}

	.empty-state {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
		color: var(--color-text-secondary);
		font-style: italic;
	}
</style>
