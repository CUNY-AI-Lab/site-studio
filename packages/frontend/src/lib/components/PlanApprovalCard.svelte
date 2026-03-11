<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Check, X, FileCode, FilePlus, Trash2, FolderTree, ChevronDown, ChevronRight } from 'lucide-svelte';

	interface ToolCall {
		name: string;
		input: Record<string, any>;
	}

	let {
		plan = [],
		onApprove,
		onReject
	}: {
		plan: ToolCall[];
		onApprove: () => void;
		onReject: () => void;
	} = $props();

	// Track which steps have their diff expanded
	// Don't expand by default - keeps card compact so buttons are visible
	let expandedSteps = $state<Set<number>>(new Set());

	const toolConfig: Record<string, { icon: any; label: string; verb: string }> = {
		write_file: { icon: FilePlus, label: 'Create file', verb: 'Creating' },
		edit_file: { icon: FileCode, label: 'Edit file', verb: 'Editing' },
		scaffold_template: { icon: FolderTree, label: 'Scaffold template', verb: 'Scaffolding' },
		delete_file: { icon: Trash2, label: 'Delete file', verb: 'Deleting' }
	};

	// Extract tool name from MCP format (mcp__site-studio__tool_name -> tool_name)
	function getBaseName(name: string): string {
		const parts = name.split('__');
		return parts[parts.length - 1];
	}

	function getConfig(name: string) {
		const baseName = getBaseName(name);
		return toolConfig[baseName] || { icon: FileCode, label: baseName, verb: baseName };
	}

	function getFilePath(input: Record<string, any>): string {
		return input.file_path || input.path || input.template || '';
	}

	function getFileName(input: Record<string, any>): string {
		const filePath = getFilePath(input);
		const parts = filePath.split('/');
		return parts[parts.length - 1] || filePath;
	}

	function hasDiff(step: ToolCall): boolean {
		const baseName = getBaseName(step.name);
		if (baseName === 'edit_file') {
			// Tool uses old_text/new_text
			return step.input.old_text !== undefined && step.input.new_text !== undefined;
		}
		if (baseName === 'write_file') {
			return step.input.content !== undefined;
		}
		return false;
	}

	function getDiffContent(step: ToolCall): { before: string; after: string; isNew: boolean } {
		const baseName = getBaseName(step.name);
		if (baseName === 'edit_file') {
			return {
				before: step.input.old_text || '',
				after: step.input.new_text || '',
				isNew: false
			};
		}
		if (baseName === 'write_file') {
			return {
				before: '',
				after: step.input.content || '',
				isNew: true
			};
		}
		return { before: '', after: '', isNew: false };
	}

	function toggleExpanded(index: number) {
		if (expandedSteps.has(index)) {
			expandedSteps.delete(index);
		} else {
			expandedSteps.add(index);
		}
		expandedSteps = new Set(expandedSteps);
	}

	// Generate unified diff lines
	function generateDiffLines(before: string, after: string): Array<{ type: 'add' | 'remove' | 'context'; content: string; lineNum?: number }> {
		const lines: Array<{ type: 'add' | 'remove' | 'context'; content: string; lineNum?: number }> = [];

		if (!before && after) {
			// New file - show all as additions
			const afterLines = after.split('\n');
			afterLines.forEach((line, i) => {
				lines.push({ type: 'add', content: line, lineNum: i + 1 });
			});
			return lines;
		}

		// Simple line diff for edits
		const beforeLines = before.split('\n');
		const afterLines = after.split('\n');

		// Show removed lines
		beforeLines.forEach((line) => {
			if (!afterLines.includes(line)) {
				lines.push({ type: 'remove', content: line });
			}
		});

		// Show added lines
		afterLines.forEach((line, i) => {
			if (!beforeLines.includes(line)) {
				lines.push({ type: 'add', content: line, lineNum: i + 1 });
			}
		});

		return lines;
	}
</script>

