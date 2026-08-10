<script lang="ts">
	import { renameProject, deleteProject, type Project } from '$lib/api/projects';
	import * as Dialog from '$lib/components/ui/dialog';
	import Button from '$lib/components/ui/button/button.svelte';
	import Input from '$lib/components/ui/input/input.svelte';
	import Label from '$lib/components/ui/label/label.svelte';
	import { toast } from '$lib/toast.svelte';
	import { getErrorMessage } from '$lib/api/errors';

	interface Props {
		showRenameDialog: boolean;
		showDeleteDialog: boolean;
		selectedProject: Project | null;
		onRenameOpenChange: (open: boolean) => void;
		onDeleteOpenChange: (open: boolean) => void;
		onBeforeRename?: () => Promise<boolean>;
		onBeforeDelete?: () => Promise<boolean>;
		onRenameSuccess: (project: Project) => void | Promise<void>;
		onDeleteSuccess: (projectId: string) => void | Promise<void>;
	}

	let {
		showRenameDialog = $bindable(),
		showDeleteDialog = $bindable(),
		selectedProject,
		onRenameOpenChange,
		onDeleteOpenChange,
		onBeforeRename,
		onBeforeDelete,
		onRenameSuccess,
		onDeleteSuccess
	}: Props = $props();

	let newName = $state('');
	let isRenaming = $state(false);
	let isDeleting = $state(false);

	// Update newName when selectedProject changes
	$effect(() => {
		if (selectedProject && showRenameDialog) {
			newName = selectedProject.name;
		}
	});

	async function handleRename() {
		if (!selectedProject || !newName.trim() || isRenaming) return;

		try {
			const canRename = onBeforeRename ? await onBeforeRename() : true;
			if (!canRename) return;

			isRenaming = true;
			const renamedProject = await renameProject(selectedProject.id, newName.trim());
			onRenameOpenChange(false);
			await onRenameSuccess(renamedProject);
			toast.success('Project renamed.');
		} catch (error) {
			console.error('Error renaming project:', error);
			toast.error(`Couldn't rename project. ${getErrorMessage(error)}`);
		} finally {
			isRenaming = false;
		}
	}

	async function handleDelete() {
		if (!selectedProject || isDeleting) return;

		try {
			const canDelete = onBeforeDelete ? await onBeforeDelete() : true;
			if (!canDelete) return;

			isDeleting = true;
			const deletedProjectId = selectedProject.id;
			await deleteProject(selectedProject.id);
			onDeleteOpenChange(false);
			await onDeleteSuccess(deletedProjectId);
			toast.success('Project deleted.');
		} catch (error) {
			console.error('Error deleting project:', error);
			toast.error(`Couldn't delete project. ${getErrorMessage(error)}`);
		} finally {
			isDeleting = false;
		}
	}
</script>

<!-- Rename Dialog -->
<Dialog.Root open={showRenameDialog} onOpenChange={onRenameOpenChange}>
	<Dialog.Content class="!bg-white dark:!bg-gray-900">
		<Dialog.Header>
			<Dialog.Title>Rename Project</Dialog.Title>
			<Dialog.Description>
				Enter a new name for "{selectedProject?.name}"
			</Dialog.Description>
		</Dialog.Header>

		<div class="form-field">
			<Label for="newName">Project Name</Label>
			<Input
				id="newName"
				bind:value={newName}
				placeholder="my-project"
				disabled={isRenaming}
				onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && handleRename()}
			/>
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => onRenameOpenChange(false)} disabled={isRenaming}>
				Cancel
			</Button>
			<Button onclick={handleRename} disabled={isRenaming || !newName.trim()}>
				{isRenaming ? 'Renaming...' : 'Rename'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<!-- Delete Dialog -->
<Dialog.Root open={showDeleteDialog} onOpenChange={onDeleteOpenChange}>
	<Dialog.Content class="!bg-white dark:!bg-gray-900">
		<Dialog.Header>
			<Dialog.Title>Delete Project</Dialog.Title>
			<Dialog.Description>
				{#if selectedProject?.published}
					Deleting "{selectedProject.name}" will remove its public site. This action cannot be undone.
				{:else}
					Are you sure you want to delete "{selectedProject?.name}"? This action cannot be undone.
				{/if}
			</Dialog.Description>
		</Dialog.Header>

		<Dialog.Footer class="!flex !flex-row !justify-end !gap-2">
			<Button variant="outline" onclick={() => onDeleteOpenChange(false)} disabled={isDeleting}>
				Cancel
			</Button>
			<Button variant="destructive" onclick={handleDelete} disabled={isDeleting}>
				{isDeleting ? 'Deleting...' : 'Delete Project'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<style>
	.form-field {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 1rem 0;
	}
</style>
