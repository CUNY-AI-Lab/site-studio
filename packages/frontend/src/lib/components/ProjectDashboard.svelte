<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { resolvePath } from '$lib/utils/paths';
	import { fetchProjects, publishProject, unpublishProject, type Project } from '$lib/api/projects';
	import Button from '$lib/components/ui/button/button.svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { MoreVertical, Plus, FolderOpen, Globe, GlobeLock, ExternalLink } from 'lucide-svelte';
	import NewProjectDialog from './NewProjectDialog.svelte';
	import ProjectDialogs from './ProjectDialogs.svelte';
	import { hasCompletedOnboarding, createDashboardTour } from '$lib/utils/onboarding';
	import 'driver.js/dist/driver.css';
	import '$lib/styles/onboarding-tour.css';

	let projects = $state<Project[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let publishingProjectId = $state<string | null>(null);

	let showNewProjectDialog = $state(false);
	let showRenameDialog = $state(false);
	let showDeleteDialog = $state(false);
	let selectedProject = $state<Project | null>(null);

	onMount(async () => {
		await loadProjects();

		// Show onboarding tour for first-time users with no projects
		if (!loading && projects.length === 0 && !hasCompletedOnboarding()) {
			// Small delay to ensure DOM is ready
			setTimeout(() => {
				const tour = createDashboardTour();
				tour.drive();
			}, 500);
		}

		// Add keyboard shortcut to force tutorial (Ctrl+Shift+H or Cmd+Shift+H for Help)
		const handleKeyPress = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'H') {
				e.preventDefault();
				const tour = createDashboardTour();
				tour.drive();
			}
		};
		window.addEventListener('keydown', handleKeyPress);

		// Expose function to force tutorial from console
		(window as any).showTutorial = () => {
			const tour = createDashboardTour();
			tour.drive();
		};

		return () => {
			window.removeEventListener('keydown', handleKeyPress);
			delete (window as any).showTutorial;
		};
	});

	async function loadProjects() {
		try {
			loading = true;
			error = null;
			projects = await fetchProjects();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load projects';
			console.error('Error loading projects:', e);
		} finally {
			loading = false;
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

			// Update the project in the list
			projects = projects.map(p =>
				p.id === project.id
					? { ...p, published: true, publishedUrl: result.url }
					: p
			);
		} catch (e) {
			alert(e instanceof Error ? e.message : 'Failed to publish project');
		} finally {
			publishingProjectId = null;
		}
	}

	async function handleUnpublishProject(project: Project) {
		try {
			publishingProjectId = project.id;
			await unpublishProject(project.id);

			// Update the project in the list
			projects = projects.map(p =>
				p.id === project.id
					? { ...p, published: false, publishedUrl: undefined }
					: p
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
</script>

<!-- Dialogs -->
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
	onSuccess={loadProjects}
/>

<div class="project-dashboard">
	<div class="dashboard-header">
		<div>
			<h1 class="dashboard-title">🎨 Site Studio</h1>
			<p class="dashboard-subtitle">Build websites with AI assistance</p>
		</div>
		<Button onclick={handleNewProject}>
			<Plus size={20} />
			New Project
		</Button>
	</div>

	{#if loading}
		<div class="loading-state">
			<p>Loading projects...</p>
		</div>
	{:else if error}
		<div class="error-state">
			<p>Error: {error}</p>
			<Button onclick={loadProjects}>Retry</Button>
		</div>
	{:else if projects.length === 0}
		<div class="empty-state">
			<FolderOpen size={48} />
			<h2>No projects yet</h2>
			<p>Create your first project to get started</p>
			<Button onclick={handleNewProject}>
				<Plus size={20} />
				Create Project
			</Button>
		</div>
	{:else}
		<div class="projects-grid">
			{#each projects as project (project.id)}
				<div class="project-card">
					<button class="project-card-button" onclick={() => openProject(project.id)}>
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
								<DropdownMenu.Trigger asChild>
									{#snippet child({ props })}
										<Button
											{...props}
											variant="ghost"
											size="icon-sm"
											class="project-menu-button"
											onclick={(e) => e.stopPropagation()}
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
									<span>{publishingProjectId === project.id ? 'Unpublishing...' : 'Unpublish'}</span>
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
</div>

<style>
	.project-dashboard {
		min-height: 100vh;
		background: hsl(var(--background));
		padding: 3rem 2rem 2rem;
	}

	.dashboard-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		margin-bottom: 3rem;
		padding-bottom: 1.5rem;
		border-bottom: 2px solid hsl(var(--border));
		position: relative;
	}

	.dashboard-header::after {
		content: '';
		position: absolute;
		bottom: -2px;
		left: 0;
		width: 120px;
		height: 2px;
		background: hsl(var(--primary));
	}

	.dashboard-title {
		font-family: var(--font-display);
		font-size: 3rem;
		font-weight: 700;
		color: hsl(var(--foreground));
		margin: 0 0 0.5rem 0;
		line-height: 1.1;
	}

	.dashboard-subtitle {
		font-family: var(--font-sans);
		font-size: 1rem;
		color: hsl(var(--muted-foreground));
		margin: 0;
	}

	.loading-state,
	.error-state,
	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		padding: 4rem 2rem;
		text-align: center;
	}

	.empty-state {
		color: hsl(var(--muted-foreground));
	}

	.empty-state h2 {
		font-family: var(--font-display);
		font-size: 2rem;
		font-weight: 600;
		color: hsl(var(--foreground));
		margin: 0;
	}

	.projects-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
		gap: 2rem;
	}

	.project-card {
		position: relative;
		background: hsl(var(--card));
		border: 2px solid hsl(var(--border));
		border-radius: 0;
		overflow: hidden;
		transition: all 0.2s;
		box-shadow: var(--shadow-md);
	}

	.project-card:hover {
		border-color: hsl(var(--primary));
		box-shadow: var(--shadow-lg);
		transform: translateY(-2px);
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
	}

	.project-icon {
		font-size: 4rem;
		padding: 3rem 1.5rem 1rem;
		display: flex;
		justify-content: center;
		align-items: center;
		height: 200px;
		background: linear-gradient(135deg, hsl(var(--muted)) 0%, hsl(var(--muted) / 0.6) 100%);
		position: relative;
	}

	.project-icon::before {
		content: '';
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		height: 4px;
		background: hsl(var(--primary));
	}

	.project-thumbnail {
		width: 100%;
		height: 200px;
		overflow: hidden;
		background: hsl(var(--muted));
		position: relative;
	}

	.project-thumbnail::before {
		content: '';
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		height: 4px;
		background: hsl(var(--primary));
		z-index: 1;
	}

	.project-thumbnail img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
		transition: transform 0.2s;
	}

	.project-card:hover .project-thumbnail img {
		transform: scale(1.02);
	}

	.project-info {
		padding: 1.25rem 1.5rem;
		background: hsl(var(--card));
	}

	.project-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.project-name {
		font-family: var(--font-display);
		font-size: 1.25rem;
		font-weight: 600;
		color: hsl(var(--foreground));
		margin: 0;
		word-break: break-word;
		flex: 1;
		line-height: 1.3;
	}

	.project-card :global(.project-menu-button) {
		flex-shrink: 0;
	}

	.published-badge {
		display: flex;
		align-items: center;
		justify-content: flex-start;
		gap: 0.375rem;
		padding: 0.375rem 0.75rem;
		background: transparent;
		color: hsl(var(--primary));
		border: 2px solid hsl(var(--primary));
		border-radius: 0;
		font-size: 0.75rem;
		font-weight: 700;
		font-family: var(--font-mono);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-top: 0.75rem;
		width: fit-content;
	}
</style>
