<script lang="ts">
	let {
		oldContent = '',
		newContent = '',
		maxLines = 30
	}: {
		oldContent?: string;
		newContent?: string;
		maxLines?: number;
	} = $props();

	interface DiffLine {
		type: 'added' | 'removed' | 'unchanged';
		content: string;
	}

	// Simple line-by-line diff
	function generateDiff(oldText: string, newText: string): DiffLine[] {
		const oldLines = oldText.split('\n');
		const newLines = newText.split('\n');
		const result: DiffLine[] = [];

		// Simple diff: find removed lines, then added lines
		// This is a basic implementation - for complex diffs, use a proper diff library
		const oldSet = new Set(oldLines);
		const newSet = new Set(newLines);

		// Lines only in old (removed)
		for (const line of oldLines) {
			if (!newSet.has(line)) {
				result.push({ type: 'removed', content: line });
			}
		}

		// Lines only in new (added)
		for (const line of newLines) {
			if (!oldSet.has(line)) {
				result.push({ type: 'added', content: line });
			}
		}

		return result;
	}

	let diffLines = $derived(generateDiff(oldContent, newContent));
	let displayLines = $derived(diffLines.slice(0, maxLines));
	let hasMore = $derived(diffLines.length > maxLines);
	let remainingCount = $derived(diffLines.length - maxLines);
</script>

<div class="diff-preview">
	{#each displayLines as line}
		<div class="diff-line {line.type}">
			<span class="prefix">{line.type === 'added' ? '+' : '-'}</span>
			<span class="content">{line.content || ' '}</span>
		</div>
	{/each}
	{#if hasMore}
		<div class="diff-truncated">
			... {remainingCount} more line{remainingCount !== 1 ? 's' : ''}
		</div>
	{/if}
	{#if diffLines.length === 0 && newContent}
		<div class="diff-info">New file with {newContent.split('\n').length} lines</div>
	{/if}
</div>

<style>
	.diff-preview {
		font-family: 'Courier New', monospace;
		font-size: 0.75rem;
		background: var(--color-bg-tertiary);
		border-radius: 6px;
		padding: 0.5rem;
		max-height: 200px;
		overflow-y: auto;
	}

	.diff-line {
		display: flex;
		gap: 0.5rem;
		padding: 0.125rem 0.25rem;
		border-radius: 2px;
	}

	.diff-line.added {
		background: rgba(34, 197, 94, 0.15);
		color: rgb(34, 197, 94);
	}

	.diff-line.removed {
		background: rgba(239, 68, 68, 0.15);
		color: rgb(239, 68, 68);
	}

	.prefix {
		font-weight: 600;
		flex-shrink: 0;
		width: 1ch;
	}

	.content {
		white-space: pre-wrap;
		word-break: break-all;
	}

	.diff-truncated {
		color: var(--color-text-secondary);
		font-style: italic;
		padding: 0.25rem;
		text-align: center;
	}

	.diff-info {
		color: var(--color-text-secondary);
		padding: 0.25rem;
		text-align: center;
	}
</style>
