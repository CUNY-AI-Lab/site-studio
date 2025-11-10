<script lang="ts">
	import { ChevronDown, ChevronRight, FileEdit, FolderPlus, Trash2, FolderOpen, Play, CheckCircle2, AlertCircle } from 'lucide-svelte';
	import DiffDisplay from './DiffDisplay.svelte';

	interface ToolExecution {
		name: string;
		input: Record<string, any>;
		status?: 'running' | 'success' | 'error';
		output?: string;
	}

	interface DiffData {
		type: 'file_write' | 'file_edit' | 'file_delete';
		file_path: string;
		before: string | null;
		after: string | null;
		isNewFile: boolean;
	}

	let {
		tool,
		index = 0,
		projectId = '',
		onRevert
	}: {
		tool: ToolExecution;
		index?: number;
		projectId?: string;
		onRevert?: () => void;
	} = $props();

	let expanded = $state(false);

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
		write_file: 'Writing file',
		scaffold_template: 'Creating from template',
		delete_file: 'Deleting file',
		read_file: 'Reading file',
		create_directory: 'Creating directory',
		add_page: 'Adding page',
		list_files: 'Listing files'
	};

	function getToolLabel(name: string): string {
		// Strip MCP server prefix patterns:
		// - "mcp__site-studio__list_files" -> "list_files"
		// - "mcp site-studio list files" -> "list files"
		// - "mcp-site-studio-list-files" -> "list-files"
		let cleanName = name
			.replace(/^mcp[\s_-]+[\w-]+[\s_-]+/, '')  // Remove MCP prefix
			.replace(/-/g, '_');  // Normalize hyphens to underscores

		return toolLabels[cleanName] || cleanName.replace(/_/g, ' ');
	}

	function getToolIcon(name: string) {
		// Normalize name to match icon keys
		const cleanName = name
			.replace(/^mcp[\s_-]+[\w-]+[\s_-]+/, '')
			.replace(/-/g, '_');
		return toolIcons[cleanName] || Play;
	}

	function formatInput(input: Record<string, any>): string {
		if (input.file_path) {
			// Show only filename, not full path
			const parts = input.file_path.split('/');
			return parts[parts.length - 1];
		}
		if (input.path) {
			// Show only filename for 'path' parameter too
			const parts = input.path.split('/');
			return parts[parts.length - 1];
		}
		if (input.directory_path) return input.directory_path;
		if (input.template) return `Template: ${input.template}`;
		if (input.page_name) return input.page_name;
		return Object.keys(input).length > 0 ? JSON.stringify(input, null, 2) : '';
	}

	function getStatusIcon() {
		if (tool.status === 'success') return CheckCircle2;
		if (tool.status === 'error') return AlertCircle;
		return Play;
	}

	function getStatusClass() {
		if (tool.status === 'success') return 'status-success';
		if (tool.status === 'error') return 'status-error';
		return 'status-running';
	}

	// Extract diff data from output
	function extractDiffData(output: string | undefined): { diffData: DiffData | null; cleanOutput: string } {
		if (!output) return { diffData: null, cleanOutput: '' };

		const diffMatch = output.match(/<!-- diff:([\s\S]*?) -->/);
		if (diffMatch) {
			try {
				const diffData = JSON.parse(diffMatch[1]) as DiffData;
				const cleanOutput = output.replace(/<!-- diff:[\s\S]*? -->/g, '').trim();
				return { diffData, cleanOutput };
			} catch (e) {
				console.error('Failed to parse diff data:', e);
			}
		}

		return { diffData: null, cleanOutput: output };
	}

	let parsedOutput = $derived(extractDiffData(tool.output));
	let hasDiff = $derived(parsedOutput.diffData !== null);
</script>

