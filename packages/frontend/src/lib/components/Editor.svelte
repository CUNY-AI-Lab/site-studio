<script lang="ts">
	import { onMount } from 'svelte';
	import { EditorView, basicSetup } from 'codemirror';
	import { html } from '@codemirror/lang-html';
	import { css } from '@codemirror/lang-css';
	import { javascript } from '@codemirror/lang-javascript';

	let { currentFile = '', content = '', onChange }: {
		currentFile: string;
		content: string;
		onChange: (content: string) => void;
	} = $props();

	let editorElement: HTMLDivElement;
	let editorView: EditorView | null = null;

	$effect(() => {
		// Only initialize editor when we have a file and an element to attach to
		if (currentFile && editorElement && !editorView) {
			editorView = new EditorView({
				doc: content,
				extensions: [
					basicSetup,
					getLanguageExtension(currentFile),
					EditorView.updateListener.of((update) => {
						if (update.docChanged) {
							onChange(update.state.doc.toString());
						}
					})
				],
				parent: editorElement
			});
		} else if (editorView && content !== editorView.state.doc.toString()) {
			// Update content if it changed
			editorView.dispatch({
				changes: {
					from: 0,
					to: editorView.state.doc.length,
					insert: content
				}
			});
		}

		// Cleanup when component unmounts or file changes
		return () => {
			if (editorView && !currentFile) {
				editorView.destroy();
				editorView = null;
			}
		};
	});

	function getLanguageExtension(filename: string) {
		if (filename.endsWith('.html')) return html();
		if (filename.endsWith('.css')) return css();
		if (filename.endsWith('.js')) return javascript();
		return html(); // default
	}
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
