<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { resolvePath } from '$lib/utils/paths';
	import { fetchProjects, publishProject, unpublishProject, type Project } from '$lib/api/projects';
	import { getErrorMessage, isApiError } from '$lib/api/errors';
	import Button from '$lib/components/ui/button/button.svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { MoreVertical, Plus, FolderOpen, Globe, GlobeLock, ExternalLink } from 'lucide-svelte';
	import NewProjectDialog from './NewProjectDialog.svelte';
	import ProjectDialogs from './ProjectDialogs.svelte';
	import HandleClaimDialog from './HandleClaimDialog.svelte';
	import { hasCompletedOnboarding, createDashboardTour } from '$lib/utils/onboarding';
	import { toast } from '$lib/toast.svelte';
	import type { Driver } from 'driver.js';
	import 'driver.js/dist/driver.css';
	import '$lib/styles/onboarding-tour.css';

	let projects = $state<Project[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let errorRecovery = $state<'request-access' | 'retry' | null>(null);
	let publishingProjectId = $state<string | null>(null);
	let loadVersion = 0;

	let showNewProjectDialog = $state(false);
	let showRenameDialog = $state(false);
	let showDeleteDialog = $state(false);
	let selectedProject = $state<Project | null>(null);

	// Handle-claim dialog, shown when publishing requires a public handle. The
	// project whose publish triggered it, so we can retry after claiming.
	let showHandleDialog = $state(false);
	let pendingPublishProject = $state<Project | null>(null);
	let dashboardTourTimer: ReturnType<typeof setTimeout> | null = null;
	let dashboardTour: Driver | null = null;
	let dashboardMounted = false;

	onMount(() => {
		dashboardMounted = true;
		const initialLoadVersion = loadVersion + 1;
		void loadProjects().then(() => {
			// Show onboarding tour for first-time users with no projects
			if (
				dashboardMounted &&
				initialLoadVersion === loadVersion &&
				!loading &&
				!error &&
				projects.length === 0 &&
				!hasCompletedOnboarding()
			) {
				dashboardTourTimer = setTimeout(() => {
					dashboardTourTimer = null;
					if (
						!dashboardMounted ||
						initialLoadVersion !== loadVersion ||
						loading ||
						error ||
						projects.length > 0 ||
						hasCompletedOnboarding()
					) {
						return;
					}
					dashboardTour?.destroy();
					dashboardTour = createDashboardTour();
					dashboardTour.drive();
				}, 500);
			}
		});

		// Add keyboard shortcut to force tutorial (Ctrl+Shift+H or Cmd+Shift+H for Help)
		const handleKeyPress = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'H') {
				e.preventDefault();
				dashboardTour?.destroy();
				dashboardTour = createDashboardTour();
				dashboardTour.drive();
			}
		};
		window.addEventListener('keydown', handleKeyPress);

		// Expose function to force tutorial from console
		window.showTutorial = () => {
			dashboardTour?.destroy();
			dashboardTour = createDashboardTour();
			dashboardTour.drive();
		};

		return () => {
			dashboardMounted = false;
			if (dashboardTourTimer !== null) {
				clearTimeout(dashboardTourTimer);
				dashboardTourTimer = null;
			}
			dashboardTour?.destroy();
			dashboardTour = null;
			window.removeEventListener('keydown', handleKeyPress);
			delete window.showTutorial;
		};
	});

	async function loadProjects() {
		const version = ++loadVersion;
		try {
			loading = true;
			error = null;
			errorRecovery = null;
			const loadedProjects = await fetchProjects();
			if (version !== loadVersion) return;
			projects = loadedProjects;
		} catch (e) {
			if (version !== loadVersion) return;
			const caught = e instanceof Error ? e : undefined;
			error = isApiError(caught)
				? getErrorMessage(caught)
				: "We couldn't load your projects. Check your connection and try again.";
			if (isApiError(caught)) {
				const action = caught.getRecoveryAction();
				errorRecovery = action === 'request-access' || action === 'retry' ? action : null;
			}
			console.error('Error loading projects:', e);
		} finally {
			if (version === loadVersion) loading = false;
		}
	}

	function openProject(projectId: string) {
		goto(`${base}/editor/${projectId}`);
	}

	function handleNewProject() {
		showNewProjectDialog = true;
	}

	function handleRenameProject(project: Project) {
		selectedProject = project;
		showRenameDialog = true;
	}

	function handleDeleteProject(project: Project) {
		selectedProject = project;
		showDeleteDialog = true;
	}

	async function handlePublishProject(project: Project) {
		try {
			publishingProjectId = project.id;
			const result = await publishProject(project.id);

			if (!result.ok) {
				// No public handle yet — collect one, then retry this publish.
				if (result.reason === 'handle_required') {
					pendingPublishProject = project;
					showHandleDialog = true;
				}
				return;
			}

			// Update the project in the list
			projects = projects.map(p =>
				p.id === project.id
					? { ...p, published: true, publishedUrl: result.url }
					: p
			);
			toast.success('Site published. It is now live.');
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to publish project.');
		} finally {
			publishingProjectId = null;
		}
	}

	async function handleHandleClaimed(_handle: string) {
		showHandleDialog = false;
		const project = pendingPublishProject;
		pendingPublishProject = null;
		if (project) {
			await handlePublishProject(project);
		}
	}

	async function handleUnpublishProject(project: Project) {
		if (!window.confirm(`Make "${project.name}" private? Its public URL will stop working.`)) return;
		try {
			publishingProjectId = project.id;
			await unpublishProject(project.id);

			// Update the project in the list
			projects = projects.map(p =>
				p.id === project.id
					? { ...p, published: false, publishedUrl: undefined }
					: p
			);
			toast.success('Site is private. Its public URL no longer works.');
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't make the site private.");
		} finally {
			publishingProjectId = null;
		}
	}

	function openPublishedSite(url: string) {
		window.open(url, '_blank');
	}
