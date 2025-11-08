<script lang="ts">
	import { diffLines, type Change } from 'diff';
	import { Button } from './ui/button';
	import { Undo2 } from 'lucide-svelte';
	import { resolvePath } from '$lib/utils/paths';

	interface DiffData {
		type: 'file_write' | 'file_edit' | 'file_delete';
		file_path: string;
		before: string | null;
		after: string | null;
		isNewFile: boolean;
	}

	let {
		diffData,
		projectId,
		onRevert
	}: {
		diffData: DiffData;
		projectId: string;
		onRevert?: () => void;
	} = $props();

	let isReverting = $state(false);
	let reverted = $state(false);

	// Compute the diff
	let changes = $derived.by(() => {
		if (diffData.type === 'file_delete') {
			// For deletions, show all lines as removed
			return diffData.before
				? diffLines('', diffData.before).map((change) => ({ ...change, removed: true, added: false }))
				: [];
		} else if (diffData.isNewFile) {
			// For new files, show all lines as added
			return diffData.after
				? diffLines('', diffData.after).map((change) => ({ ...change, added: true, removed: false }))
				: [];
		} else {
			// For edits, show the actual diff
			return diffLines(diffData.before || '', diffData.after || '');
		}
	});

	// Count additions and deletions
	let stats = $derived.by(() => {
		let additions = 0;
		let deletions = 0;
		for (const change of changes) {
			const lineCount = change.value.split('\n').filter((l) => l).length;
			if (change.added) additions += lineCount;
			if (change.removed) deletions += lineCount;
		}
		return { additions, deletions };
	});

	async function handleRevert() {
		if (reverted) return; // Already reverted

		isReverting = true;
		try {
			const response = await fetch(resolvePath(`/api/projects/${projectId}/revert`), {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					file_path: diffData.file_path,
					content: diffData.before, // Restore to before state
				}),
			});

			if (!response.ok) {
				throw new Error('Failed to revert file');
			}

			reverted = true;

			// Notify parent component if callback provided
			if (onRevert) {
				onRevert();
			}
		} catch (error) {
			console.error('Error reverting file:', error);
			alert('Failed to revert file. Please try again.');
		} finally {
			isReverting = false;
		}
	}
</script>

<div class="diff-display">
	<div class="diff-header">
		<div class="diff-file-info">
			<span class="diff-file-path">{diffData.file_path}</span>
			{#if diffData.type === 'file_delete'}
				<span class="diff-badge deleted">Deleted</span>
			{:else if diffData.isNewFile}
				<span class="diff-badge created">Created</span>
			{:else}
				<span class="diff-badge modified">Modified</span>
			{/if}
		</div>
		<div class="diff-stats">
			{#if stats.additions > 0}
				<span class="stat additions">+{stats.additions}</span>
			{/if}
			{#if stats.deletions > 0}
				<span class="stat deletions">-{stats.deletions}</span>
			{/if}
			<Button
				variant={reverted ? "default" : "outline"}
				size="sm"
				onclick={handleRevert}
				disabled={isReverting || reverted}
			>
				<Undo2 size={14} />
				{reverted ? 'Reverted' : isReverting ? 'Reverting...' : 'Revert'}
			</Button>
		</div>
	</div>

	<div class="diff-content">
		{#each changes as change}
			{#if change.added}
				<div class="diff-line added">
					<span class="line-marker">+</span>
					<pre>{change.value.trimEnd()}</pre>
				</div>
			{:else if change.removed}
				<div class="diff-line removed">
					<span class="line-marker">-</span>
					<pre>{change.value.trimEnd()}</pre>
				</div>
			{:else}
				<div class="diff-line unchanged">
					<span class="line-marker"> </span>
					<pre>{change.value.trimEnd()}</pre>
				</div>
			{/if}
		{/each}
	</div>
</div>

<style>
	.diff-display {
		border: 1px solid var(--color-border);
		border-radius: 8px;
		overflow: hidden;
		background: var(--color-bg-secondary);
		margin: 0.5rem 0;
	}

	.diff-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.75rem;
		background: var(--color-bg-tertiary);
		border-bottom: 1px solid var(--color-border);
		gap: 0.75rem;
	}

	.diff-file-info {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: 1;
		min-width: 0;
	}

	.diff-file-path {
		font-family: 'Courier New', monospace;
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.diff-badge {
		padding: 0.125rem 0.5rem;
		border-radius: 4px;
		font-size: 0.75rem;
		font-weight: 500;
		white-space: nowrap;
	}

	.diff-badge.created {
		background: rgba(34, 197, 94, 0.15);
		color: rgb(34, 197, 94);
	}

	.diff-badge.modified {
		background: rgba(59, 130, 246, 0.15);
		color: rgb(59, 130, 246);
	}

	.diff-badge.deleted {
		background: rgba(239, 68, 68, 0.15);
		color: rgb(239, 68, 68);
	}

	.diff-stats {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.stat {
		font-family: 'Courier New', monospace;
		font-size: 0.75rem;
		font-weight: 600;
	}

	.stat.additions {
		color: rgb(34, 197, 94);
	}

	.stat.deletions {
		color: rgb(239, 68, 68);
	}

	.diff-content {
		max-height: 400px;
		overflow-y: auto;
		font-family: 'Courier New', monospace;
		font-size: 0.75rem;
		line-height: 1.5;
	}

	.diff-line {
		display: flex;
		align-items: flex-start;
		min-height: 1.5rem;
	}

	.diff-line.added {
		background: rgba(34, 197, 94, 0.1);
	}

	.diff-line.removed {
		background: rgba(239, 68, 68, 0.1);
	}

	.diff-line.unchanged {
		background: transparent;
	}

	.line-marker {
		display: inline-block;
		width: 2rem;
		padding: 0 0.5rem;
		text-align: center;
		flex-shrink: 0;
		user-select: none;
		color: var(--color-text-secondary);
	}

	.diff-line.added .line-marker {
		color: rgb(34, 197, 94);
		font-weight: 600;
	}

	.diff-line.removed .line-marker {
		color: rgb(239, 68, 68);
		font-weight: 600;
	}

	.diff-line pre {
		margin: 0;
		padding: 0 0.5rem;
		flex: 1;
		white-space: pre-wrap;
		word-break: break-all;
		color: var(--color-text-primary);
		background: transparent;
	}
</style>
