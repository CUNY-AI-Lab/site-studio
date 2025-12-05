<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { resolvePath } from '$lib/utils/paths';
	import CodeView from '$lib/components/CodeView.svelte';
	import Preview from '$lib/components/Preview.svelte';
	import AgentChat from '$lib/components/AgentChat.svelte';
	import * as Resizable from '$lib/components/ui/resizable';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import Button from '$lib/components/ui/button/button.svelte';
    import { ChevronDown, LayoutDashboard, Code2, PanelLeftClose, PanelRightClose, MoreVertical, Globe, GlobeLock, ExternalLink, Download, Check, Loader2 } from 'lucide-svelte';
	import { fetchProjects, publishProject, unpublishProject, type Project } from '$lib/api/projects';
	import ProjectDialogs from '$lib/components/ProjectDialogs.svelte';
	import { Pane } from 'paneforge';
	import { hasCompletedOnboarding, createEditorTour } from '$lib/utils/onboarding';
	import 'driver.js/dist/driver.css';
	import '$lib/styles/onboarding-tour.css';

	let previewComponent: Preview;
	let chatPane: ReturnType<typeof Pane>;

	// Get projectId from URL params
	let projectId = $derived($page.params.projectId);
	let currentFile = $state('');
	let fileContent = $state('');
	let files = $state([]);
	let allProjects = $state<Project[]>([]);
	let currentProject = $state<Project | null>(null);

	// Reactive page title based on current project
	let pageTitle = $derived(currentProject ? `${currentProject.name} - Site Studio` : 'Editor - Site Studio');

	// Panel collapse state
	let isChatCollapsed = $state(false);
	let isCodeCollapsed = $state(true); // Start collapsed
	let isDragging = $state(false);

	// Dialog states
	let showRenameDialog = $state(false);
	let showDeleteDialog = $state(false);
	let publishingProjectId = $state<string | null>(null);

	function handleDragChange(dragging: boolean) {
		isDragging = dragging;
	}

	onMount(async () => {
		await loadFiles();
		await loadAllProjects();

		// Show onboarding tour for first-time users
		if (!hasCompletedOnboarding()) {
			// Small delay to ensure DOM is ready
			setTimeout(() => {
				const tour = createEditorTour();
				tour.drive();
			}, 1000);
		}

		// Add keyboard shortcut to force tutorial (Ctrl+Shift+H or Cmd+Shift+H for Help)
		const handleKeyPress = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'H') {
				e.preventDefault();
				const tour = createEditorTour();
				tour.drive();
			}
		};
		window.addEventListener('keydown', handleKeyPress);

		// Expose function to force tutorial from console
		(window as any).showEditorTutorial = () => {
			const tour = createEditorTour();
			tour.drive();
		};

		return () => {
			window.removeEventListener('keydown', handleKeyPress);
			delete (window as any).showEditorTutorial;
		};
	});

	async function loadAllProjects() {
		try {
			allProjects = await fetchProjects();
			// Set current project from the loaded projects
			currentProject = allProjects.find(p => p.id === projectId) || null;
		} catch (error) {
			console.error('Error loading projects:', error);
		}
	}

	async function loadFiles() {
		if (!projectId) return;

		try {
			console.log('Loading files for project:', projectId);
			const response = await fetch(resolvePath(`/api/projects/${projectId}/files`));
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
			const response = await fetch(resolvePath(`/api/projects/${projectId}/file?path=${encodeURIComponent(filePath)}`));
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

			const response = await fetch(resolvePath(`/api/projects/${projectId}/file`), {
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

	function handleRenameProject() {
		if (!currentProject) return;
		showRenameDialog = true;
	}

	function handleDeleteProject() {
		if (!currentProject) return;
		showDeleteDialog = true;
	}

	async function handlePublishProject() {
		if (!currentProject) return;
		try {
			publishingProjectId = currentProject.id;
			const result = await publishProject(currentProject.id);

			// Update the current project
			currentProject = { ...currentProject, published: true, publishedUrl: result.url };
			// Update in allProjects list too
			allProjects = allProjects.map(p =>
				p.id === currentProject.id ? currentProject : p
			);
		} catch (e) {
			alert(e instanceof Error ? e.message : 'Failed to publish project');
		} finally {
			publishingProjectId = null;
		}
	}

	async function handleUnpublishProject() {
		if (!currentProject) return;
		try {
			publishingProjectId = currentProject.id;
			await unpublishProject(currentProject.id);

			// Update the current project
			currentProject = { ...currentProject, published: false, publishedUrl: undefined };
			// Update in allProjects list too
			allProjects = allProjects.map(p =>
				p.id === currentProject.id ? currentProject : p
			);
		} catch (e) {
			alert(e instanceof Error ? e.message : 'Failed to unpublish project');
		} finally {
			publishingProjectId = null;
		}
	}

	function openPublishedSite(url: string) {
		window.open(url, '_blank');
	}

	async function handleExportProject() {
		if (!currentProject) return;
		try {
			const response = await fetch(resolvePath(`/api/projects/${currentProject.id}/export`), {
				credentials: 'include'
			});

			if (!response.ok) {
				throw new Error('Export failed');
			}

			// Create a blob from the response
			const blob = await response.blob();

			// Create a temporary download link
			const url = window.URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `${currentProject.id}.zip`;
			document.body.appendChild(a);
			a.click();

			// Cleanup
			window.URL.revokeObjectURL(url);
			document.body.removeChild(a);
		} catch (e) {
			alert(e instanceof Error ? e.message : 'Failed to export project');
		}
	}


</script>

<svelte:head>
	<title>{pageTitle}</title>
</svelte:head>

<!-- Dialogs -->
<ProjectDialogs
	bind:showRenameDialog
	bind:showDeleteDialog
	selectedProject={currentProject}
	onRenameOpenChange={(open) => (showRenameDialog = open)}
	onDeleteOpenChange={(open) => (showDeleteDialog = open)}
	onSuccess={loadAllProjects}
/>

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
						<h1 class="logo">Site Studio</h1>
                    <Button variant="ghost" size="sm" href="{base || '/'}">
                        <LayoutDashboard size={18} />
                    </Button>
                </div>
					<div class="project-selectors">
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
											onclick={() => goto(`${base}/editor/${project.id}`)}
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

						<!-- Publish Button - Always visible -->
						{#if currentProject}
							{#if currentProject.published && currentProject.publishedUrl}
								<button
									class="publish-button published"
									onclick={() => openPublishedSite(currentProject.publishedUrl!)}
									title="View published site"
								>
									<Check size={14} class="publish-icon" />
									<span>Published</span>
									<ExternalLink size={12} class="external-icon" />
								</button>
							{:else}
								<button
									class="publish-button"
									onclick={handlePublishProject}
									disabled={publishingProjectId === currentProject.id}
								>
									{#if publishingProjectId === currentProject.id}
										<Loader2 size={14} class="publish-icon spinning" />
										<span>Publishing...</span>
									{:else}
										<Globe size={14} class="publish-icon" />
										<span>Publish</span>
									{/if}
								</button>
							{/if}
						{/if}

						<!-- Project Options Menu -->
						{#if currentProject}
							<DropdownMenu.Root>
								<DropdownMenu.Trigger asChild>
									{#snippet child({ props })}
										<Button
											{...props}
											variant="ghost"
											size="icon-sm"
											class="project-options-button"
										>
											<MoreVertical size={16} />
										</Button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="end">
									{#if currentProject.published && currentProject.publishedUrl}
										<DropdownMenu.Item onclick={() => openPublishedSite(currentProject.publishedUrl!)}>
											<ExternalLink size={14} />
											<span>View Published Site</span>
										</DropdownMenu.Item>
										<DropdownMenu.Item
											onclick={handleUnpublishProject}
											disabled={publishingProjectId === currentProject.id}
										>
											<GlobeLock size={14} />
											<span>{publishingProjectId === currentProject.id ? 'Unpublishing...' : 'Unpublish'}</span>
										</DropdownMenu.Item>
										<DropdownMenu.Separator />
									{/if}
									<DropdownMenu.Item onclick={handleExportProject}>
										<Download size={14} />
										<span>Export as ZIP</span>
									</DropdownMenu.Item>
									<DropdownMenu.Item onclick={handleRenameProject}>
										Rename
									</DropdownMenu.Item>
									<DropdownMenu.Item
										onclick={handleDeleteProject}
										variant="destructive"
									>
										Delete
									</DropdownMenu.Item>
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						{/if}
					</div>
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
	<div class="overlay-container" class:visible={!isCodeCollapsed} class:dragging={isDragging}>
		<Resizable.PaneGroup direction="horizontal" class="overlay-panes">
			<!-- Invisible spacer pane -->
			<Resizable.Pane defaultSize={60} minSize={0} maxSize={100}>
				<div class="spacer"></div>
			</Resizable.Pane>

			<Resizable.Handle withHandle onDraggingChange={handleDragChange} />

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
		background: var(--color-bg-primary);
	}

	:global(.main-layout) {
		height: 100vh;
	}

	/* Panel Toggle Buttons - Open Studio */
	.panel-toggle {
		position: fixed;
		top: 50%;
		transform: translateY(-50%);
		background: var(--color-bg-elevated);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		padding: 0.75rem;
		cursor: pointer;
		z-index: 50;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.2s ease;
		box-shadow: var(--shadow-md);
		color: var(--color-text-secondary);
	}

	.panel-toggle:hover {
		background: var(--color-bg-secondary);
		border-color: var(--color-primary);
		box-shadow: var(--shadow-lg);
		color: var(--color-primary);
	}

	.panel-toggle-left {
		left: 1rem;
	}

	.panel-toggle-right {
		right: 1rem;
	}

	/* Left Chat Sidebar - Open Studio */
	.chat-sidebar {
		display: flex;
		flex-direction: column;
		background: var(--color-bg-secondary);
		height: 100%;
		overflow: hidden;
		border-right: 1px solid var(--color-border);
	}

	.chat-wrapper {
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.chat-header {
		flex-shrink: 0;
		padding: 1.25rem;
		border-bottom: 1px solid var(--color-border);
		background: var(--color-bg-elevated);
	}

	.chat-header .logo {
		font-family: var(--font-display);
		font-size: 1.25rem;
		font-weight: 600;
		color: var(--color-text-primary);
		margin-bottom: 0.5rem;
	}

	.header-top {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1rem;
	}

	.header-top .logo {
		margin-bottom: 0;
	}

	.project-selectors {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}

	.project-selector {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		background: var(--color-bg-primary);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		cursor: pointer;
		flex: 1;
		transition: all 0.15s ease;
	}

	.project-selector:hover {
		background: var(--color-bg-secondary);
		border-color: var(--color-border-hover);
	}

	:global(.project-options-button) {
		flex-shrink: 0;
	}

	/* Publish Button */
	.publish-button {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.4rem 0.75rem;
		font-size: 0.8125rem;
		font-weight: 500;
		font-family: var(--font-sans);
		border-radius: var(--radius-md);
		cursor: pointer;
		transition: all 0.15s ease;
		border: 1px solid transparent;
		background: linear-gradient(135deg, #10b981 0%, #059669 100%);
		color: white;
		box-shadow: 0 1px 2px rgba(16, 185, 129, 0.2);
	}

	.publish-button:hover:not(:disabled) {
		background: linear-gradient(135deg, #059669 0%, #047857 100%);
		box-shadow: 0 2px 4px rgba(16, 185, 129, 0.3);
		transform: translateY(-1px);
	}

	.publish-button:active:not(:disabled) {
		transform: translateY(0);
	}

	.publish-button:disabled {
		opacity: 0.7;
		cursor: not-allowed;
	}

	.publish-button.published {
		background: var(--color-bg-secondary);
		color: var(--color-text-primary);
		border-color: var(--color-border);
		box-shadow: none;
	}

	.publish-button.published:hover {
		background: var(--color-bg-tertiary);
		border-color: var(--color-border-hover);
		transform: none;
	}

	.publish-button.published :global(.publish-icon) {
		color: #10b981;
	}

	.publish-button.published :global(.external-icon) {
		color: var(--color-text-tertiary);
		margin-left: 0.125rem;
	}

	:global(.publish-icon.spinning) {
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		from { transform: rotate(0deg); }
		to { transform: rotate(360deg); }
	}

	.project-name {
		font-size: 0.875rem;
		color: var(--color-text-primary);
		font-family: var(--font-sans);
		flex: 1;
		font-weight: 500;
		text-overflow: ellipsis;
		overflow: hidden;
		white-space: nowrap;
	}

	.chevron {
		color: var(--color-text-tertiary);
	}

	:global(.project-menu .active-project) {
		background: var(--color-primary-light);
		font-weight: 500;
	}

	.current-indicator {
		margin-left: auto;
		color: var(--color-primary);
		font-size: 1rem;
	}

	/* Center Preview Area */
	.preview-area {
		height: 100%;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: var(--color-bg-primary);
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

	.overlay-container.visible :global(.overlay-panes) {
		height: 100vh;
	}

	/* Enable pointer-events on overlay-panes during drag for smooth resize */
	.overlay-container.dragging :global(.overlay-panes) {
		pointer-events: auto !important;
	}

	:global(.overlay-panes [data-slot="resizable-handle"]) {
		pointer-events: auto;
	}

	:global(.overlay-panes [data-pane]:not(:has(.spacer))) {
		pointer-events: auto;
	}

	.spacer {
		height: 100%;
		background: transparent;
		pointer-events: none;
	}

	.code-panel {
		height: 100%;
		background: var(--color-bg-elevated);
		box-shadow: var(--shadow-xl);
		display: flex;
		flex-direction: column;
		position: relative;
		pointer-events: auto;
		border-left: 1px solid var(--color-border);
	}

	.close-editor-button {
		position: absolute;
		top: 0.75rem;
		right: 1rem;
		background: var(--color-bg-secondary);
		border: 1px solid var(--color-border);
		padding: 0.5rem;
		border-radius: var(--radius-md);
		cursor: pointer;
		z-index: 10;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.15s ease;
		color: var(--color-text-secondary);
	}

	.close-editor-button:hover {
		background: var(--color-bg-tertiary);
		border-color: var(--color-primary);
		color: var(--color-primary);
	}
</style>
