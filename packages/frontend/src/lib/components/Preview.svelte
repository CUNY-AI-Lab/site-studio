<script lang="ts">
    import { resolvePath } from '$lib/utils/paths';
    import { Skeleton } from '$lib/components/ui/skeleton';

    let { projectId, onRefresh }: { projectId: string; onRefresh?: () => void } = $props();

    let previewUrl = $derived(resolvePath(`/preview/${projectId}/index.html`));
    let previewVersion = $state(0);
    let previewSource = $derived(`${previewUrl}?v=${previewVersion}`);

    let isLoading = $state(true);

    export function refresh() {
        isLoading = true;
        previewVersion += 1;
        onRefresh?.();
    }

    function handleIframeLoad(): void {
        isLoading = false;
    }
</script>

<div class="preview">
	<!-- Loading skeleton overlay -->
	{#if isLoading}
		<div class="loading-overlay">
			<Skeleton class="loading-skeleton" />
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
		src={previewSource}
		title="Site Preview"
		sandbox="allow-scripts"
		style="width: 100%; height: 100%; border: none;"
		onload={handleIframeLoad}
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
</style>
