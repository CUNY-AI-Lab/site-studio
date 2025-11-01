<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import CodeView from '$lib/components/CodeView.svelte';
	import Preview from '$lib/components/Preview.svelte';
	import AgentChat from '$lib/components/AgentChat.svelte';
	import * as Resizable from '$lib/components/ui/resizable';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import Button from '$lib/components/ui/button/button.svelte';
	import { ChevronDown, LayoutDashboard, Code2, PanelLeftClose, PanelRightClose } from 'lucide-svelte';
	import { fetchProjects, type Project } from '$lib/api/projects';
	import { Pane } from 'paneforge';

	let previewComponent: Preview;
	let chatPane: ReturnType<typeof Pane>;

	// Get projectId from URL params
	let projectId = $derived($page.params.projectId);
	let currentFile = $state('');
	let fileContent = $state('');
	let files = $state([]);
	let allProjects = $state<Project[]>([]);

	// Panel collapse state
	let isChatCollapsed = $state(false);
	let isCodeCollapsed = $state(true); // Start collapsed

	onMount(async () => {
		await loadFiles();
		await loadAllProjects();
	});

	async function loadAllProjects() {
		try {
			allProjects = await fetchProjects();
		} catch (error) {
			console.error('Error loading projects:', error);
		}
	}

	async function loadFiles() {
		if (!projectId) return;

		try {
			console.log('Loading files for project:', projectId);
			const response = await fetch(`/api/projects/${projectId}/files`);
			if (!response.ok) throw new Error('Failed to load files');

			const data = await response.json();
			console.log('Loaded files:', data.files);
			files = data.files;
		} catch (error) {
			console.error('Error loading files:', error);
		}
	}

	async function onFileSelect(filePath: string) {
		if (!projectId) return;

		try {
			console.log('Loading file:', filePath);
			const response = await fetch(`/api/projects/${projectId}/file?path=${encodeURIComponent(filePath)}`);
			if (!response.ok) throw new Error('Failed to load file');

			const data = await response.json();
			console.log('Loaded file content, length:', data.content.length);
			currentFile = filePath;
			fileContent = data.content;
			console.log('Set currentFile and fileContent state');
		} catch (error) {
			console.error('Error loading file:', error);
		}
	}

	let saveTimeout: ReturnType<typeof setTimeout> | null = null;
	let isSaving = $state(false);

	async function saveFile() {
		if (!projectId || !currentFile || !fileContent) return;

		try {
			isSaving = true;
			console.log('Saving file:', currentFile);

			const response = await fetch(`/api/projects/${projectId}/file`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					path: currentFile,
					content: fileContent
				})
			});

			if (!response.ok) throw new Error('Failed to save file');
			console.log('File saved successfully');

			// Refresh preview after save
			if (previewComponent) {
				previewComponent.refresh();
			}
		} catch (error) {
			console.error('Error saving file:', error);
			alert('Failed to save file');
		} finally {
			isSaving = false;
		}
	}

	function onEditorChange(content: string) {
		fileContent = content;

		// Auto-save after 1 second of no typing
		if (saveTimeout) clearTimeout(saveTimeout);
		saveTimeout = setTimeout(() => {
			saveFile();
		}, 1000);
	}

	async function onAgentUpdate() {
		// Reload files when agent makes changes
		await loadFiles();

		// Reload current file if it's open
		if (currentFile) {
			await onFileSelect(currentFile);
		}

		// Refresh preview to show agent's changes
		if (previewComponent) {
			previewComponent.refresh();
		}
	}

	function toggleChatPane() {
		console.log('toggleChatPane called', { chatPane, isChatCollapsed });
		if (!chatPane) return;
		if (isChatCollapsed) {
			chatPane.expand();
		} else {
			chatPane.collapse();
		}
	}

	function toggleCodePane() {
		isCodeCollapsed = !isCodeCollapsed;
	}

</script>