</script>

<!-- Dialogs -->
<HandleClaimDialog
	open={showHandleDialog}
	onOpenChange={(open) => {
		showHandleDialog = open;
		if (!open) pendingPublishProject = null;
	}}
	onClaimed={handleHandleClaimed}
/>

<NewProjectDialog
	bind:open={showNewProjectDialog}
	onOpenChange={(open) => (showNewProjectDialog = open)}
	onSuccess={loadProjects}
/>

<ProjectDialogs
	bind:showRenameDialog
	bind:showDeleteDialog
	{selectedProject}
	onRenameOpenChange={(open) => (showRenameDialog = open)}
	onDeleteOpenChange={(open) => (showDeleteDialog = open)}
	onRenameSuccess={loadProjects}
	onDeleteSuccess={loadProjects}
/>

<main class="project-dashboard">
	<div class="dashboard-header">
		<div>
			<h1 class="dashboard-title">Site Studio</h1>
		</div>
		<Button onclick={handleNewProject} data-tour="new-project">
			<Plus size={18} />
			New Project
		</Button>
	</div>

	{#if loading}
		<div class="loading-state" role="status" aria-live="polite">
			<p>Loading projects...</p>
		</div>
	{:else if error}
		<div class="error-state" role="alert">
			<p>{error}</p>
			<div class="error-actions">
				{#if errorRecovery === 'request-access'}
					<a class="request-access-link" href="https://ailab.gc.cuny.edu/request-access">Request access</a>
				{:else}
					<Button onclick={loadProjects}>Retry</Button>
				{/if}
				{#if errorRecovery === 'request-access'}
					<Button variant="outline" onclick={loadProjects}>Retry</Button>
				{/if}
			</div>
		</div>
	{:else if projects.length === 0}
		<div class="empty-state">
			<FolderOpen size={48} />
			<h2>No projects yet</h2>
			<Button onclick={handleNewProject} data-tour="new-project">
				<Plus size={20} />
				Create Project
			</Button>
		</div>
	{:else}
		<div class="projects-grid">
			{#each projects as project (project.id)}
				<div class="project-card">
					<button
						class="project-card-button"
						onclick={() => openProject(project.id)}
						aria-label={`Open ${project.name}`}
					>
						{#if project.thumbnailUrl}
							<div class="project-thumbnail">
								<img src={resolvePath(project.thumbnailUrl)} alt={project.name} />
							</div>
						{:else}
							<div class="project-icon">🎨</div>
						{/if}
					</button>
					<div class="project-info">
						<div class="project-header">
							<h3 class="project-name">{project.name}</h3>
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Button
											{...props}
											variant="ghost"
											size="icon-sm"
											class="project-menu-button"
											onclick={(e: MouseEvent) => e.stopPropagation()}
											aria-label={`Project actions for ${project.name}`}
										>
											<MoreVertical size={16} />
										</Button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content>
							<DropdownMenu.Item onclick={() => openProject(project.id)}>Open</DropdownMenu.Item>
							{#if project.published && project.publishedUrl}
								<DropdownMenu.Item onclick={() => openPublishedSite(project.publishedUrl!)}>
									<ExternalLink size={14} />
									<span>View Published Site</span>
								</DropdownMenu.Item>
								<DropdownMenu.Item
									onclick={() => handleUnpublishProject(project)}
									disabled={publishingProjectId === project.id}
								>
									<GlobeLock size={14} />
									<span>{publishingProjectId === project.id ? 'Making private...' : 'Make site private'}</span>
								</DropdownMenu.Item>
							{:else}
								<DropdownMenu.Item
									onclick={() => handlePublishProject(project)}
									disabled={publishingProjectId === project.id}
								>
									<Globe size={14} />
									<span>{publishingProjectId === project.id ? 'Publishing...' : 'Publish'}</span>
								</DropdownMenu.Item>
							{/if}
							<DropdownMenu.Separator />
							<DropdownMenu.Item onclick={() => handleRenameProject(project)}>
								Rename
							</DropdownMenu.Item>
							<DropdownMenu.Item
								onclick={() => handleDeleteProject(project)}
								class="text-destructive"
							>
								Delete
							</DropdownMenu.Item>
						</DropdownMenu.Content>
							</DropdownMenu.Root>
						</div>
						{#if project.published}
							<div class="published-badge">
								<Globe size={14} />
								<span>Published</span>
							</div>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</main>

<style>
	.project-dashboard {
		min-height: 100vh;
		background: var(--color-bg-primary);
		padding: 2.5rem 2rem 3rem;
	}

	.dashboard-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		margin-bottom: 2.5rem;
		padding-bottom: 1.5rem;
		border-bottom: 1px solid var(--color-border);
		max-width: 1400px;
		margin-left: auto;
		margin-right: auto;
	}

	.dashboard-title {
		font-family: var(--font-display);
		font-size: 2.5rem;
		font-weight: 600;
		color: var(--color-text-primary);
		margin: 0 0 0.375rem 0;
		line-height: 1.2;
		letter-spacing: -0.01em;
	}

	.loading-state,
	.error-state,
	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1.25rem;
		padding: 5rem 2rem;
		text-align: center;
		max-width: 400px;
		margin: 0 auto;
	}

	.error-actions {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		flex-wrap: wrap;
	}

	.request-access-link {
		padding: 0.5rem 0.875rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		color: var(--color-primary);
		font-weight: 500;
		text-decoration: none;
	}

	.request-access-link:hover {
		background: var(--color-bg-secondary);
	}

	.empty-state {
		color: var(--color-text-tertiary);
	}

	.empty-state :global(svg) {
		color: var(--color-primary);
		opacity: 0.6;
	}

	.empty-state h2 {
		font-family: var(--font-display);
		font-size: 1.5rem;
		font-weight: 600;
		color: var(--color-text-primary);
		margin: 0;
	}

	.projects-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		gap: 1.5rem;
		max-width: 1400px;
		margin: 0 auto;
	}

	.project-card {
		position: relative;
		background: var(--color-bg-elevated);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		overflow: hidden;
		transition: all 0.2s ease;
		box-shadow: var(--shadow-sm);
	}

	.project-card:hover {
		border-color: var(--color-border-hover);
		box-shadow: var(--shadow-lg);
		transform: translateY(-3px);
	}

	.project-card-button {
		width: 100%;
		padding: 0;
		background: none;
		border: none;
		cursor: pointer;
		text-align: center;
		display: flex;
		flex-direction: column;
		align-items: stretch;
		border-radius: var(--radius-lg) var(--radius-lg) 0 0;
	}

	.project-icon {
		font-size: 3.5rem;
		padding: 2.5rem 1.5rem;
		display: flex;
		justify-content: center;
		align-items: center;
		height: 180px;
		background: linear-gradient(160deg, var(--color-bg-secondary) 0%, var(--color-bg-tertiary) 100%);
		position: relative;
	}

	.project-thumbnail {
		width: 100%;
		height: 180px;
		overflow: hidden;
		background: var(--color-bg-secondary);
		position: relative;
	}

	.project-thumbnail img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
		transition: transform 0.3s ease;
	}

	.project-card:hover .project-thumbnail img {
		transform: scale(1.03);
	}

	.project-info {
		padding: 1.125rem 1.25rem;
		background: var(--color-bg-elevated);
	}

	.project-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.project-name {
		font-family: var(--font-sans);
		font-size: 1rem;
		font-weight: 600;
		color: var(--color-text-primary);
		margin: 0;
		word-break: break-word;
		flex: 1;
		line-height: 1.4;
		text-align: left;
	}

	.project-card :global(.project-menu-button) {
		flex-shrink: 0;
		opacity: 0.6;
		transition: opacity 0.15s ease;
	}

	.project-card:hover :global(.project-menu-button) {
		opacity: 1;
	}

	.published-badge {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.25rem 0.625rem;
		background: var(--color-primary-light);
		color: var(--color-primary);
		border: none;
		border-radius: var(--radius-full);
		font-size: 0.6875rem;
		font-weight: 600;
		font-family: var(--font-sans);
		text-transform: uppercase;
		letter-spacing: 0.03em;
		margin-top: 0.625rem;
		width: fit-content;
	}
</style>