<div class="approval-card">
	<div class="card-header">
		<div class="header-content">
			<div class="header-icon">
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/>
					<path d="M12 16v-4"/>
					<path d="M12 8h.01"/>
				</svg>
			</div>
			<div class="header-text">
				<h3>Approval Required</h3>
				<p>{plan.length} change{plan.length !== 1 ? 's' : ''} pending</p>
			</div>
		</div>
	</div>

	<div class="changes-list">
		{#each plan as step, i}
			{@const config = getConfig(step.name)}
			{@const StepIcon = config.icon}
			{@const diff = getDiffContent(step)}
			{@const diffLines = generateDiffLines(diff.before, diff.after)}
			{@const isExpanded = expandedSteps.has(i)}

			<div class="change-item" class:expanded={isExpanded}>
				<button
					class="change-header"
					onclick={() => hasDiff(step) && toggleExpanded(i)}
					class:clickable={hasDiff(step)}
				>
					<div class="change-info">
						<span class="change-icon" class:is-delete={getBaseName(step.name) === 'delete_file'}>
							<StepIcon size={14} />
						</span>
						<span class="change-action">{config.verb}</span>
						<code class="change-file">{getFileName(step.input)}</code>
					</div>

					{#if hasDiff(step)}
						<span class="expand-indicator">
							{#if isExpanded}
								<ChevronDown size={14} />
							{:else}
								<ChevronRight size={14} />
							{/if}
						</span>
					{/if}
				</button>

				{#if hasDiff(step) && isExpanded}
					<div class="diff-container">
						{#if diff.isNew}
							<div class="diff-badge new">New file</div>
						{:else}
							<div class="diff-badge edit">Edit</div>
						{/if}

						<div class="diff-content">
							{#each diffLines.slice(0, 20) as line}
								<div class="diff-line {line.type}">
									<span class="diff-prefix">{line.type === 'add' ? '+' : '−'}</span>
									<span class="diff-text">{line.content || ' '}</span>
								</div>
							{/each}

							{#if diffLines.length > 20}
								<div class="diff-truncated">
									+{diffLines.length - 20} more lines
								</div>
							{/if}
						</div>
					</div>
				{/if}
			</div>
		{/each}
	</div>

	<div class="card-actions">
		<button class="action-btn reject" onclick={onReject}>
			<X size={16} />
			<span>Reject</span>
		</button>
		<button class="action-btn approve" onclick={onApprove}>
			<Check size={16} />
			<span>Approve</span>
		</button>
	</div>
</div>

<style>
	.approval-card {
		background: linear-gradient(145deg,
			rgba(30, 32, 38, 0.98) 0%,
			rgba(24, 26, 32, 0.98) 100%
		);
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 12px;
		overflow: hidden;
		box-shadow:
			0 4px 24px rgba(0, 0, 0, 0.3),
			0 0 0 1px rgba(255, 255, 255, 0.03) inset;
		margin: 0.75rem 0;
		animation: cardSlideIn 0.25s cubic-bezier(0.16, 1, 0.3, 1);
		/* Prevent flex from squeezing the card - maintain natural height */
		flex-shrink: 0;
	}

	@keyframes cardSlideIn {
		from {
			opacity: 0;
			transform: translateY(-8px) scale(0.98);
		}
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}

	.card-header {
		padding: 1rem 1.25rem;
		background: linear-gradient(135deg,
			rgba(245, 158, 11, 0.12) 0%,
			rgba(245, 158, 11, 0.04) 100%
		);
		border-bottom: 1px solid rgba(245, 158, 11, 0.15);
	}

	.header-content {
		display: flex;
		align-items: center;
		gap: 0.875rem;
	}

	.header-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		background: rgba(245, 158, 11, 0.15);
		border-radius: 8px;
		color: #f59e0b;
	}

	.header-text h3 {
		font-size: 0.9375rem;
		font-weight: 600;
		color: #f4f4f5;
		margin: 0 0 0.125rem;
		letter-spacing: -0.01em;
	}

	.header-text p {
		font-size: 0.75rem;
		color: #a1a1aa;
		margin: 0;
	}

	.changes-list {
		max-height: 320px;
		overflow-y: auto;
		padding: 0.5rem;
	}

	.changes-list::-webkit-scrollbar {
		width: 6px;
	}

	.changes-list::-webkit-scrollbar-track {
		background: rgba(255, 255, 255, 0.02);
	}

	.changes-list::-webkit-scrollbar-thumb {
		background: rgba(255, 255, 255, 0.1);
		border-radius: 3px;
	}

	.change-item {
		border-radius: 8px;
		overflow: hidden;
		transition: background 0.15s ease;
	}

	.change-item:hover {
		background: rgba(255, 255, 255, 0.02);
	}

	.change-item.expanded {
		background: rgba(255, 255, 255, 0.03);
	}

	.change-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		padding: 0.625rem 0.75rem;
		background: transparent;
		border: none;
		cursor: default;
		text-align: left;
		transition: all 0.15s ease;
	}

	.change-header.clickable {
		cursor: pointer;
	}

	.change-header.clickable:hover {
		background: rgba(255, 255, 255, 0.03);
	}

	.change-info {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		min-width: 0;
	}

	.change-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		background: rgba(34, 197, 94, 0.12);
		border-radius: 5px;
		color: #22c55e;
		flex-shrink: 0;
	}

	.change-icon.is-delete {
		background: rgba(239, 68, 68, 0.12);
		color: #ef4444;
	}

	.change-action {
		font-size: 0.8125rem;
		font-weight: 500;
		color: #d4d4d8;
		white-space: nowrap;
	}

	.change-file {
		font-family: 'JetBrains Mono', 'SF Mono', 'Fira Code', monospace;
		font-size: 0.75rem;
		color: #71717a;
		background: rgba(255, 255, 255, 0.05);
		padding: 0.125rem 0.5rem;
		border-radius: 4px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.expand-indicator {
		display: flex;
		align-items: center;
		color: #52525b;
		transition: color 0.15s ease;
	}

	.change-header.clickable:hover .expand-indicator {
		color: #a1a1aa;
	}

	.diff-container {
		padding: 0.5rem 0.75rem 0.75rem;
		animation: diffFadeIn 0.2s ease;
	}

	@keyframes diffFadeIn {
		from {
			opacity: 0;
			transform: translateY(-4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.diff-badge {
		display: inline-flex;
		align-items: center;
		font-size: 0.625rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		padding: 0.25rem 0.5rem;
		border-radius: 4px;
		margin-bottom: 0.5rem;
	}

	.diff-badge.new {
		background: rgba(34, 197, 94, 0.15);
		color: #22c55e;
	}

	.diff-badge.edit {
		background: rgba(59, 130, 246, 0.15);
		color: #3b82f6;
	}

	.diff-content {
		font-family: 'JetBrains Mono', 'SF Mono', 'Fira Code', monospace;
		font-size: 0.6875rem;
		line-height: 1.5;
		background: rgba(0, 0, 0, 0.3);
		border: 1px solid rgba(255, 255, 255, 0.05);
		border-radius: 6px;
		overflow: hidden;
	}

	.diff-line {
		display: flex;
		padding: 0.125rem 0.5rem;
		border-left: 2px solid transparent;
	}

	.diff-line.add {
		background: rgba(34, 197, 94, 0.08);
		border-left-color: #22c55e;
		color: #86efac;
	}

	.diff-line.remove {
		background: rgba(239, 68, 68, 0.08);
		border-left-color: #ef4444;
		color: #fca5a5;
	}

	.diff-prefix {
		width: 1.5ch;
		flex-shrink: 0;
		opacity: 0.7;
		font-weight: 600;
	}

	.diff-text {
		white-space: pre-wrap;
		word-break: break-all;
	}

	.diff-truncated {
		padding: 0.5rem;
		text-align: center;
		font-size: 0.6875rem;
		color: #71717a;
		background: rgba(0, 0, 0, 0.2);
		border-top: 1px solid rgba(255, 255, 255, 0.05);
	}

	.card-actions {
		display: flex;
		gap: 0.625rem;
		padding: 0.875rem 1rem;
		background: rgba(0, 0, 0, 0.2);
		border-top: 1px solid rgba(255, 255, 255, 0.05);
	}

	.action-btn {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		padding: 0.625rem 1rem;
		border-radius: 8px;
		font-size: 0.8125rem;
		font-weight: 600;
		border: none;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.action-btn.reject {
		background: rgba(239, 68, 68, 0.1);
		color: #ef4444;
		border: 1px solid rgba(239, 68, 68, 0.2);
	}

	.action-btn.reject:hover {
		background: rgba(239, 68, 68, 0.2);
		border-color: rgba(239, 68, 68, 0.3);
		transform: translateY(-1px);
	}

	.action-btn.approve {
		background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
		color: white;
		border: 1px solid rgba(255, 255, 255, 0.1);
		box-shadow: 0 2px 8px rgba(34, 197, 94, 0.3);
	}

	.action-btn.approve:hover {
		background: linear-gradient(135deg, #16a34a 0%, #15803d 100%);
		transform: translateY(-1px);
		box-shadow: 0 4px 12px rgba(34, 197, 94, 0.4);
	}

	.action-btn:active {
		transform: translateY(0);
	}
</style>
