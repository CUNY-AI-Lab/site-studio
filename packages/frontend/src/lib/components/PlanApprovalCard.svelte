<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { CheckCircle, XCircle, FileEdit, FolderPlus, Trash2, FolderOpen } from 'lucide-svelte';

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

	const toolIcons: Record<string, any> = {
		write_file: FileEdit,
		scaffold_template: FolderPlus,
		delete_file: Trash2,
		read_file: FolderOpen,
		create_directory: FolderPlus,
		add_page: FileEdit,
		list_files: FolderOpen
	};

	const toolLabels: Record<string, string> = {
		write_file: 'Write file',
		scaffold_template: 'Create from template',
		delete_file: 'Delete file',
		read_file: 'Read file',
		create_directory: 'Create directory',
		add_page: 'Add page',
		list_files: 'List files'
	};

	function getToolLabel(name: string): string {
		return toolLabels[name] || name.replace(/_/g, ' ');
	}

	function formatInput(input: Record<string, any>): string {
		// Show key details in a compact format
		if (input.file_path) return input.file_path;
		if (input.directory_path) return input.directory_path;
		if (input.template) return `Template: ${input.template}`;
		if (input.page_name) return input.page_name;
		return JSON.stringify(input, null, 2);
	}
</script>

<div class="plan-card">
	<div class="plan-header">
		<h4>Proposed Actions</h4>
		<span class="plan-count">{plan.length} step{plan.length !== 1 ? 's' : ''}</span>
	</div>

	<div class="plan-steps">
		{#each plan as step, i}
			<div class="step">
				<span class="step-number">{i + 1}</span>
				<svelte:component this={toolIcons[step.name] || FileEdit} size={16} class="step-icon" />
				<div class="step-details">
					<strong class="step-name">{getToolLabel(step.name)}</strong>
					<code class="step-input">{formatInput(step.input)}</code>
				</div>
			</div>
		{/each}
	</div>

	<div class="plan-actions">
		<Button variant="outline" onclick={onReject} class="reject-btn">
			<XCircle size={16} />
			Reject
		</Button>
		<Button onclick={onApprove} class="approve-btn">
			<CheckCircle size={16} />
			Approve & Execute
		</Button>
	</div>
</div>

<style>
	.plan-card {
		background: rgba(59, 130, 246, 0.05);
		border: 2px solid rgba(59, 130, 246, 0.5);
		border-radius: 12px;
		padding: 1rem;
		margin: 0.5rem 0;
		animation: slideIn 0.2s ease-out;
	}

	@keyframes slideIn {
		from {
			opacity: 0;
			transform: translateY(-10px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.plan-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1rem;
		padding-bottom: 0.75rem;
		border-bottom: 1px solid var(--color-border);
	}

	.plan-header h4 {
		font-size: 1rem;
		font-weight: 600;
		color: var(--color-text-primary);
		margin: 0;
	}

	.plan-count {
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--color-text-secondary);
		background: var(--color-bg-secondary);
		padding: 0.25rem 0.5rem;
		border-radius: 4px;
	}

	.plan-steps {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin-bottom: 1rem;
		max-height: 400px;
		overflow-y: auto;
	}

	.step {
		display: flex;
		gap: 0.75rem;
		align-items: flex-start;
		padding: 0.75rem;
		background: rgba(255, 255, 255, 0.02);
		border-radius: 8px;
		transition: all 0.15s;
		border: 1px solid transparent;
	}

	.step:hover {
		background: rgba(255, 255, 255, 0.05);
		border-color: rgba(59, 130, 246, 0.3);
	}

	.step-number {
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: 24px;
		height: 24px;
		border-radius: 50%;
		background: var(--color-accent);
		color: white;
		font-size: 0.75rem;
		font-weight: 600;
		flex-shrink: 0;
	}

	:global(.step-icon) {
		color: var(--color-text-secondary);
		flex-shrink: 0;
		margin-top: 2px;
	}

	.step-details {
		flex: 1;
		min-width: 0;
	}

	.step-name {
		display: block;
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-text-primary);
		margin-bottom: 0.25rem;
		text-transform: capitalize;
	}

	.step-input {
		display: block;
		font-size: 0.75rem;
		font-family: 'Courier New', monospace;
		color: var(--color-text-secondary);
		background: var(--color-bg-tertiary);
		padding: 0.25rem 0.5rem;
		border-radius: 4px;
		overflow-x: auto;
		white-space: pre-wrap;
		word-break: break-all;
	}

	.plan-actions {
		display: flex;
		gap: 0.75rem;
		justify-content: flex-end;
		padding-top: 0.75rem;
		border-top: 1px solid var(--color-border);
	}

	:global(.reject-btn) {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	:global(.approve-btn) {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		background: rgb(59, 130, 246);
		color: white;
	}

	:global(.approve-btn:hover) {
		background: rgb(37, 99, 235);
	}
</style>
