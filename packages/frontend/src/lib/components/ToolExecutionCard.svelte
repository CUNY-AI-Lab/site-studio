<script lang="ts">
	import { ChevronDown, ChevronRight, FileEdit, FolderPlus, Trash2, FolderOpen, Play, CheckCircle2, AlertCircle, MessageSquare, Blocks } from 'lucide-svelte';
	import DiffDisplay from './DiffDisplay.svelte';

	interface ToolExecution {
		id?: string;
		name: string;
		input: Record<string, any>;
		status?: 'running' | 'success' | 'error';
		output?: string;
		startTime?: number;
		elapsedTime?: number;
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
		codemode: Blocks,
		write_file: FileEdit,
		edit_file: FileEdit,
		rename_file: FileEdit,
		scaffold_template: FolderPlus,
		delete_file: Trash2,
		read_file: FolderOpen,
		search_files: FolderOpen,
		create_directory: FolderPlus,
		add_page: FileEdit,
		list_files: FolderOpen,
		ask_user_question: MessageSquare,
		AskUserQuestion: MessageSquare
	};

	const toolLabels: Record<string, string> = {
		codemode: 'Running sandbox',
		write_file: 'Writing file',
		edit_file: 'Editing file',
		rename_file: 'Renaming file',
		scaffold_template: 'Creating from template',
		delete_file: 'Deleting file',
		read_file: 'Reading file',
		search_files: 'Searching files',
		create_directory: 'Creating directory',
		add_page: 'Adding page',
		list_files: 'Listing files',
		ask_user_question: 'Asking for clarification',
		AskUserQuestion: 'Asking for clarification'
	};

	function getToolLabel(name: string): string {
		if (toolLabels[name]) {
			return toolLabels[name];
		}

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
		if (toolIcons[name]) {
			return toolIcons[name];
		}

		// Normalize name to match icon keys
		const cleanName = name
			.replace(/^mcp[\s_-]+[\w-]+[\s_-]+/, '')
			.replace(/-/g, '_');
		return toolIcons[cleanName] || Play;
	}

	function formatInput(input: Record<string, any>): string {
		if (tool.name === 'codemode') {
			return 'Dynamic Worker sandbox';
		}
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
		if (input.templateId) return `Template: ${input.templateId}`;
		if (input.page_name) return input.page_name;
		if (input.oldPath) return input.oldPath;
		if (Array.isArray(input.questions) && input.questions.length > 0) {
			return input.questions[0]?.header || input.questions[0]?.question || '';
		}
		if (input.question) return input.question;
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
	let ToolIcon = $derived(getToolIcon(tool.name));
	let StatusIcon = $derived(getStatusIcon());
	let ChevronIcon = $derived(expanded ? ChevronDown : ChevronRight);
</script>

<button class="tool-card {getStatusClass()}" class:expanded={expanded} onclick={() => {
		expanded = !expanded;
	}}>
	<div class="tool-header">
		<div class="tool-info">
			<div class="tool-icon-wrapper">
				<ToolIcon size={14} class="tool-icon" />
			</div>
			<span class="tool-label">{getToolLabel(tool.name)}</span>
			{#if formatInput(tool.input)}
				<span class="tool-target">{formatInput(tool.input)}</span>
			{/if}
		</div>
		<div class="tool-status">
			{#if tool.status === 'running' && tool.elapsedTime !== undefined}
				<span class="elapsed-time">{tool.elapsedTime.toFixed(1)}s</span>
			{/if}
			<StatusIcon size={14} class="status-icon" />
			{#if tool.output}
				<ChevronIcon size={14} class="chevron-icon" />
			{/if}
		</div>
	</div>

	{#if expanded && (hasDiff || parsedOutput.cleanOutput)}
		<div class="tool-output">
			{#if hasDiff && parsedOutput.diffData}
				<DiffDisplay diffData={parsedOutput.diffData} />
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
		width: auto;
		max-width: 280px;
		text-align: left;
		background: var(--color-bg-elevated);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		padding: 0.5rem 0.625rem;
		transition: all 0.15s ease;
		cursor: pointer;
		position: relative;
		overflow: hidden;
		font-family: var(--font-sans);
		font-size: 0.8125rem;
		color: inherit;
		flex-shrink: 0;
	}

	.tool-card.expanded {
		width: 100%;
		max-width: 100%;
		flex-basis: 100%;
	}

	.tool-card::before {
		content: '';
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		width: 3px;
		background: var(--indicator-color, var(--color-text-tertiary));
		border-radius: var(--radius-full) 0 0 var(--radius-full);
		transition: all 0.15s ease;
	}

	.tool-card.status-running {
		--indicator-color: var(--color-tertiary);
		background: var(--color-tertiary-light);
		border-color: var(--color-tertiary);
	}

	.tool-card.status-running::before {
		animation: pulse 1.5s ease-in-out infinite;
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
		--indicator-color: var(--color-success);
		background: var(--color-bg-elevated);
		border-color: var(--color-border);
	}

	.tool-card.status-error {
		--indicator-color: var(--color-error);
		background: var(--color-error-light);
		border-color: var(--color-error);
	}

	.tool-card:hover {
		border-color: var(--color-border-hover);
	}

	.tool-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.5rem;
	}

	.tool-info {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		flex: 1;
		min-width: 0;
		overflow: hidden;
	}

	.tool-icon-wrapper {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		border-radius: var(--radius-sm);
		background: var(--indicator-color);
		opacity: 0.15;
		flex-shrink: 0;
	}

	:global(.tool-icon) {
		color: var(--color-text-primary);
		flex-shrink: 0;
	}

	.tool-label {
		font-size: 0.75rem;
		font-weight: 500;
		font-family: var(--font-sans);
		color: var(--color-text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.tool-target {
		font-size: 0.6875rem;
		font-family: var(--font-mono);
		color: var(--color-text-tertiary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 100px;
	}

	.tool-status {
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}

	.elapsed-time {
		font-size: 0.75rem;
		font-family: var(--font-mono);
		color: var(--color-text-tertiary);
		padding: 0.125rem 0.375rem;
		background: var(--color-bg-secondary);
		border-radius: var(--radius-sm);
		animation: pulse 1.5s ease-in-out infinite;
	}

	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.6; }
	}

	:global(.status-icon) {
		color: var(--indicator-color);
		flex-shrink: 0;
	}

	:global(.chevron-icon) {
		color: var(--color-text-tertiary);
		flex-shrink: 0;
		transition: color 0.15s ease;
	}

	.tool-card:hover :global(.chevron-icon) {
		color: var(--color-text-secondary);
	}

	.tool-output {
		margin-top: 0.625rem;
		padding-top: 0.625rem;
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
		padding: 0.625rem 0.75rem;
		background: var(--color-bg-secondary);
		border-radius: var(--radius-sm);
		font-size: 0.8125rem;
		font-family: var(--font-mono);
		color: var(--color-text-secondary);
		line-height: 1.5;
		white-space: pre-wrap;
	}
</style>