<div class="app">
	<!-- Toggle buttons for collapsed panels -->
	{#if isChatCollapsed}
		<button class="panel-toggle panel-toggle-left" onclick={toggleChatPane} title="Show Chat">
			<PanelLeftClose size={20} />
		</button>
	{/if}
	{#if isCodeCollapsed}
		<button class="panel-toggle panel-toggle-right" onclick={toggleCodePane} title="Show Code Editor">
			<Code2 size={20} />
		</button>
	{/if}

	<Resizable.PaneGroup direction="horizontal" class="main-layout">
		<!-- Left: Agent Chat Sidebar (collapsible) -->
		<Resizable.Pane
			bind:this={chatPane}
			defaultSize={25}
			minSize={15}
			maxSize={40}
			collapsible={true}
			onCollapse={() => (isChatCollapsed = true)}
			onExpand={() => (isChatCollapsed = false)}
		>
			<aside class="chat-sidebar">
				<div class="chat-header">
					<div class="header-top">
						<h1 class="logo">🎨 Site Studio</h1>
						<Button variant="ghost" size="sm" href="/">
							<LayoutDashboard size={18} />
						</Button>
					</div>
					<DropdownMenu.Root>
						<DropdownMenu.Trigger asChild>
							{#snippet child({ props })}
								<button {...props} class="project-selector">
									<span class="project-name">{projectId}</span>
									<ChevronDown size={16} class="chevron" />
								</button>
							{/snippet}
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="start" class="project-menu">
							{#if allProjects.length > 0}
								{#each allProjects as project (project.id)}
									<DropdownMenu.Item
										onclick={() => goto(`/editor/${project.id}`)}
										class={project.id === projectId ? 'active-project' : ''}
									>
										{project.name}
										{#if project.id === projectId}
											<span class="current-indicator">•</span>
										{/if}
									</DropdownMenu.Item>
								{/each}
							{:else}
								<DropdownMenu.Item disabled>No other projects</DropdownMenu.Item>
							{/if}
						</DropdownMenu.Content>
					</DropdownMenu.Root>
				</div>
				<div class="chat-wrapper">
					<AgentChat {projectId} onUpdate={onAgentUpdate} />
				</div>
			</aside>
		</Resizable.Pane>

		<Resizable.Handle withHandle />

		<!-- Center: Preview (always visible) -->
		<Resizable.Pane defaultSize={75} minSize={30}>
			<main class="preview-area">
				<Preview bind:this={previewComponent} {projectId} />
			</main>
		</Resizable.Pane>
	</Resizable.PaneGroup>

	<!-- Right: Code Editor Overlay with paneforge resize -->
	<div class="overlay-container" class:visible={!isCodeCollapsed}>
		<Resizable.PaneGroup direction="horizontal" class="overlay-panes">
			<!-- Invisible spacer pane -->
			<Resizable.Pane defaultSize={60} minSize={0} maxSize={100}>
				<div class="spacer"></div>
			</Resizable.Pane>

			<Resizable.Handle withHandle />

			<!-- Code editor pane -->
			<Resizable.Pane
				defaultSize={40}
				minSize={25}
				maxSize={80}
			>
				<aside class="code-panel">
					<button class="close-editor-button" onclick={toggleCodePane} title="Close Editor">
						<PanelRightClose size={20} />
					</button>
					<CodeView
						{projectId}
						{files}
						{currentFile}
						{fileContent}
						{isSaving}
						onFileSelect={onFileSelect}
						onEditorChange={onEditorChange}
						onRefreshFiles={loadFiles}
					/>
				</aside>
			</Resizable.Pane>
		</Resizable.PaneGroup>
	</div>
</div>

<style>
	.app {
		display: flex;
		flex-direction: column;
		height: 100vh;
		position: relative;
	}

	:global(.main-layout) {
		height: 100vh;
	}

	/* Panel Toggle Buttons */
	.panel-toggle {
		position: fixed;
		top: 50%;
		transform: translateY(-50%);
		background: var(--color-bg-secondary);
		border: 1px solid var(--color-border);
		padding: 0.75rem;
		border-radius: 0.5rem;
		cursor: pointer;
		z-index: 50;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.2s;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
	}

	.panel-toggle:hover {
		background: var(--color-bg-tertiary);
		border-color: var(--color-primary);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
	}

	.panel-toggle-left {
		left: 1rem;
	}

	.panel-toggle-right {
		right: 1rem;
	}

	/* Left Chat Sidebar */
	.chat-sidebar {
		display: flex;
		flex-direction: column;
		background: var(--color-bg-secondary);
		height: 100%;
		overflow: hidden;
	}

	.chat-wrapper {
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.chat-header {
		flex-shrink: 0;
		padding: 1.5rem;
		border-bottom: 1px solid var(--color-border);
	}

	.chat-header .logo {
		font-size: 1.25rem;
		font-weight: 600;
		margin-bottom: 0.5rem;
	}

	.header-top {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.75rem;
	}

	.header-top .logo {
		margin-bottom: 0;
	}

	.project-selector {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 0.375rem;
		cursor: pointer;
		width: 100%;
		transition: all 0.2s;
	}

	.project-selector:hover {
		background: var(--color-bg-tertiary);
		border-color: var(--color-primary);
	}

	.project-name {
		font-size: 0.875rem;
		color: var(--color-text-secondary);
		font-family: monospace;
		flex: 1;
	}

	.chevron {
		color: var(--color-text-tertiary);
	}

	:global(.project-menu .active-project) {
		background: var(--color-bg-tertiary);
		font-weight: 600;
	}

	.current-indicator {
		margin-left: auto;
		color: var(--color-primary);
		font-size: 1.25rem;
	}

	/* Center Preview Area */
	.preview-area {
		height: 100%;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: var(--color-bg);
	}

	/* Overlay Container */
	.overlay-container {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		width: 100vw;
		pointer-events: none;
		transform: translateX(100%);
		transition: transform 0.3s ease-out;
		z-index: 100;
	}

	.overlay-container.visible {
		transform: translateX(0);
	}

	:global(.overlay-panes) {
		height: 100vh;
		pointer-events: auto;
	}

	.spacer {
		height: 100%;
		background: transparent;
		pointer-events: none;
	}

	.code-panel {
		height: 100%;
		background: var(--color-bg);
		box-shadow: -4px 0 12px rgba(0, 0, 0, 0.15);
		display: flex;
		flex-direction: column;
		position: relative;
	}

	.close-editor-button {
		position: absolute;
		top: 0.5rem;
		right: 1rem;
		background: var(--color-bg-secondary);
		border: 1px solid var(--color-border);
		padding: 0.5rem;
		border-radius: 0.375rem;
		cursor: pointer;
		z-index: 10;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.15s;
	}

	.close-editor-button:hover {
		background: var(--color-bg-tertiary);
		border-color: var(--color-primary);
	}
</style>
