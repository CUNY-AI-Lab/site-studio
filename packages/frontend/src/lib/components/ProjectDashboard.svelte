<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { fetchProjects, type Project } from '$lib/api/projects';
	import Button from '$lib/components/ui/button/button.svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { MoreVertical, Plus, FolderOpen } from 'lucide-svelte';
	import NewProjectDialog from './NewProjectDialog.svelte';
	import ProjectDialogs from './ProjectDialogs.svelte';

	let projects = $state<Project[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

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
						<div class="project-icon">🎨</div>
						<h3 class="project-name">{project.name}</h3>
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
							<DropdownMenu.Item onclick={() => handleRenameProject(project)}>
								Rename
							</DropdownMenu.Item>
							<DropdownMenu.Separator />
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
		padding: 2rem 1.5rem;
		background: none;
		border: none;
		cursor: pointer;
		text-align: left;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1rem;
	}

	.project-icon {
		font-size: 3rem;
	}

	.project-name {
		font-size: 1.125rem;
		font-weight: 600;
		color: hsl(var(--foreground));
		margin: 0;
		word-break: break-word;
	}

	.project-card :global(.project-menu-button) {
		position: absolute;
		top: 0.5rem;
		right: 0.5rem;
	}
</style>
