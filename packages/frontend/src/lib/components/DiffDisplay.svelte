<script lang="ts">
	import { diffLines, type Change } from 'diff';
	import { History } from 'lucide-svelte';

	interface DiffData {
		type: 'file_write' | 'file_edit' | 'file_delete';
		file_path: string;
		before: string | null;
		after: string | null;
		isNewFile: boolean;
	}

	let {
		diffData
	}: {
		diffData: DiffData;
	} = $props();

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
			const lineCount = change.value.split('\n').length - (change.value.endsWith('\n') ? 1 : 0);
			if (change.added) additions += lineCount;
			if (change.removed) deletions += lineCount;
		}
		return { additions, deletions };
	});

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
		</div>
	</div>

	<div class="diff-note">
		<History size={14} />
		<span>Use Version History from the project menu to restore earlier versions.</span>
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
		border: 2px solid var(--color-border);
		border-radius: 0;
		overflow: hidden;
		background: var(--color-bg-primary);
		margin: 0.5rem 0;
		box-shadow: var(--shadow-sm);
	}

	.diff-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.75rem;
		background: var(--color-bg-secondary);
		border-bottom: 2px solid var(--color-border);
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
		font-family: var(--font-mono);
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--color-text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.diff-badge {
		padding: 0.25rem 0.625rem;
		border-radius: 0;
		border: 2px solid currentColor;
		font-size: 0.65rem;
		font-weight: 700;
		font-family: var(--font-mono);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		white-space: nowrap;
	}

	.diff-badge.created {
		background: transparent;
		color: var(--color-success);
	}

	.diff-badge.modified {
		background: transparent;
		color: var(--color-accent);
	}

	.diff-badge.deleted {
		background: transparent;
		color: var(--color-error);
	}

	.diff-stats {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.stat {
		font-family: var(--font-mono);
		font-size: 0.75rem;
		font-weight: 700;
	}

	.stat.additions {
		color: var(--color-success);
	}

	.stat.deletions {
		color: var(--color-error);
	}

	.diff-content {
		max-height: 400px;
		overflow-y: auto;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		line-height: 1.6;
		background: var(--color-bg-tertiary);
	}

	.diff-note {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.625rem 0.75rem;
		border-bottom: 1px solid var(--color-border);
		background: var(--color-bg-primary);
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.diff-line {
		display: flex;
		align-items: flex-start;
		min-height: 1.5rem;
		border-left: 3px solid transparent;
	}

	.diff-line.added {
		background: var(--color-bg-secondary);
		border-left-color: var(--color-success);
	}

	.diff-line.removed {
		background: var(--color-bg-secondary);
		border-left-color: var(--color-error);
	}

	.diff-line.unchanged {
		background: transparent;
	}

	.line-marker {
		display: inline-block;
		width: 2.5rem;
		padding: 0 0.5rem;
		text-align: center;
		flex-shrink: 0;
		user-select: none;
		color: var(--color-text-tertiary);
		font-weight: 700;
	}

	.diff-line.added .line-marker {
		color: var(--color-success);
		font-weight: 700;
	}

	.diff-line.removed .line-marker {
		color: var(--color-error);
		font-weight: 700;
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
