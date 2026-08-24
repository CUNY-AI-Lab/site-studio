<script lang="ts">
	import { resolvePath } from '$lib/utils/paths';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { RefreshCw } from 'lucide-svelte';
	import { z } from 'zod';

	let { projectId }: { projectId: string } = $props();

	const PREVIEW_NAVIGATION_TIMEOUT_MS = 15_000;
	const previewReadyMessageSchema = z.object({
		type: z.literal('site-studio-preview-ready'),
		token: z.string()
	});

	let previewUrl = $derived(resolvePath(`/preview/${projectId}/index.html`));
	let previewVersion = $state(0);
	let previewReadyToken = $derived(String(previewVersion));
	let previewSource = $derived(`${previewUrl}?v=${previewVersion}&ready=${previewReadyToken}`);
	let navigationState = $state<'loading' | 'ready' | 'failed'>('loading');
	let previewFrame = $state<HTMLIFrameElement>();

	$effect(() => {
		const activeSource = previewSource;
		navigationState = 'loading';
		const timeout = setTimeout(() => {
			if (previewSource === activeSource && navigationState === 'loading') {
				navigationState = 'failed';
			}
		}, PREVIEW_NAVIGATION_TIMEOUT_MS);

		return () => clearTimeout(timeout);
	});

	$effect(() => {
		const activeToken = previewReadyToken;
		function handlePreviewReady(event: MessageEvent): void {
			if (event.source !== previewFrame?.contentWindow) return;
			const message = previewReadyMessageSchema.safeParse(event.data);
			if (!message.success || message.data.token !== activeToken) return;
			navigationState = 'ready';
		}

		window.addEventListener('message', handlePreviewReady);
		return () => window.removeEventListener('message', handlePreviewReady);
	});

	export function refresh() {
		previewVersion += 1;
	}

	function handleIframeError(): void {
		navigationState = 'failed';
	}
</script>

<div class="preview">
	<!-- Loading skeleton overlay -->
	{#if navigationState === 'loading'}
		<div class="loading-overlay">
			<Skeleton class="loading-skeleton" />
		</div>
	{:else if navigationState === 'failed'}
		<div class="preview-error" role="alert">
			<p class="preview-error-title">The preview could not be loaded.</p>
			<p class="preview-error-detail">Your site is still saved. Try loading the preview again.</p>
			<button class="preview-retry" type="button" onclick={refresh}>
				<RefreshCw size={15} />
				Retry preview
			</button>
		</div>
	{/if}

	<!--
		§3¾ active-content invariant: the preview server now sends
		`Content-Security-Policy: sandbox allow-scripts` (no allow-same-origin),
		so the framed document is opaque-origin regardless of this attribute. We
		drop `allow-same-origin` here too for consistency and to make the
		containment explicit — the preview still renders, but the parent can no
		longer read `contentDocument` (it is cross-origin once opaque).
	-->
	<iframe
		bind:this={previewFrame}
		src={previewSource}
		title="Site Preview"
		sandbox="allow-scripts"
		style="width: 100%; height: 100%; border: none;"
		onerror={handleIframeError}
	></iframe>
</div>

<style>
	.preview {
		height: 100%;
		background: #fff;
		position: relative;
	}

	.loading-overlay {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: var(--z-overlay);
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--color-bg-primary);
	}

	.loading-overlay :global(.loading-skeleton) {
		width: 100%;
		height: 100%;
		border-radius: 0;
	}

	.preview-error {
		position: absolute;
		inset: 0;
		z-index: var(--z-overlay);
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		padding: 2rem;
		text-align: center;
		background: var(--color-bg-primary);
	}

	.preview-error-title,
	.preview-error-detail {
		margin: 0;
	}

	.preview-error-title {
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.preview-error-detail {
		max-width: 28rem;
		color: var(--color-text-secondary);
		line-height: 1.5;
	}

	.preview-retry {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.625rem 0.95rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-bg-secondary);
		color: var(--color-text-primary);
		cursor: pointer;
	}

	.preview-retry:hover {
		background: var(--color-bg-tertiary);
		border-color: var(--color-border-hover);
	}
</style>
