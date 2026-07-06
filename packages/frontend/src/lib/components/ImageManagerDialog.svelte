<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import Button from '$lib/components/ui/button/button.svelte';
	import { Loader2, Upload, Sparkles, X } from 'lucide-svelte';
	import { resolvePath } from '$lib/utils/paths';
	import { toast } from '$lib/toast.svelte';
	import {
		fetchProjectImages,
		uploadProjectImage,
		type PlaceholderFinding,
		type ProjectImage
	} from '$lib/api/projects';
	import { getErrorMessage } from '$lib/api/errors';

	let {
		open = false,
		projectId,
		onOpenChange,
		onAskAssistant
	}: {
		open: boolean;
		projectId: string;
		onOpenChange: (open: boolean) => void;
		/**
		 * Hand a natural-language instruction to the chat assistant (same pattern
		 * as AccessibilityNotesDialog). The dialog closes itself first.
		 */
		onAskAssistant: (prompt: string) => void;
	} = $props();

	let images = $state<ProjectImage[]>([]);
	let placeholders = $state<PlaceholderFinding[]>([]);
	let loading = $state(false);
	let loadError = $state<string | null>(null);

	let uploading = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);

	// The insertion/replacement form: which image (path) it targets, and — when
	// replacing — the placeholder it is scoped to. `null` means no form open.
	let activePath = $state<string | null>(null);
	let replaceTarget = $state<PlaceholderFinding | null>(null);
	let altText = $state('');
	let isDecorative = $state(false);
	let locationHint = $state('');

	let hasImages = $derived(images.length > 0);

	function thumbUrl(path: string): string {
		return resolvePath(`/preview/${projectId}/${path}`);
	}

	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	async function load() {
		loading = true;
		loadError = null;
		try {
			const result = await fetchProjectImages(projectId);
			images = result.images;
			placeholders = result.placeholders;
		} catch (e) {
			loadError = getErrorMessage(e);
		} finally {
			loading = false;
		}
	}

	// Load fresh data each time the dialog opens; reset the transient form state.
	$effect(() => {
		if (open) {
			resetForm();
			void load();
		}
	});

	function resetForm() {
		activePath = null;
		replaceTarget = null;
		altText = '';
		isDecorative = false;
		locationHint = '';
	}

	async function handleUpload(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		uploading = true;
		try {
			await uploadProjectImage(projectId, file);
			await load();
		} catch (e) {
			toast.error(`Could not upload image. ${getErrorMessage(e)}`);
		} finally {
			uploading = false;
			input.value = '';
		}
	}

	function selectImage(path: string) {
		activePath = path;
		// While a replacement is scoped, picking a thumbnail just switches which
		// image will replace the placeholder; the scope (and any typed alt text)
		// stays. Cancel the form to get back to plain insertion.
		if (!replaceTarget) {
			altText = '';
			isDecorative = false;
			locationHint = '';
		}
	}

	function startReplace(finding: PlaceholderFinding, path: string) {
		activePath = path;
		replaceTarget = finding;
		altText = '';
		isDecorative = false;
		locationHint = '';
	}

	function onDecorativeChange(event: Event) {
		isDecorative = (event.target as HTMLInputElement).checked;
		if (isDecorative) {
			altText = '';
		}
	}

	let canSubmit = $derived(!!activePath && (isDecorative || altText.trim().length > 0));

	function locationLabel(finding: PlaceholderFinding): string {
		return finding.line != null ? `${finding.file}:${finding.line}` : finding.file;
	}

	function submit() {
		if (!activePath) return;
		const path = activePath;
		const alt = altText.trim();

		// SS-22: alt text and the location hint are free-form user input. Splicing
		// them raw into the instruction lets a `"` or newline break the surrounding
		// quoting and produce a malformed (or misleading) instruction. JSON.stringify
		// emits a safely-quoted, escaped string literal — quotes and newlines survive
		// intact and the instruction stays unambiguous and readable.
		let prompt: string;
		if (replaceTarget) {
			const at = locationLabel(replaceTarget);
			if (isDecorative) {
				prompt = `Replace the placeholder image at ${at} with ${path} and mark it decorative with alt="".`;
			} else {
				prompt = `Replace the placeholder image at ${at} with ${path} and set its alt text to ${JSON.stringify(alt)}.`;
			}
		} else {
			const hint = locationHint.trim();
			const where = hint ? ` (${JSON.stringify(hint)})` : '';
			if (isDecorative) {
				prompt = `Insert ${path} into the site${where}. It is decorative, so use alt="".`;
			} else {
				prompt = `Insert ${path} into the site${where}. Use alt text: ${JSON.stringify(alt)}.`;
			}
		}

		onAskAssistant(prompt);
		onOpenChange(false);
	}
