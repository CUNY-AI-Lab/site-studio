<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { createProject, fetchProjects, fetchTemplateCategories, type TemplateCategory, type TemplateMetadata } from '$lib/api/projects';
	import * as Dialog from '$lib/components/ui/dialog';
	import Button from '$lib/components/ui/button/button.svelte';
	import Input from '$lib/components/ui/input/input.svelte';
	import Label from '$lib/components/ui/label/label.svelte';
	import {
		Award,
		BarChart3,
		BookMarked,
		BookOpen,
		Calendar,
		Camera,
		Clock,
		Contact,
		FileText,
		Frame,
		GraduationCap,
		Grid,
		Image,
		Library,
		Link,
		Minimize2,
		PieChart,
		Presentation,
		ScrollText,
		SquareUser,
		User,
		UserCircle,
		Users
	} from 'lucide-svelte';
	import { toast } from '$lib/toast.svelte';
	import { isApiError } from '$lib/api/errors';

	interface Props {
		open: boolean;
		onOpenChange: (open: boolean) => void;
		onSuccess?: () => void;
	}

	let { open = $bindable(), onOpenChange, onSuccess }: Props = $props();

	// Map of icon name strings to Lucide components
	const iconMap: Record<string, any> = {
		User,
		UserCircle,
		Contact,
		SquareUser,
		FileText,
		GraduationCap,
		Award,
		ScrollText,
		Grid,
		Image,
		Frame,
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
		Minimize2,
		Clock
	};

	// Fetch template categories from API
	let templateCategories = $state<TemplateCategory[]>([]);
	let isLoadingTemplates = $state(true);
	let templateLoadError = $state(false);
	let selectedTemplate = $state<TemplateMetadata | null>(null);
	let projectName = $state('');
	let isCreating = $state(false);
	let hasUserEditedName = $state(false);
	let suggestionGeneration = 0;

	async function loadTemplates() {
		isLoadingTemplates = true;
		templateLoadError = false;
		try {
			templateCategories = await fetchTemplateCategories();
		} catch (error) {
			console.error('Failed to load templates:', error);
			templateLoadError = true;
		} finally {
			isLoadingTemplates = false;
		}
	}

	onMount(() => {
		void loadTemplates();
	});

	// Reset state when dialog closes
	$effect(() => {
		if (!open) {
			suggestionGeneration += 1;
			selectedTemplate = null;
			projectName = '';
			hasUserEditedName = false;
		}
	});

	// Get the next sequential number for a template
	async function getNextNumber(templateId: string): Promise<number> {
		try {
			const projects = await fetchProjects();
			const prefix = `${templateId}-`;

			// Find all projects that start with this template name
			const matchingProjects = projects.filter(p => p.name.startsWith(prefix));

			// Extract numbers and find the highest
			let maxNumber = 0;
			for (const project of matchingProjects) {
				const match = project.name.match(new RegExp(`^${templateId}-(\\d+)$`));
				if (match) {
					const num = parseInt(match[1], 10);
					if (num > maxNumber) maxNumber = num;
				}
			}

			return maxNumber + 1;
		} catch (error) {
			console.warn(
				'Project list fetch failed; falling back to auto-number 1 (a duplicate name surfaces as a 409):',
				error
			);
			return 1; // Default to 1 if we can't fetch
		}
	}

	async function handleCreate() {
		if (!selectedTemplate || isCreating) return;

		isCreating = true;

		try {
			// Generate project name if not provided - use sequential numbering
			let name = projectName.trim();
			if (!name) {
				const nextNumber = await getNextNumber(selectedTemplate.id);
				name = `${selectedTemplate.id}-${nextNumber}`;
			}

			// Create the project with template
			const project = await createProject(name, selectedTemplate.id);

			// Navigate to the editor
			goto(`${base}/editor/${project.id}`);

			// Close dialog and notify success
			onOpenChange(false);
			if (onSuccess) onSuccess();
		} catch (error) {
			console.error('Error creating project:', error);
			if (isApiError(error) && error.statusCode === 409) {
				toast.error('That project name is already taken. Pick a different name.');
			} else if (isApiError(error)) {
				toast.error(error.getUserMessage());
			} else {
				toast.error('Failed to create project. Please try again.');
			}
		} finally {
			isCreating = false;
		}
	}

	async function selectTemplate(template: TemplateMetadata) {
		const requestGeneration = ++suggestionGeneration;
		selectedTemplate = template;
		// Auto-suggest project name based on template with sequential numbering
		// Only auto-fill if user hasn't manually edited the name
		if (!hasUserEditedName) {
			const nextNumber = await getNextNumber(template.id);
			if (
				requestGeneration !== suggestionGeneration ||
				selectedTemplate?.id !== template.id ||
				hasUserEditedName
			)
				return;
			projectName = `${template.id}-${nextNumber}`;
		}
	}

	// Get the Lucide icon component for an icon name
	function getIcon(iconName: string) {
		return iconMap[iconName] || FileText;
	}
