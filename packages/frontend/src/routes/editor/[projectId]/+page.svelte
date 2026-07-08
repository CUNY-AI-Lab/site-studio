<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { resolvePath } from '$lib/utils/paths';
	import { createAutosave, type SaveSnapshot } from '$lib/editor/autosave';
	import Preview from '$lib/components/Preview.svelte';
	import AgentChat from '$lib/components/AgentChat.svelte';
	import CodeView from '$lib/components/CodeView.svelte';
	import * as Resizable from '$lib/components/ui/resizable';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import Button from '$lib/components/ui/button/button.svelte';
    import { ChevronDown, LayoutDashboard, Code2, PanelLeftClose, PanelRightClose, MoreVertical, Globe, GlobeLock, ExternalLink, Download, Check, Loader2, RotateCcw, Image as ImageIcon } from 'lucide-svelte';
	import { downloadFile as downloadProjectFile, fetchProjects, publishProject, unpublishProject, type A11yFinding, type Project, type ProjectFile } from '$lib/api/projects';
	import { csrfFetch } from '$lib/api/csrf';
	import { apiFetch, apiResponseFetch } from '$lib/api/errors';
	import ProjectDialogs from '$lib/components/ProjectDialogs.svelte';
	import ProjectHistoryDialog from '$lib/components/ProjectHistoryDialog.svelte';
	import AccessibilityNotesDialog from '$lib/components/AccessibilityNotesDialog.svelte';
	import ImageManagerDialog from '$lib/components/ImageManagerDialog.svelte';
	import HandleClaimDialog from '$lib/components/HandleClaimDialog.svelte';
	import { toast } from '$lib/toast.svelte';
	import { Pane } from 'paneforge';

	type OnboardingModule = typeof import('$lib/utils/onboarding');

	let previewComponent: Preview;
	let chatComponent: AgentChat;
	let chatPane: ReturnType<typeof Pane>;
	let projectLoadVersion = 0;
	let previousProjectId = $state<string | null>(null);
	let stableProjectId = $state<string | null>(null);
	let onboardingModulePromise: Promise<OnboardingModule> | null = null;

	// Get projectId from URL params
	let projectId = $derived($page.params.projectId ?? '');
	let currentFile = $state('');
	let fileContent = $state('');
	let currentFileIsText = $state(true);
	let currentFileContentType = $state('');
	let files = $state<ProjectFile[]>([]);
	let allProjects = $state<Project[]>([]);
	let currentProject = $state<Project | null>(null);

	// Reactive page title based on current project
	let pageTitle = $derived(currentProject ? `${currentProject.name} - Site Studio` : 'Editor - Site Studio');

	// Panel collapse state
	let isChatCollapsed = $state(false);
	let isCodeCollapsed = $state(true); // Start collapsed
	let hasAutoCollapsed = false;
	let isDragging = $state(false);

	// Dialog states
	let showRenameDialog = $state(false);
	let showDeleteDialog = $state(false);
	let showHistoryDialog = $state(false);
	let publishingProjectId = $state<string | null>(null);

	// Accessibility findings surfaced after a successful publish
	let a11yFindings = $state<A11yFinding[]>([]);
	let showA11yDialog = $state(false);

	// Handle-claim dialog, shown when publishing requires a public handle
	let showHandleDialog = $state(false);

	// Images dialog: upload photos, replace placeholders, hand insertion to chat
	let showImagesDialog = $state(false);

	function handleDragChange(dragging: boolean) {
		isDragging = dragging;
	}

	async function loadOnboardingModule(): Promise<OnboardingModule> {
		if (!onboardingModulePromise) {
			onboardingModulePromise = Promise.all([
				import('$lib/utils/onboarding'),
				import('driver.js/dist/driver.css'),
				import('$lib/styles/onboarding-tour.css')
			]).then(([module]) => module);
		}

		return onboardingModulePromise;
	}

	async function maybeStartEditorTour(force = false) {
		const onboarding = await loadOnboardingModule();
		if (!force && onboarding.hasCompletedOnboarding()) {
			return;
		}

		onboarding.createEditorTour().drive();
	}

	onMount(() => {
		// Auto-collapse chat on small screens so preview gets full width
		if (!hasAutoCollapsed && window.innerWidth < 768 && chatPane) {
			hasAutoCollapsed = true;
			chatPane.collapse();
		}

		// Show onboarding tour for first-time users after the editor layout settles.
		setTimeout(() => {
			void maybeStartEditorTour();
		}, 1000);

		// Add keyboard shortcut to force tutorial (Ctrl+Shift+H or Cmd+Shift+H for Help)
		const handleKeyPress = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'H') {
				e.preventDefault();
				void maybeStartEditorTour(true);
			}
		};
		window.addEventListener('keydown', handleKeyPress);

		// Expose function to force tutorial from console
		(window as any).showEditorTutorial = async () => {
			await maybeStartEditorTour(true);
		};

		return () => {
			window.removeEventListener('keydown', handleKeyPress);
			delete (window as any).showEditorTutorial;
		};
	});

	async function loadAllProjects() {
		try {
			return await fetchProjects();
		} catch (error) {
			console.error('Error loading projects:', error);
			return [];
		}
	}

	async function loadFiles(targetProjectId = projectId): Promise<ProjectFile[]> {
		if (!targetProjectId) return [];

		try {
			const data = await apiFetch<{ files: ProjectFile[] }>(
				resolvePath(`/api/projects/${targetProjectId}/files`),
				{
				credentials: 'include'
				}
			);

			return data.files;
		} catch (error) {
			console.error('Error loading files:', error);
			return [];
		}
	}

	function findFileByPath(nodes: ProjectFile[], filePath: string): ProjectFile | null {
		for (const node of nodes) {
			if (node.type === 'file' && node.path === filePath) {
				return node;
			}
			if (node.type === 'directory' && node.children) {
				const nested = findFileByPath(node.children, filePath);
				if (nested) {
					return nested;
				}
			}
		}

		return null;
	}

	function inferIsTextFile(filePath: string): boolean {
		return /\.(html?|css|js|json|xml|txt|md|csv)$/i.test(filePath);
	}

	let fileSelectCounter = 0;

	async function onFileSelect(filePath: string) {
		if (!projectId) return;
		const didFlushPendingSave = await flushPendingSave();
		if (!didFlushPendingSave) return;

		const requestId = ++fileSelectCounter;
		const selectedFile = findFileByPath(files, filePath);
		const nextIsText = selectedFile?.isText ?? inferIsTextFile(filePath);

		currentFile = filePath;
		currentFileIsText = nextIsText;
		currentFileContentType = selectedFile?.contentType || '';

		if (!nextIsText) {
			fileContent = '';
			return;
		}

		try {
			const response = await apiResponseFetch(
				resolvePath(`/api/projects/${projectId}/file?path=${encodeURIComponent(filePath)}`),
				{
					credentials: 'include'
				}
			);
			if (response.status === 415) {
				currentFileIsText = false;
				fileContent = '';
				return;
			}
			if (!response.ok) throw new Error('Failed to load file');

			// Ignore stale response if user selected a different file
			if (requestId !== fileSelectCounter) return;

			const data = await response.json();
			currentFileContentType = data.contentType || selectedFile?.contentType || '';
			currentFileIsText = data.isText ?? true;
			fileContent = data.content;
		} catch (error) {
			console.error('Error loading file:', error);
		}
	}

	let isSaving = $state(false);

	function getCurrentSaveSnapshot(): SaveSnapshot | null {
		if (!projectId || !currentFile || !currentFileIsText) return null;

		return {
			projectId,
			filePath: currentFile,
			content: fileContent
		};
	}

	async function persistFile(snapshot: SaveSnapshot): Promise<boolean> {
		const { projectId: targetProjectId, filePath, content } = snapshot;

		try {
			const response = await csrfFetch(resolvePath(`/api/projects/${targetProjectId}/file`), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					path: filePath,
					content
				})
			});

			if (!response.ok) throw new Error('Failed to save file');

			// Refresh preview after save
			if (
				previewComponent &&
				targetProjectId === projectId &&
				filePath === currentFile &&
				content === fileContent
			) {
				previewComponent.refresh();
			}
			return true;
		} catch (error) {
			console.error('Error saving file:', error);
			toast.error('Failed to save file. Your latest changes were not saved.');
			return false;
		}
	}

	const autosave = createAutosave({
		persist: persistFile,
		onSavingChange: (saving) => {
			isSaving = saving;
		}
	});

	async function flushPendingSave(): Promise<boolean> {
		return autosave.flush();
	}

	function onEditorChange(content: string) {
		fileContent = content;
		const snapshot = getCurrentSaveSnapshot();
		if (!snapshot) return;

		autosave.queue(snapshot);
	}

	$effect(() => {
		return () => {
			autosave.dispose();
		};
	});

	async function refreshProjectState(targetProjectId: string) {
		const loadVersion = ++projectLoadVersion;
		const [loadedFiles, loadedProjects] = await Promise.all([
			loadFiles(targetProjectId),
			loadAllProjects()
		]);

		if (loadVersion !== projectLoadVersion || targetProjectId !== projectId) {
			return;
		}

		files = loadedFiles;
		allProjects = loadedProjects;
		currentProject = loadedProjects.find((project) => project.id === targetProjectId) || null;
		stableProjectId = targetProjectId;
	}

	async function navigateToProject(targetProjectId: string) {
		if (!targetProjectId || targetProjectId === projectId) return;

		const didFlushPendingSave = await flushPendingSave();
		if (!didFlushPendingSave) return;

		await goto(`${base}/editor/${targetProjectId}`);
	}

	async function handleProjectChange(targetProjectId: string, fallbackProjectId: string | null) {
		const didFlushPendingSave = await flushPendingSave();
		if (!didFlushPendingSave) {
			if (fallbackProjectId && fallbackProjectId !== targetProjectId) {
				await goto(`${base}/editor/${fallbackProjectId}`, { replaceState: true });
			}
			return;
		}

		currentFile = '';
		fileContent = '';
		currentFileIsText = true;
		currentFileContentType = '';
		files = [];
		currentProject = null;

		await refreshProjectState(targetProjectId);
	}

	$effect(() => {
		if (!projectId || projectId === previousProjectId) return;
		const fallbackProjectId = stableProjectId;
		previousProjectId = projectId;

		void handleProjectChange(projectId, fallbackProjectId);
	});

	async function onAgentUpdate() {
		// Reload files when agent makes changes
		files = await loadFiles(projectId);

		// Reload current file if it's open
		if (currentFile) {
			await onFileSelect(currentFile);
		}

		// Refresh preview to show agent's changes
		if (previewComponent) {
			previewComponent.refresh();
		}
	}

	async function handleCurrentFileDownload(filePath: string) {
		if (!projectId || !filePath) return;
		await downloadProjectFile(projectId, filePath);
	}

	function toggleChatPane() {
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

	function handleOpenHistory() {
		if (!currentProject) return;
		showHistoryDialog = true;
	}

	async function handleRenameSuccess(renamedProject: Project) {
		allProjects = await loadAllProjects();
		currentProject = renamedProject;
		stableProjectId = renamedProject.id;

		if (renamedProject.id !== projectId) {
			await goto(`${base}/editor/${renamedProject.id}`, { replaceState: true });
		}
	}

	async function handleDeleteSuccess(deletedProjectId: string) {
		const remainingProjects = await loadAllProjects();
		allProjects = remainingProjects;

		if (deletedProjectId !== projectId) {
			return;
		}

		currentProject = null;
		currentFile = '';
		fileContent = '';
		currentFileIsText = true;
		currentFileContentType = '';
		files = [];
		stableProjectId = null;

		if (remainingProjects.length > 0) {
			await goto(`${base}/editor/${remainingProjects[0].id}`, { replaceState: true });
			return;
		}

		await goto(base || '/', { replaceState: true });
	}

	async function handlePublishProject() {
		if (!currentProject) return;
		try {
			publishingProjectId = currentProject.id;
			const result = await publishProject(currentProject.id);

			if (!result.ok) {
				// The user has no public handle yet — collect one, then retry the
				// publish automatically once it's claimed.
				if (result.reason === 'handle_required') {
					showHandleDialog = true;
				}
				return;
			}

			applyPublishResult(result.url, result.a11yFindings ?? []);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to publish project.');
		} finally {
			publishingProjectId = null;
		}
	}

	function applyPublishResult(url: string, findings: A11yFinding[]) {
		if (!currentProject) return;
		const updated = { ...currentProject, published: true, publishedUrl: url };
		currentProject = updated;
		allProjects = allProjects.map((p) => (p.id === updated.id ? updated : p));

		if (findings.length > 0) {
			a11yFindings = findings;
			showA11yDialog = true;
			toast.success('Site published. A few accessibility notes are ready for you.');
		} else {
			a11yFindings = [];
			toast.success('Site published. It is now live.');
		}
	}

	async function handleClaimed(_handle: string) {
		// Handle claimed — close the dialog and complete the original publish.
		showHandleDialog = false;
		if (!currentProject) return;
		try {
			publishingProjectId = currentProject.id;
			const result = await publishProject(currentProject.id);
			if (result.ok) {
				applyPublishResult(result.url, result.a11yFindings ?? []);
			} else {
				toast.error('Publishing failed after claiming your handle. Please try again.');
			}
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to publish project.');
		} finally {
			publishingProjectId = null;
		}
	}

	function askAssistantToFixA11y() {
		showA11yDialog = false;
		// Make sure the chat is visible, then hand the request to the agent.
		if (isChatCollapsed && chatPane) {
			chatPane.expand();
		}
		void chatComponent?.sendPrompt(
			'Run project.audit_accessibility and fix the issues it reports.'
		);
	}

	function askAssistantToPlaceImage(prompt: string) {
		// Make sure the chat is visible, then hand the request to the agent
		// (same pattern as the accessibility "ask the assistant" flow).
		if (isChatCollapsed && chatPane) {
			chatPane.expand();
		}
		void chatComponent?.sendPrompt(prompt);
	}

	async function handleUnpublishProject() {
		if (!currentProject) return;
		try {
			publishingProjectId = currentProject.id;
			await unpublishProject(currentProject.id);

			// Update the current project
			const updated = { ...currentProject, published: false, publishedUrl: undefined };
			currentProject = updated;
			// Update in allProjects list too
			allProjects = allProjects.map(p =>
				p.id === updated.id ? updated : p
			);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to unpublish project.');
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
			const response = await apiResponseFetch(resolvePath(`/api/projects/${currentProject.id}/export`), {
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
			toast.error(e instanceof Error ? e.message : 'Failed to export project.');
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
	onBeforeRename={flushPendingSave}
	onBeforeDelete={flushPendingSave}
	onRenameSuccess={handleRenameSuccess}
	onDeleteSuccess={handleDeleteSuccess}
/>

<ProjectHistoryDialog
	open={showHistoryDialog}
	projectId={projectId}
	projectName={currentProject?.name}
	onOpenChange={(open) => (showHistoryDialog = open)}
	onBeforeCreateSnapshot={flushPendingSave}
	onBeforeRestore={flushPendingSave}
	onRestoreSuccess={onAgentUpdate}
/>

<AccessibilityNotesDialog
	open={showA11yDialog}
	findings={a11yFindings}
	onOpenChange={(open) => (showA11yDialog = open)}
	onAskAssistant={askAssistantToFixA11y}
/>

<ImageManagerDialog
	open={showImagesDialog}
	{projectId}
	onOpenChange={(open) => (showImagesDialog = open)}
	onAskAssistant={askAssistantToPlaceImage}
/>

<HandleClaimDialog
	open={showHandleDialog}
	onOpenChange={(open) => (showHandleDialog = open)}
	onClaimed={handleClaimed}
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
			defaultSize={30}
			minSize={22}
			maxSize={45}
			collapsible={true}
			onCollapse={() => (isChatCollapsed = true)}
			onExpand={() => (isChatCollapsed = false)}
		>
			<aside class="chat-sidebar">
				<div class="chat-header">
					<div class="header-top">
						<a href={base || '/'} class="logo">Site Studio</a>
	                    <Button variant="ghost" size="sm" href={base || '/'}>
                        <LayoutDashboard size={18} />
                    </Button>
                </div>
					<div class="project-selectors">
						<DropdownMenu.Root>
							<DropdownMenu.Trigger>
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
											onclick={() => navigateToProject(project.id)}
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

						<!-- Images Button -->
						{#if currentProject}
							<button
								class="images-button"
								onclick={() => (showImagesDialog = true)}
								title="Manage images"
							>
								<ImageIcon size={14} />
								<span>Images</span>
							</button>
						{/if}

						<!-- Publish Button - Always visible -->
						{#if currentProject}
							{#if currentProject.published && currentProject.publishedUrl}
								<button
									class="publish-button published"
									onclick={() => openPublishedSite(currentProject!.publishedUrl!)}
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
								<DropdownMenu.Trigger>
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
										<DropdownMenu.Item onclick={() => openPublishedSite(currentProject!.publishedUrl!)}>
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
									<DropdownMenu.Item onclick={handleOpenHistory}>
										<RotateCcw size={14} />
										<span>Version History</span>
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
					<AgentChat bind:this={chatComponent} {projectId} onUpdate={onAgentUpdate} onBeforeSend={flushPendingSave} />
				</div>
			</aside>
		</Resizable.Pane>

		<Resizable.Handle withHandle />

		<!-- Center: Preview (always visible) -->
		<Resizable.Pane defaultSize={70} minSize={30}>
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
						{currentFileIsText}
						{currentFileContentType}
						{isSaving}
						onFileSelect={onFileSelect}
						onEditorChange={onEditorChange}
						onDownloadFile={handleCurrentFileDownload}
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
		min-width: 280px;
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
		padding: 0.875rem 1rem;
		border-bottom: 1px solid var(--color-border);
		background: var(--color-bg-elevated);
	}

	.chat-header .logo {
		font-family: var(--font-display);
		font-size: 1.25rem;
		font-weight: 600;
		color: var(--color-text-primary);
		text-decoration: none;
		margin-bottom: 0.5rem;
	}

	.header-top {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.625rem;
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

	/* Images Button */
	.images-button {
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
		border: 1px solid var(--color-border);
		background: var(--color-bg-secondary);
		color: var(--color-text-primary);
	}

	.images-button:hover {
		background: var(--color-bg-tertiary);
		border-color: var(--color-border-hover);
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

	.code-loading {
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1.5rem;
		color: var(--color-text-secondary);
		font-size: 0.9375rem;
		background: var(--color-bg-primary);
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

	/* Responsive: tablet and below */
	@media (max-width: 768px) {
		.chat-sidebar {
			min-width: 0;
		}

		.chat-header {
			padding: 0.625rem 0.75rem;
		}

		.header-top {
			margin-bottom: 0.375rem;
		}

		.chat-header .logo {
			font-size: 1rem;
		}

		.project-selectors {
			gap: 0.25rem;
		}

		.project-selector {
			padding: 0.375rem 0.5rem;
			font-size: 0.8125rem;
		}

		.publish-button {
			padding: 0.375rem 0.625rem;
			font-size: 0.75rem;
		}
	}

	/* Responsive: mobile */
	@media (max-width: 480px) {
		.chat-sidebar {
			min-width: 0;
		}

		.publish-button span {
			display: none;
		}

		.publish-button {
			padding: 0.375rem;
		}

		.images-button span {
			display: none;
		}

		.images-button {
			padding: 0.375rem;
		}
	}
</style>
