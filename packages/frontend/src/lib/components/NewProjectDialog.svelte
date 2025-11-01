<script lang="ts">
	import { goto } from '$app/navigation';
	import { createProject } from '$lib/api/projects';
	import * as Dialog from '$lib/components/ui/dialog';
	import Button from '$lib/components/ui/button/button.svelte';
	import Input from '$lib/components/ui/input/input.svelte';
	import Label from '$lib/components/ui/label/label.svelte';
	import {
		User,
		UserCircle,
		Contact,
		FileText,
		GraduationCap,
		Award,
		Grid,
		Image,
		Presentation,
		BookOpen,
		BookMarked,
		Library,
		Calendar,
		Users,
		Camera,
		Link,
		BarChart3,
		PieChart,
		Minimize2
	} from 'lucide-svelte';

	interface Props {
		open: boolean;
		onOpenChange: (open: boolean) => void;
		onSuccess?: () => void;
	}

	let { open = $bindable(), onOpenChange, onSuccess }: Props = $props();

	const templateCategories = [
		{
			name: 'Personal Pages',
			description: 'Simple landing pages and profiles',
			templates: [
				{
					id: 'personal-minimal',
					title: 'Minimal',
					description: 'Clean, centered landing page',
					icon: User
				},
				{
					id: 'personal-bold',
					title: 'Bold',
					description: 'Vibrant page with featured work',
					icon: UserCircle
				},
				{
					id: 'personal-sidebar',
					title: 'Sidebar',
					description: 'Sidebar navigation layout',
					icon: Contact
				}
			]
		},
		{
			name: 'CV & Resume',
			description: 'Academic and professional CVs',
			templates: [
				{
					id: 'cv-classic',
					title: 'Classic',
					description: 'Traditional academic CV',
					icon: FileText
				},
				{
					id: 'cv-modern',
					title: 'Modern',
					description: 'Contemporary CV with sidebar',
					icon: GraduationCap
				},
				{
					id: 'cv-timeline',
					title: 'Timeline',
					description: 'Visual timeline format',
					icon: Award
				}
			]
		},
		{
			name: 'Portfolio',
			description: 'Showcase your work and projects',
			templates: [
				{
					id: 'portfolio-grid',
					title: 'Grid',
					description: 'Project grid showcase',
					icon: Grid
				},
				{
					id: 'portfolio-magazine',
					title: 'Magazine',
					description: 'Editorial style portfolio',
					icon: BookOpen
				},
				{
					id: 'portfolio-showcase',
					title: 'Showcase',
					description: 'Featured work display',
					icon: Image
				}
			]
		},
		{
			name: 'Course Sites',
			description: 'Syllabi, schedules, and materials',
			templates: [
				{
					id: 'course-traditional',
					title: 'Traditional',
					description: 'Classic syllabus layout',
					icon: Presentation
				},
				{
					id: 'course-modern',
					title: 'Modern',
					description: 'Contemporary course site',
					icon: BookOpen
				}
			]
		},
		{
			name: 'Publications',
			description: 'Research papers and articles',
			templates: [
				{
					id: 'publication-bibliography',
					title: 'Bibliography',
					description: 'Traditional citation format',
					icon: BookMarked
				},
				{
					id: 'publication-featured',
					title: 'Featured',
					description: 'Showcase key publications',
					icon: Library
				}
			]
		},
		{
			name: 'Events',
			description: 'Conferences, workshops, symposia',
			templates: [
				{
					id: 'event-schedule',
					title: 'Schedule',
					description: 'Conference schedule',
					icon: Calendar
				},
				{
					id: 'event-speaker',
					title: 'Speakers',
					description: 'Speaker/presenter focused',
					icon: Users
				}
			]
		},
		{
			name: 'Photo Essays',
			description: 'Visual storytelling with images',
			templates: [
				{
					id: 'photo-gallery',
					title: 'Gallery',
					description: 'Image gallery layout',
					icon: Camera
				},
				{
					id: 'photo-narrative',
					title: 'Narrative',
					description: 'Scrolling photo story',
					icon: Image
				}
			]
		},
		{
			name: 'Resources',
			description: 'Curated links and collections',
			templates: [
				{
					id: 'resource-categorized',
					title: 'Categorized',
					description: 'Organized by categories',
					icon: Link
				},
				{
					id: 'resource-grid',
					title: 'Grid',
					description: 'Card grid layout',
					icon: Grid
				}
			]
		},
		{
			name: 'Data Visualization',
			description: 'Charts, graphs, and interactive data',
			templates: [
				{
					id: 'dataviz-dashboard',
					title: 'Dashboard',
					description: 'Chart dashboard',
					icon: BarChart3
				},
				{
					id: 'dataviz-narrative',
					title: 'Narrative',
					description: 'Scrolling data story',
					icon: PieChart
				},
				{
					id: 'dataviz-interactive',
					title: 'Interactive',
					description: 'Interactive explorer',
					icon: BarChart3
				}
			]
		},
		{
			name: 'Start Fresh',
			description: 'Blank canvas',
			templates: [
				{
					id: 'blank',
					title: 'Blank Canvas',
					description: 'Start from scratch',
					icon: Minimize2
				}
			]
		}
	];

	type Template = {
		id: string;
		title: string;
		description: string;
		icon: any;
		categoryName: string;
	};

	let selectedTemplate = $state<Template | null>(null);
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

			// Create the project with template
			const project = await createProject(name, selectedTemplate.id);

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

	function selectTemplate(template: any, categoryName: string) {
		selectedTemplate = {
			...template,
			categoryName
		};
		// Auto-suggest project name based on template
		if (!projectName) {
			const timestamp = Date.now().toString(36).substring(0, 4);
			projectName = `${template.id}-${timestamp}`;
		}
	}