</script>

<Dialog.Root {open} onOpenChange={onOpenChange}>
	<Dialog.Content class="max-w-5xl max-h-[85vh] overflow-y-auto !bg-white dark:!bg-gray-900 !p-8">
		<Dialog.Header>
			<Dialog.Title>Create New Project</Dialog.Title>
			<Dialog.Description>
				Choose a starting template — you can customize it to create anything you want using the AI assistant.
			</Dialog.Description>
		</Dialog.Header>

		{#if !selectedTemplate}
			{#if isLoadingTemplates}
				<div class="loading-container">
					<p>Loading templates...</p>
				</div>
			{:else if templateLoadError}
				<div class="loading-container">
					<p>Failed to load templates.</p>
					<Button variant="outline" size="sm" onclick={loadTemplates}>Retry</Button>
				</div>
			{:else}
				<div class="categories-container">
					{#each templateCategories as category}
						<div class="category-section">
							<div class="category-header">
								<h3 class="category-title">{category.name}</h3>
								<p class="category-description">{category.description}</p>
							</div>
							<div class="templates-grid">
								{#each category.templates as template (template.id)}
									{@const TemplateIcon = getIcon(template.icon)}
									<button
										class="template-card"
										onclick={() => selectTemplate(template)}
									>
										<div class="template-preview">
											<img src={`${base}/template-previews/${template.id}.png`} alt={`${template.title} preview`} />
											<div class="template-overlay">
												<div class="template-icon">
													<TemplateIcon size={20} />
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
			{/if}
		{:else}
			<div class="selected-template">
				<div class="selected-header">
					<div class="selected-preview">
						<img
							src={`${base}/template-previews/${selectedTemplate.id}.png`}
							alt={`${selectedTemplate.title} preview`}
						/>
					</div>
					<div class="selected-info">
						<div class="selected-category">{selectedTemplate.categoryName}</div>
						<h4 class="selected-title">{selectedTemplate.title}</h4>
						<p class="selected-description">{selectedTemplate.description}</p>
					</div>
					<Button
						variant="ghost"
						size="sm"
						onclick={() => {
							suggestionGeneration += 1;
							selectedTemplate = null;
							projectName = '';
							hasUserEditedName = false;
						}}
					>
						Change
					</Button>
				</div>

				<div class="form-field">
					<Label for="projectName">Project Name (optional)</Label>
					<Input
						id="projectName"
						bind:value={projectName}
						oninput={() => hasUserEditedName = true}
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
	.loading-container {
		display: flex;
		justify-content: center;
		align-items: center;
		padding: 4rem 2rem;
		color: hsl(var(--muted-foreground));
	}

	.categories-container {
		display: flex;
		flex-direction: column;
		gap: 2rem;
		padding: 1rem 0;
	}

	.category-section {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
	}

	.category-header {
		border-bottom: 1px solid hsl(var(--border));
		padding-bottom: 0.5rem;
	}

	.category-title {
		font-size: 1rem;
		font-weight: 700;
		margin: 0 0 0.125rem;
		color: hsl(var(--foreground));
	}

	.category-description {
		font-size: 0.8125rem;
		color: hsl(var(--muted-foreground));
		margin: 0;
	}

	.templates-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
		gap: 0.875rem;
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
		padding: 0.5rem 0.625rem 0.625rem;
		flex: 1;
	}

	.template-title {
		font-size: 0.8125rem;
		font-weight: 600;
		margin: 0 0 0.125rem;
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
