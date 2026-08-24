<script lang="ts">
	import {
		createProjectSnapshot,
		fetchProjectSnapshots,
		restoreProjectSnapshot,
		type ProjectSnapshot
	} from '$lib/api/projects';
	import * as Dialog from '$lib/components/ui/dialog';
	import Button from '$lib/components/ui/button/button.svelte';
	import Input from '$lib/components/ui/input/input.svelte';
	import Label from '$lib/components/ui/label/label.svelte';
	import { getErrorMessage } from '$lib/api/errors';
	import { History, Loader2, RotateCcw, Save } from 'lucide-svelte';

	interface Props {
		open: boolean;
		projectId: string;
		projectName?: string;
		onOpenChange: (open: boolean) => void;
		onBeforeCreateSnapshot?: () => Promise<boolean>;
		onBeforeRestore?: () => Promise<boolean>;
		onRestoreSuccess?: () => void | Promise<void>;
	}

	let {
		open = $bindable(),
		projectId,
		projectName,
		onOpenChange,
		onBeforeCreateSnapshot,
		onBeforeRestore,
		onRestoreSuccess
	}: Props = $props();

	let snapshots = $state<ProjectSnapshot[]>([]);
	let isLoading = $state(false);
	let isCreating = $state(false);
	let restoringSnapshotId = $state<string | null>(null);
	let errorMessage = $state('');
	let snapshotLabel = $state('');
	let loadVersion = 0;

	const TRIGGER_LABELS = {
		agent: 'AI run',
		manual: 'Manual',
		restore: 'Restore point'
	} satisfies Record<ProjectSnapshot['trigger'], string>;

	function formatCreatedAt(value: string): string {
		try {
			return new Intl.DateTimeFormat(undefined, {
				dateStyle: 'medium',
				timeStyle: 'short'
			}).format(new Date(value));
		} catch {
			return value;
		}
	}

	function getSnapshotTitle(snapshot: ProjectSnapshot): string {
		if (snapshot.label?.trim()) {
			return snapshot.label.trim();
		}

		return TRIGGER_LABELS[snapshot.trigger];
	}

	async function loadSnapshots() {
		if (!open || !projectId) {
			return;
		}

		const targetProjectId = projectId;
		const version = ++loadVersion;
		isLoading = true;
		errorMessage = '';

		try {
			const loadedSnapshots = await fetchProjectSnapshots(targetProjectId);
			if (version !== loadVersion || targetProjectId !== projectId) return;
			snapshots = loadedSnapshots;
		} catch (error) {
			if (version !== loadVersion || targetProjectId !== projectId) return;
			errorMessage = getErrorMessage(error instanceof Error ? error : undefined);
		} finally {
			if (version === loadVersion) isLoading = false;
		}
	}

	$effect(() => {
		if (!open) {
			return;
		}

		void loadSnapshots();
	});

	$effect(() => {
		if (!open) {
			loadVersion += 1;
			isLoading = false;
			snapshotLabel = '';
			errorMessage = '';
		}
	});

	async function handleCreateSnapshot() {
		if (!projectId || isCreating || restoringSnapshotId !== null) {
			return;
		}

		isCreating = true;
		try {
			const canCreate = onBeforeCreateSnapshot ? await onBeforeCreateSnapshot() : true;
			if (!canCreate) {
				return;
			}

			errorMessage = '';
			const snapshot = await createProjectSnapshot(projectId, snapshotLabel.trim() || undefined);
			snapshots = [snapshot, ...snapshots];
			snapshotLabel = '';
		} catch (error) {
			errorMessage = getErrorMessage(error instanceof Error ? error : undefined);
		} finally {
			isCreating = false;
		}
	}

	async function handleRestore(snapshotId: string) {
		if (!projectId || isCreating || restoringSnapshotId !== null) {
			return;
		}

		restoringSnapshotId = snapshotId;
		try {
			const canRestore = onBeforeRestore ? await onBeforeRestore() : true;
			if (!canRestore) {
				return;
			}

			errorMessage = '';
			await restoreProjectSnapshot(projectId, snapshotId);
			await loadSnapshots();
			if (onRestoreSuccess) {
				await onRestoreSuccess();
			}
		} catch (error) {
			errorMessage = getErrorMessage(error instanceof Error ? error : undefined);
		} finally {
			restoringSnapshotId = null;
		}
	}