</script>

<Dialog.Root {open} {onOpenChange}>
	<Dialog.Content class="image-dialog">
		<Dialog.Header>
			<Dialog.Title>Images</Dialog.Title>
			<Dialog.Description>
				Upload photos and let the assistant place them, or swap out the gray placeholder boxes on
				your site.
			</Dialog.Description>
		</Dialog.Header>

		<div class="image-body">
			<input
				type="file"
				accept=".png,.jpg,.jpeg,.gif,.webp"
				bind:this={fileInput}
				onchange={handleUpload}
				style="display: none;"
			/>

			<div class="upload-row">
				<Button variant="outline" onclick={() => fileInput?.click()} disabled={uploading}>
					{#if uploading}
						<Loader2 size={15} class="spin" />
						Uploading…
					{:else}
						<Upload size={15} />
						Upload an image
					{/if}
				</Button>
			</div>

			<p class="sr-status" aria-live="polite">
				{#if loading}Loading your images…{:else if uploading}Uploading image…{/if}
			</p>

			{#if loadError}
				<p class="load-error" role="alert">{loadError}</p>
			{/if}

			<!-- Your images -->
			<section class="block" aria-labelledby="your-images-heading">
				<h3 id="your-images-heading" class="block-heading">Your images</h3>
				{#if loading}
					<p class="muted">Loading…</p>
				{:else if !hasImages}
					<p class="muted">
						No images yet. Upload one above, then the assistant can place it on your site.
					</p>
				{:else}
					<ul class="image-grid">
						{#each images as image (image.path)}
							<li class="image-card">
								<button
									type="button"
									class="thumb-button"
									class:active={activePath === image.path}
									onclick={() => selectImage(image.path)}
									title={replaceTarget ? 'Use this image for the replacement' : 'Insert this image'}
								>
									<img src={thumbUrl(image.path)} alt="" loading="lazy" />
								</button>
								<div class="image-meta">
									<span class="image-name" title={image.path}>{image.path}</span>
									<span class="image-size">{formatSize(image.size)}</span>
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			<!-- Placeholders -->
			{#if placeholders.length > 0}
				<section class="block" aria-labelledby="placeholder-heading">
					<h3 id="placeholder-heading" class="block-heading">Placeholders still on your site</h3>
					<p class="muted intro">
						These gray boxes will show on your published site until replaced.
					</p>
					<ul class="placeholder-list">
						{#each placeholders as finding (locationLabel(finding))}
							<li class="placeholder-row">
								<div class="placeholder-body">
									<code class="loc">{locationLabel(finding)}</code>
									<p class="placeholder-message">{finding.message}</p>
								</div>
								{#if hasImages}
									<Button
										variant="outline"
										size="sm"
										onclick={() => startReplace(finding, images[0].path)}
									>
										Replace
									</Button>
								{:else}
									<Button
										variant="outline"
										size="sm"
										onclick={() => fileInput?.click()}
										title="Upload an image first"
									>
										Upload an image first
									</Button>
								{/if}
							</li>
						{/each}
					</ul>
				</section>
			{/if}

			<!-- Insert / replace form -->
			{#if activePath}
				<section class="block form-block" aria-labelledby="form-heading">
					<div class="form-top">
						<h3 id="form-heading" class="block-heading">
							{#if replaceTarget}
								Replace placeholder with this image
							{:else}
								Add this image to your site
							{/if}
						</h3>
						<button type="button" class="close-form" onclick={resetForm} title="Cancel">
							<X size={15} />
						</button>
					</div>

					<div class="form-preview">
						<img src={thumbUrl(activePath)} alt="" />
						<code class="form-path">{activePath}</code>
					</div>
					{#if replaceTarget}
						<p class="muted">Click another image above to use it instead.</p>
					{/if}

					<div class="field">
						<label class="field-label" for="alt-input">Describe this image</label>
						<input
							id="alt-input"
							class="text-input"
							type="text"
							placeholder="e.g. A student presenting research at a poster session"
							bind:value={altText}
							disabled={isDecorative}
						/>
					</div>

					<label class="decorative">
						<input type="checkbox" checked={isDecorative} onchange={onDecorativeChange} />
						<span>This image is decorative</span>
					</label>

					{#if !replaceTarget}
						<div class="field">
							<label class="field-label" for="location-input">Where should it go? (optional)</label>
							<input
								id="location-input"
								class="text-input"
								type="text"
								placeholder="e.g. At the top of the About page"
								bind:value={locationHint}
							/>
						</div>
					{/if}

					<div class="form-actions">
						<Button variant="ghost" onclick={resetForm}>Cancel</Button>
						<Button onclick={submit} disabled={!canSubmit}>
							<Sparkles size={15} />
							{#if replaceTarget}
								Replace with the assistant
							{:else}
								Insert with the assistant
							{/if}
						</Button>
					</div>
				</section>
			{/if}
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => onOpenChange(false)}>Close</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<style>
	.image-body {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		max-height: 60vh;
		overflow-y: auto;
	}

	.upload-row {
		display: flex;
	}

	.sr-status {
		margin: 0;
		font-size: 0.75rem;
		color: var(--color-text-tertiary);
		min-height: 0;
	}

	.load-error {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--color-error);
	}

	.block {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.block-heading {
		margin: 0;
		font-size: 0.8125rem;
		font-weight: 600;
		letter-spacing: 0.01em;
		color: var(--color-text-secondary);
	}

	.muted {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--color-text-tertiary);
		line-height: 1.45;
	}
	.muted.intro {
		margin-top: -0.25rem;
	}

	.image-grid {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
		gap: 0.625rem;
	}

	.image-card {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		min-width: 0;
	}

	.thumb-button {
		display: block;
		width: 100%;
		aspect-ratio: 4 / 3;
		padding: 0;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		overflow: hidden;
		background: var(--color-bg-secondary);
		cursor: pointer;
		transition:
			border-color 0.15s ease,
			box-shadow 0.15s ease;
	}
	.thumb-button:hover {
		border-color: var(--color-border-hover);
	}
	.thumb-button.active {
		border-color: var(--color-primary, var(--color-text-primary));
		box-shadow: 0 0 0 2px var(--color-primary-light, rgba(0, 0, 0, 0.08));
	}
	.thumb-button img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}

	.image-meta {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.image-name {
		font-size: 0.6875rem;
		color: var(--color-text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono, monospace);
	}
	.image-size {
		font-size: 0.6875rem;
		color: var(--color-text-tertiary);
	}

	.placeholder-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.placeholder-row {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.625rem 0.75rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		border-left: 3px solid var(--color-warning);
		background: var(--color-bg-secondary);
	}

	.placeholder-body {
		min-width: 0;
		flex: 1;
	}

	.loc {
		font-size: 0.75rem;
		color: var(--color-text-tertiary);
		font-family: var(--font-mono, monospace);
		word-break: break-all;
	}

	.placeholder-message {
		margin: 0.2rem 0 0;
		font-size: 0.8125rem;
		line-height: 1.45;
		color: var(--color-text-secondary);
	}

	.form-block {
		padding: 0.875rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		background: var(--color-bg-elevated);
	}

	.form-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.close-form {
		display: flex;
		border: none;
		background: none;
		color: var(--color-text-tertiary);
		cursor: pointer;
		padding: 0.2rem;
		border-radius: var(--radius-sm);
	}
	.close-form:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
	}

	.form-preview {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		margin: 0.25rem 0 0.5rem;
	}
	.form-preview img {
		width: 56px;
		height: 42px;
		object-fit: cover;
		border-radius: var(--radius-sm);
		border: 1px solid var(--color-border);
	}
	.form-path {
		font-size: 0.75rem;
		color: var(--color-text-tertiary);
		font-family: var(--font-mono, monospace);
		word-break: break-all;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.field-label {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--color-text-secondary);
	}

	.text-input {
		width: 100%;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-bg-secondary);
		padding: 0.5rem 0.625rem;
		font-size: 0.875rem;
		color: var(--color-text-primary);
		font-family: var(--font-sans);
	}
	.text-input:focus {
		outline: none;
		border-color: var(--color-primary, var(--color-text-primary));
		box-shadow: 0 0 0 3px var(--color-primary-light, rgba(0, 0, 0, 0.06));
	}
	.text-input:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.decorative {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0.5rem 0;
		font-size: 0.8125rem;
		color: var(--color-text-secondary);
		cursor: pointer;
	}

	.form-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 0.75rem;
	}

	:global(.image-dialog .spin) {
		animation: image-dialog-spin 0.8s linear infinite;
	}
	@keyframes image-dialog-spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