</script>

<Dialog.Root {open} onOpenChange={onOpenChange}>
	<Dialog.Content class="max-w-6xl max-h-[90vh] overflow-y-auto !bg-white dark:!bg-gray-900">
		<Dialog.Header>
			<Dialog.Title>Create New Project</Dialog.Title>
			<Dialog.Description>
				Choose a starting template — you can customize it to create anything you want using the AI assistant.
			</Dialog.Description>
		</Dialog.Header>

		{#if !selectedTemplate}
			<div class="categories-container">
				{#each templateCategories as category}
					<div class="category-section">
						<div class="category-header">
							<h3 class="category-title">{category.name}</h3>
							<p class="category-description">{category.description}</p>
						</div>
						<div class="templates-grid">
							{#each category.templates as template (template.id)}
								<button
									class="template-card"
									onclick={() => selectTemplate(template, category.name)}
								>
									<div class="template-preview">
										<img src="/template-previews/{template.id}.png" alt="{template.title} preview" />
										<div class="template-overlay">
											<div class="template-icon">
												<svelte:component this={template.icon} size={20} />
											</div>
										</div>
									</div>
									<div class="template-info">
										<h4 class="template-title">{template.title}</h4>
										<p class="template-description">{template.description}</p>
									</div>
								</button>
							{/each}
						</div>
					</div>
				{/each}
			</div>
		{:else}
			<div class="selected-template">
				<div class="selected-header">
					<div class="selected-preview">
						<img src="/template-previews/{selectedTemplate.id}.png" alt="{selectedTemplate.title} preview" />
					</div>
					<div class="selected-info">
						<div class="selected-category">{selectedTemplate.categoryName}</div>
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
	.categories-container {
		display: flex;
		flex-direction: column;
		gap: 3rem;
		padding: 1.5rem 0;
	}

	.category-section {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.category-header {
		border-bottom: 2px solid hsl(var(--border));
		padding-bottom: 0.75rem;
	}

	.category-title {
		font-size: 1.125rem;
		font-weight: 700;
		margin: 0 0 0.25rem;
		color: hsl(var(--foreground));
	}

	.category-description {
		font-size: 0.875rem;
		color: hsl(var(--muted-foreground));
		margin: 0;
	}

	.templates-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 1rem;
	}

	.template-card {
		background: white;
		border-radius: 0.625rem;
		border: 1.5px solid hsl(var(--border));
		cursor: pointer;
		transition: all 0.2s;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		text-align: left;
		padding: 0;
	}

	.template-card:hover {
		transform: translateY(-2px);
		box-shadow: 0 8px 20px rgba(0, 0, 0, 0.08);
		border-color: hsl(var(--primary));
	}

	.template-preview {
		position: relative;
		width: 100%;
		aspect-ratio: 4 / 3;
		overflow: hidden;
		background: hsl(var(--muted) / 0.3);
	}

	.template-preview img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}

	.template-overlay {
		position: absolute;
		top: 0.5rem;
		right: 0.5rem;
		width: 2rem;
		height: 2rem;
		background: white;
		border-radius: 0.375rem;
		display: flex;
		align-items: center;
		justify-content: center;
		box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1);
		opacity: 0;
		transition: opacity 0.2s;
	}

	.template-card:hover .template-overlay {
		opacity: 1;
	}

	.template-icon {
		color: hsl(var(--primary));
	}

	.template-info {
		padding: 0.875rem;
		flex: 1;
	}

	.template-title {
		font-size: 0.875rem;
		font-weight: 600;
		margin: 0 0 0.25rem;
		color: hsl(var(--foreground));
	}

	.template-description {
		font-size: 0.75rem;
		color: hsl(var(--muted-foreground));
		margin: 0;
		line-height: 1.4;
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

	.selected-preview {
		width: 140px;
		height: 90px;
		border-radius: 0.5rem;
		overflow: hidden;
		flex-shrink: 0;
		background: white;
		border: 1px solid hsl(var(--border));
	}

	.selected-preview img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}

	.selected-info {
		flex: 1;
	}

	.selected-category {
		font-size: 0.75rem;
		color: hsl(var(--primary));
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		margin-bottom: 0.25rem;
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