<button class="tool-card {getStatusClass()}" onclick={() => {
		expanded = !expanded;
	}}>
	<div class="tool-header">
		<div class="tool-info">
			<div class="tool-icon-wrapper">
				<svelte:component this={getToolIcon(tool.name)} size={14} class="tool-icon" />
			</div>
			<span class="tool-label">{getToolLabel(tool.name)}</span>
			{#if formatInput(tool.input)}
				<span class="tool-target">{formatInput(tool.input)}</span>
			{/if}
		</div>
		<div class="tool-status">
			<svelte:component this={getStatusIcon()} size={14} class="status-icon" />
			{#if tool.output}
				<svelte:component this={expanded ? ChevronDown : ChevronRight} size={14} class="chevron-icon" />
			{/if}
		</div>
	</div>

	{#if expanded && (hasDiff || parsedOutput.cleanOutput)}
		<div class="tool-output">
			{#if hasDiff && parsedOutput.diffData}
				<DiffDisplay diffData={parsedOutput.diffData} {projectId} {onRevert} />
			{/if}
			{#if parsedOutput.cleanOutput}
				<div class="output-message">
					{parsedOutput.cleanOutput}
				</div>
			{/if}
		</div>
	{/if}
</button>

<style>
	.tool-card {
		width: 100%;
		text-align: left;
		background: var(--color-bg-tertiary);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		padding: 0.75rem;
		margin: 0.5rem 0;
		transition: all 0.2s;
		cursor: pointer;
		position: relative;
		overflow: hidden;
		font-family: inherit;
		font-size: inherit;
		color: inherit;
	}

	.tool-card::before {
		content: '';
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		width: 3px;
		background: var(--indicator-color, rgb(107, 114, 128));
		transition: all 0.2s;
	}

	.tool-card.status-running {
		--indicator-color: rgb(59, 130, 246);
		background: rgba(59, 130, 246, 0.03);
	}

	.tool-card.status-running::before {
		animation: pulse 2s ease-in-out infinite;
	}

	@keyframes pulse {
		0%, 100% {
			opacity: 1;
		}
		50% {
			opacity: 0.5;
		}
	}

	.tool-card.status-success {
		--indicator-color: rgb(34, 197, 94);
		background: rgba(34, 197, 94, 0.03);
	}

	.tool-card.status-error {
		--indicator-color: rgb(239, 68, 68);
		background: rgba(239, 68, 68, 0.03);
	}

	.tool-card:hover {
		background: rgba(var(--indicator-color-rgb, 107, 114, 128), 0.08);
		border-color: var(--indicator-color);
	}

	.tool-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.75rem;
	}

	.tool-info {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: 1;
		min-width: 0;
	}

	.tool-icon-wrapper {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border-radius: 6px;
		background: var(--indicator-color);
		opacity: 0.15;
		flex-shrink: 0;
	}

	:global(.tool-icon) {
		color: var(--indicator-color);
		flex-shrink: 0;
	}

	.tool-label {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-text-primary);
		white-space: nowrap;
	}

	.tool-target {
		font-size: 0.75rem;
		font-family: 'Courier New', monospace;
		color: var(--color-text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
		min-width: 0;
	}

	.tool-status {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	:global(.status-icon) {
		color: var(--indicator-color);
		flex-shrink: 0;
	}

	:global(.chevron-icon) {
		color: var(--color-text-secondary);
		flex-shrink: 0;
		transition: color 0.2s;
	}

	.tool-card:hover :global(.chevron-icon) {
		color: var(--color-text-primary);
	}

	.tool-output {
		margin-top: 0.75rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--color-border);
		animation: slideDown 0.2s ease-out;
	}

	@keyframes slideDown {
		from {
			opacity: 0;
			max-height: 0;
		}
		to {
			opacity: 1;
			max-height: 500px;
		}
	}

	.output-message {
		margin-top: 0.5rem;
		padding: 0.75rem;
		background: var(--color-bg-secondary);
		border-radius: 6px;
		font-size: 0.875rem;
		color: var(--color-text-primary);
		line-height: 1.5;
	}
</style>
