<script lang="ts">
    import { resolvePath } from '$lib/utils/paths';
    import { Skeleton } from '$lib/components/ui/skeleton';
    import { fade } from 'svelte/transition';

    let { projectId, onRefresh }: { projectId: string; onRefresh?: () => void } = $props();

    let iframe1: HTMLIFrameElement;
    let iframe2: HTMLIFrameElement;
    let showIframe1 = $state(true);
    let previewUrl = $derived(resolvePath(`/preview/${projectId}/index.html`));
    let refreshKey = $state(0);

    // Loading state tracking
    let isLoading = $state(true); // Start as loading for initial load
    let hasLoadedOnce = $state(false);
    let activeLoadingIframe = $state<1 | 2 | null>(1); // Track which iframe is actively loading (1 for initial load)

    // Dual iframe swap technique to prevent white flash
    export function refresh() {
        isLoading = true; // Show loading skeleton
        refreshKey++;
        const targetIframe = showIframe1 ? iframe2 : iframe1;
        activeLoadingIframe = showIframe1 ? 2 : 1; // Track which iframe we're loading into

        if (targetIframe) {
            // Load new content in hidden iframe
            targetIframe.src = `${previewUrl}?v=${refreshKey}`;
        }

        if (onRefresh) {
            onRefresh();
        }
    }

    function handleIframeLoad(isIframe1: boolean) {
        const iframeNum = isIframe1 ? 1 : 2;

        // Ignore load events from iframes we're not actively loading
        // This prevents about:blank in iframe2 from triggering premature hiding
        if (activeLoadingIframe !== null && activeLoadingIframe !== iframeNum) {
            return;
        }

        // When hidden iframe loads, swap to show it
        if ((isIframe1 && !showIframe1) || (!isIframe1 && showIframe1)) {
            showIframe1 = !showIframe1;

            // Double RAF ensures browser has painted the iframe content
            // Then wait additional time for fonts and initial render
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    setTimeout(() => {
                        isLoading = false;
                        hasLoadedOnce = true;
                        activeLoadingIframe = null; // Clear active loading state
                    }, 200); // Increased from 50ms to 200ms
                });
            });
        } else if (hasLoadedOnce) {
            // Only hide loading on subsequent loads (not first mount)
            isLoading = false;
            activeLoadingIframe = null;
        } else {
            // First load completed
            isLoading = false;
            hasLoadedOnce = true;
            activeLoadingIframe = null;
        }

    }
</script>

<div class="preview">
	<!-- Loading skeleton overlay -->
	{#if isLoading}
		<div class="loading-overlay" transition:fade={{ duration: 150 }}>
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
		bind:this={iframe1}
		src="{previewUrl}?v=0"
		title="Site Preview"
		sandbox="allow-scripts"
		style="display: {showIframe1 ? 'block' : 'none'}; width: 100%; height: 100%; border: none;"
		onload={() => handleIframeLoad(true)}
	></iframe>
	<iframe
		bind:this={iframe2}
		src="about:blank"
		title="Site Preview"
		sandbox="allow-scripts"
		style="display: {showIframe1 ? 'none' : 'block'}; width: 100%; height: 100%; border: none;"
		onload={() => handleIframeLoad(false)}
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