</script>

<Dialog.Root {open} onOpenChange={onOpenChange}>
	<Dialog.Content class="history-dialog !bg-white dark:!bg-gray-900">
		<Dialog.Header>
			<Dialog.Title>Version history</Dialog.Title>
			<Dialog.Description>
				Go back to an earlier version of {projectName || projectId}.
			</Dialog.Description>
		</Dialog.Header>

		<div class="history-actions">
			<div class="snapshot-field">
				<Label for="snapshot-label">Name this version</Label>
				<Input
					id="snapshot-label"
					bind:value={snapshotLabel}
					placeholder="Optional note for this checkpoint"
					disabled={isCreating || restoringSnapshotId !== null}
				/>
			</div>
			<Button onclick={handleCreateSnapshot} disabled={isCreating || restoringSnapshotId !== null}>
				{#if isCreating}
					<Loader2 size={14} class="animate-spin" />
					Creating...
				{:else}
					<Save size={14} />
					Save version
				{/if}
			</Button>
		</div>

		{#if errorMessage}
			<p class="history-error" role="alert">{errorMessage}</p>
		{/if}

		<div class="history-list">
			{#if isLoading}
				<div class="history-empty">
					<Loader2 size={16} class="animate-spin" />
					<span>Loading versions…</span>
				</div>
			{:else if snapshots.length === 0}
				<div class="history-empty">
					<History size={16} />
					<span>No saved versions yet.</span>
				</div>
			{:else}
				{#each snapshots as snapshot (snapshot.id)}
					<div class="history-item">
						<div class="history-meta">
							<div class="history-title-row">
								<span class="history-title">{getSnapshotTitle(snapshot)}</span>
								<span class="history-trigger">{TRIGGER_LABELS[snapshot.trigger]}</span>
							</div>
							<div class="history-details">
								<span>{formatCreatedAt(snapshot.createdAt)}</span>
								<span>{snapshot.fileCount} file{snapshot.fileCount === 1 ? '' : 's'}</span>
							</div>
						</div>
						<Button
							variant="outline"
							size="sm"
							onclick={() => handleRestore(snapshot.id)}
							disabled={isCreating || restoringSnapshotId !== null}
						>
							{#if restoringSnapshotId === snapshot.id}
								<Loader2 size={14} class="animate-spin" />
								Restoring...
							{:else}
								<RotateCcw size={14} />
								Restore
							{/if}
						</Button>
					</div>
				{/each}
			{/if}
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => onOpenChange(false)} disabled={isCreating || restoringSnapshotId !== null}>
				Close
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<style>
	:global(.history-dialog) {
		max-width: 42rem;
	}

	.history-actions {
		display: flex;
		gap: 0.75rem;
		align-items: flex-end;
		padding: 0.25rem 0 1rem;
	}

	.snapshot-field {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.history-list {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		max-height: 24rem;
		overflow-y: auto;
		padding: 0.25rem 0;
	}

	.history-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.875rem 1rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-bg-secondary);
	}

	.history-meta {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.history-title-row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.history-title {
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.history-trigger {
		font-size: 0.75rem;
		color: var(--color-text-secondary);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-full);
		padding: 0.125rem 0.5rem;
	}

	.history-details {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
	}

	.history-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		padding: 2rem 1rem;
		border: 1px dashed var(--color-border);
		border-radius: var(--radius-md);
		color: var(--color-text-secondary);
		background: var(--color-bg-secondary);
	}

	.history-error {
		margin: 0 0 0.75rem;
		color: var(--color-error);
		font-size: 0.875rem;
	}

	@media (max-width: 640px) {
		.history-actions {
			flex-direction: column;
			align-items: stretch;
		}

		.history-item {
			flex-direction: column;
			align-items: stretch;
		}
	}
</style>
