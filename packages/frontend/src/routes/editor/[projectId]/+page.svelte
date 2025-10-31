<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import CodeView from '$lib/components/CodeView.svelte';
	import Preview from '$lib/components/Preview.svelte';
	import AgentChat from '$lib/components/AgentChat.svelte';
	import * as Tabs from '$lib/components/ui/tabs';
	import * as Resizable from '$lib/components/ui/resizable';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import Button from '$lib/components/ui/button/button.svelte';
	import { Eye, Code2, ChevronDown, LayoutDashboard } from 'lucide-svelte';
	import { fetchProjects, type Project } from '$lib/api/projects';

	let previewComponent: Preview;

	// Get projectId from URL params
	let projectId = $derived($page.params.projectId);
	let currentFile = $state('');
	let fileContent = $state('');
	let files = $state([]);
	let activeTab = $state<'preview' | 'code'>('preview');
	let allProjects = $state<Project[]>([]);

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

</script>

<div class="app">
	<Resizable.PaneGroup direction="horizontal" class="main-layout">
			<!-- Left: Agent Chat Sidebar -->
			<Resizable.Pane defaultSize={30} minSize={20} maxSize={50}>
				<aside class="chat-sidebar">
					<div class="chat-header">
						<div class="header-top">
							<h1 class="logo">🎨 Site Studio</h1>
							<Button variant="ghost" size="sm" onclick={() => goto('/')}>
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

			<!-- Right: Content Area with Tabs -->
			<Resizable.Pane defaultSize={70}>
				<main class="content-area">
					<Tabs.Root value={activeTab} onValueChange={(v) => (activeTab = v)} class="tabs-container">
						<Tabs.List class="tab-bar">
							<Tabs.Trigger value="preview" class="tab-trigger">
								<Eye size={20} />
							</Tabs.Trigger>
							<Tabs.Trigger value="code" class="tab-trigger">
								<Code2 size={20} />
							</Tabs.Trigger>
						</Tabs.List>

						<Tabs.Content value="preview" class="tab-content">
							<Preview bind:this={previewComponent} {projectId} />
						</Tabs.Content>

						<Tabs.Content value="code" class="tab-content">
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
						</Tabs.Content>
					</Tabs.Root>
				</main>
			</Resizable.Pane>
	</Resizable.PaneGroup>
</div>

<style>
	.app {
		display: flex;
		flex-direction: column;
		height: 100vh;
	}

	:global(.main-layout) {
		height: 100vh;
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

	/* Right Content Area (~70%) */
	.content-area {
		flex: 1;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	:global(.tabs-container) {
		display: flex;
		flex-direction: column;
		height: 100%;
	}

	:global(.tab-bar) {
		display: flex;
		gap: 0.25rem;
		padding: 0.75rem 1rem;
		background: var(--color-bg-secondary);
		border-bottom: 1px solid var(--color-border);
	}

	:global(.tab-content) {
		flex: 1;
		overflow: hidden;
	}

	/* Content area */
	.content-area {
		height: 100%;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
</style>
