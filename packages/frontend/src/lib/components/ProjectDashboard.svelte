<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { fetchProjects, publishProject, unpublishProject, type Project } from '$lib/api/projects';
	import Button from '$lib/components/ui/button/button.svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { MoreVertical, Plus, FolderOpen, Globe, GlobeLock, ExternalLink } from 'lucide-svelte';
	import NewProjectDialog from './NewProjectDialog.svelte';
	import ProjectDialogs from './ProjectDialogs.svelte';

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
		goto(`/editor/${projectId}`);
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
								<img src={project.thumbnailUrl} alt={project.name} />
							</div>
						{:else}
							<div class="project-icon">🎨</div>
						{/if}
						<h3 class="project-name">{project.name}</h3>
						{#if project.published}
							<div class="published-badge">
								<Globe size={14} />
								<span>Published</span>
							</div>
						{/if}
					</button>
					<DropdownMenu.Root>
						<DropdownMenu.Trigger asChild>
							{#snippet child({ props })}
								<Button {...props} variant="ghost" size="icon" class="project-menu-button">
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
			{/each}
		</div>
	{/if}
</div>

<style>
	.project-dashboard {
		min-height: 100vh;
		background: hsl(var(--background));
		padding: 2rem;
	}

	.dashboard-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 2rem;
		padding-bottom: 1rem;
		border-bottom: 1px solid hsl(var(--border));
	}

	.dashboard-title {
		font-size: 2rem;
		font-weight: 700;
		color: hsl(var(--foreground));
		margin: 0 0 0.25rem 0;
	}

	.dashboard-subtitle {
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
		font-size: 1.5rem;
		font-weight: 600;
		color: hsl(var(--foreground));
		margin: 0;
	}

	.projects-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		gap: 1.5rem;
	}

	.project-card {
		position: relative;
		background: hsl(var(--card));
		border: 1px solid hsl(var(--border));
		border-radius: 0.5rem;
		overflow: hidden;
		transition: all 0.2s;
	}

	.project-card:hover {
		border-color: hsl(var(--primary));
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
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
		font-size: 3rem;
		padding: 3rem 1.5rem 1rem;
		display: flex;
		justify-content: center;
		align-items: center;
		height: 180px;
		background: linear-gradient(135deg, hsl(var(--muted)) 0%, hsl(var(--muted) / 0.5) 100%);
	}

	.project-thumbnail {
		width: 100%;
		height: 180px;
		overflow: hidden;
		background: hsl(var(--muted));
	}

	.project-thumbnail img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}

	.project-name {
		font-size: 1.125rem;
		font-weight: 600;
		color: hsl(var(--foreground));
		margin: 0;
		word-break: break-word;
		padding: 1rem 1.5rem 0.5rem;
	}

	.project-card :global(.project-menu-button) {
		position: absolute;
		top: 0.5rem;
		right: 0.5rem;
	}

	.published-badge {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.25rem;
		padding: 0.25rem 0.75rem;
		background: hsl(var(--primary) / 0.1);
		color: hsl(var(--primary));
		border-radius: 1rem;
		font-size: 0.75rem;
		font-weight: 500;
		margin: 0.5rem 1.5rem 1rem;
	}
</style>
