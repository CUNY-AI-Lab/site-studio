<script lang="ts">
    import { onDestroy } from 'svelte';
    import { resolvePath } from '$lib/utils/paths';
    import { Skeleton } from '$lib/components/ui/skeleton';
    import { fade } from 'svelte/transition';

    let { projectId, onRefresh }: { projectId: string; onRefresh?: () => void } = $props();

    type FrameSlot = 1 | 2;

    let iframe1 = $state<HTMLIFrameElement | null>(null);
    let iframe2 = $state<HTMLIFrameElement | null>(null);
    let showIframe1 = $state(true);
    let previewUrl = $derived(resolvePath(`/preview/${projectId}/index.html`));
    let initialPreviewSource = $derived(`${previewUrl}?v=0`);

    // Every load gets a monotonically increasing generation. A hidden frame is
    // never allowed to become visible just because an older request eventually
    // fired `load` after a faster refresh.
    let refreshGeneration = 0;
    let expectedSource1: string | null = null;
    let expectedSource2: string | null = null;
    let sourceGeneration1 = 0;
    let sourceGeneration2 = 0;
    let disposed = false;
    let loadRequestFrame: number | null = null;
    let paintFrameOne: number | null = null;
    let paintFrameTwo: number | null = null;

    // Loading state tracking
    let isLoading = $state(true); // Start as loading for initial load
    let activeLoadingIframe = $state<1 | 2 | null>(1); // Track which iframe is actively loading (1 for initial load)

    function getIframe(slot: FrameSlot): HTMLIFrameElement | null {
        return slot === 1 ? iframe1 : iframe2;
    }

    function getExpectedSource(slot: FrameSlot): string | null {
        return slot === 1 ? expectedSource1 ?? initialPreviewSource : expectedSource2;
    }

    function getSourceGeneration(slot: FrameSlot): number {
        return slot === 1 ? sourceGeneration1 : sourceGeneration2;
    }

    function setExpectedSource(slot: FrameSlot, source: string | null, generation: number): void {
        if (slot === 1) {
            expectedSource1 = source;
            sourceGeneration1 = generation;
        } else {
            expectedSource2 = source;
            sourceGeneration2 = generation;
        }
    }

    function normalizeSource(source: string): string {
        return new URL(source, globalThis.document.baseURI).href;
    }

    function cancelPaintCommit(): void {
        if (paintFrameOne !== null) {
            cancelAnimationFrame(paintFrameOne);
            paintFrameOne = null;
        }
        if (paintFrameTwo !== null) {
            cancelAnimationFrame(paintFrameTwo);
            paintFrameTwo = null;
        }
    }

    function cancelPendingLoad(): void {
        if (loadRequestFrame !== null) {
            cancelAnimationFrame(loadRequestFrame);
            loadRequestFrame = null;
        }
    }

    function stopFrame(slot: FrameSlot): void {
        const frame = getIframe(slot);
        // Clear the expected source before blanking the frame. The resulting
        // about:blank load must never be mistaken for the preview generation.
        setExpectedSource(slot, null, -1);
        if (frame) frame.src = 'about:blank';
    }

    function schedulePaintCommit(slot: FrameSlot, generation: number, previousSlot: FrameSlot): void {
        cancelPaintCommit();

        paintFrameOne = requestAnimationFrame(() => {
            paintFrameOne = null;
            paintFrameTwo = requestAnimationFrame(() => {
                paintFrameTwo = null;
                if (
                    disposed ||
                    generation !== refreshGeneration ||
                    activeLoadingIframe !== slot
                ) {
                    return;
                }

                // The new frame has had two paint opportunities. Stop the old
                // document only now, after the visible swap, so its
                // scripts/timers/network cannot outlive the active page.
                stopFrame(previousSlot);
                isLoading = false;
                activeLoadingIframe = null;
            });
        });
    }

    // Dual iframe swap technique to prevent white flash. A refresh first
    // blanks the hidden frame to cancel any older request, then schedules the
    // new source on the next frame. This gives each source a clear generation
    // boundary even when refresh is clicked repeatedly.
    export function refresh() {
        isLoading = true; // Show loading skeleton
        const generation = ++refreshGeneration;
        const targetSlot: FrameSlot = showIframe1 ? 2 : 1;
        const targetIframe = getIframe(targetSlot);
        activeLoadingIframe = targetSlot; // Track which iframe we're loading into

        cancelPendingLoad();
        cancelPaintCommit();
        stopFrame(targetSlot);

        loadRequestFrame = requestAnimationFrame(() => {
            loadRequestFrame = null;
            if (disposed || generation !== refreshGeneration || !targetIframe) return;

            const source = `${previewUrl}?v=${generation}`;
            setExpectedSource(targetSlot, source, generation);
            targetIframe.src = source;
        });

        if (onRefresh) {
            onRefresh();
        }
    }

    function handleIframeLoad(slot: FrameSlot, event: Event): void {
        const frame = event.currentTarget;
        if (!(frame instanceof HTMLIFrameElement)) return;

        const expectedSource = getExpectedSource(slot);
        // Ignore about:blank and stale loads. Comparing the actual frame source
        // protects the visible swap from an old response after rapid refreshes.
        if (
            activeLoadingIframe !== slot ||
            expectedSource === null ||
            getSourceGeneration(slot) !== refreshGeneration ||
            normalizeSource(frame.getAttribute('src') ?? '') !== normalizeSource(expectedSource)
        ) {
            return;
        }

        const visibleSlot: FrameSlot = showIframe1 ? 1 : 2;
        if (slot === visibleSlot) {
            // Initial load: there is no old preview to retire. The frame is
            // already visible and its source is the expected generation.
            isLoading = false;
            activeLoadingIframe = null;
            return;
        }

        const previousSlot = visibleSlot;
        showIframe1 = slot === 1;
        schedulePaintCommit(slot, refreshGeneration, previousSlot);
    }

    onDestroy(() => {
        disposed = true;
        cancelPendingLoad();
        cancelPaintCommit();
        activeLoadingIframe = null;
        stopFrame(1);
        stopFrame(2);
    });
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
			src={initialPreviewSource}
			title="Site Preview"
			sandbox="allow-scripts"
			style="display: {showIframe1 ? 'block' : 'none'}; width: 100%; height: 100%; border: none;"
			onload={(event) => handleIframeLoad(1, event)}
		></iframe>
	<iframe
		bind:this={iframe2}
		src="about:blank"
			title="Site Preview"
			sandbox="allow-scripts"
			style="display: {showIframe1 ? 'none' : 'block'}; width: 100%; height: 100%; border: none;"
			onload={(event) => handleIframeLoad(2, event)}
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
