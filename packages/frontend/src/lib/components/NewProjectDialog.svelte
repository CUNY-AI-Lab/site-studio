<script lang="ts">
	import { goto } from '$app/navigation';
	import { createProject } from '$lib/api/projects';
	import * as Dialog from '$lib/components/ui/dialog';
	import Button from '$lib/components/ui/button/button.svelte';
	import Input from '$lib/components/ui/input/input.svelte';
	import Label from '$lib/components/ui/label/label.svelte';
	import {
		BookOpen,
		Presentation,
		Folder,
		User,
		MessageSquare
	} from 'lucide-svelte';

	interface Props {
		open: boolean;
		onOpenChange: (open: boolean) => void;
		onSuccess?: () => void;
	}

	let { open = $bindable(), onOpenChange, onSuccess }: Props = $props();

	const templates = [
		{
			id: 'research-portfolio',
			title: 'Research Portfolio',
			description: 'Academic profile with publications, CV, and contact',
			icon: BookOpen,
			gradient: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
			prompt: 'Create a research portfolio website with sections for publications, CV, research interests, and contact information. Use a clean, professional academic design.'
		},
		{
			id: 'course-website',
			title: 'Course Website',
			description: 'Syllabus, assignments, readings, and materials',
			icon: Presentation,
			gradient: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
			prompt: 'Create a course website with sections for syllabus, weekly schedule, assignments, readings, and contact information. Make it easy for students to navigate.'
		},
		{
			id: 'project-showcase',
			title: 'Project Showcase',
			description: 'Document and share your work',
			icon: Folder,
			gradient: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
			prompt: 'Create a project showcase website to display my work, with a portfolio grid, project detail pages, and an about section.'
		},
		{
			id: 'personal-site',
			title: 'Personal Site',
			description: 'Professional web presence',
			icon: User,
			gradient: 'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
			prompt: 'Create a personal website with sections for about me, experience, skills, projects, and contact information. Use a modern, clean design.'
		},
		{
			id: 'custom',
			title: 'Describe Custom',
			description: 'Tell the agent what to build',
			icon: MessageSquare,
			gradient: 'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
			prompt: null
		}
	];

	let selectedTemplate = $state<typeof templates[0] | null>(null);
	let projectName = $state('');
	let isCreating = $state(false);

	async function handleCreate() {
		if (!selectedTemplate || isCreating) return;

		isCreating = true;

		try {
			// Generate project name if not provided
			const timestamp = Date.now().toString(36);
			const random = Math.random().toString(36).substring(2, 7);
			const name = projectName.trim() || `${selectedTemplate.id}-${timestamp}${random}`;

			// Create the project
			const project = await createProject(name);

			// Store template prompt in localStorage for the agent
			if (selectedTemplate.prompt) {
				localStorage.setItem('templatePrompt', selectedTemplate.prompt);
			}

			// Navigate to the editor
			goto(`/editor/${project.id}`);

			// Close dialog and notify success
			onOpenChange(false);
			if (onSuccess) onSuccess();
		} catch (error) {
			console.error('Error creating project:', error);
			alert('Failed to create project. Please try again.');
		} finally {
			isCreating = false;
		}
	}

	function selectTemplate(template: typeof templates[0]) {
		selectedTemplate = template;
		// Auto-suggest project name based on template
		if (!projectName) {
			const timestamp = Date.now().toString(36).substring(0, 4);
			projectName = `${template.id}-${timestamp}`;
		}
	}
</script>

<Dialog.Root {open} onOpenChange={onOpenChange}>
	<Dialog.Content class="max-w-4xl max-h-[90vh] overflow-y-auto !bg-white dark:!bg-gray-900">
		<Dialog.Header>
			<Dialog.Title>Create New Project</Dialog.Title>
			<Dialog.Description>
				Choose a template to get started, or describe your own project.
			</Dialog.Description>
		</Dialog.Header>

		{#if !selectedTemplate}
			<div class="templates-grid">
				{#each templates as template (template.id)}
					<button
						class="template-card"
						style="background: {template.gradient}"
						onclick={() => selectTemplate(template)}
					>
						<div class="template-icon">
							<svelte:component this={template.icon} size={32} />
						</div>
						<h3 class="template-title">{template.title}</h3>
						<p class="template-description">{template.description}</p>
					</button>
				{/each}
			</div>
		{:else}
			<div class="selected-template">
				<div class="selected-header">
					<div
						class="selected-icon"
						style="background: {selectedTemplate.gradient}"
					>
						<svelte:component this={selectedTemplate.icon} size={24} />
					</div>
					<div>
						<h4 class="selected-title">{selectedTemplate.title}</h4>
						<p class="selected-description">{selectedTemplate.description}</p>
					</div>
					<Button
						variant="ghost"
						size="sm"
						onclick={() => (selectedTemplate = null)}
					>
						Change
					</Button>
				</div>

				<div class="form-field">
					<Label for="projectName">Project Name (optional)</Label>
					<Input
						id="projectName"
						bind:value={projectName}
						placeholder="my-awesome-project"
						disabled={isCreating}
					/>
					<p class="field-hint">Leave blank to auto-generate a name</p>
				</div>
			</div>

			<Dialog.Footer>
				<Button variant="outline" onclick={() => onOpenChange(false)} disabled={isCreating}>
					Cancel
				</Button>
				<Button onclick={handleCreate} disabled={isCreating}>
					{isCreating ? 'Creating...' : 'Create Project'}
				</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<style>
	.templates-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 1rem;
		padding: 1rem 0;
	}

	.template-card {
		padding: 1.5rem;
		border-radius: 0.5rem;
		border: none;
		cursor: pointer;
		text-align: center;
		color: white;
		transition: transform 0.2s, box-shadow 0.2s;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
	}

	.template-card:hover {
		transform: translateY(-2px);
		box-shadow: 0 8px 16px rgba(0, 0, 0, 0.2);
	}

	.template-icon {
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.template-title {
		font-size: 1rem;
		font-weight: 600;
		margin: 0;
	}

	.template-description {
		font-size: 0.875rem;
		opacity: 0.9;
		margin: 0;
	}

	.selected-template {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
		padding: 1rem 0;
	}

	.selected-header {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 1rem;
		background: hsl(var(--muted));
		border-radius: 0.5rem;
	}

	.selected-icon {
		width: 48px;
		height: 48px;
		border-radius: 0.5rem;
		display: flex;
		align-items: center;
		justify-content: center;
		color: white;
		flex-shrink: 0;
	}

	.selected-title {
		font-size: 1rem;
		font-weight: 600;
		margin: 0;
	}

	.selected-description {
		font-size: 0.875rem;
		color: hsl(var(--muted-foreground));
		margin: 0.25rem 0 0;
	}

	.form-field {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.field-hint {
		font-size: 0.875rem;
		color: hsl(var(--muted-foreground));
		margin: 0;
	}
</style>
