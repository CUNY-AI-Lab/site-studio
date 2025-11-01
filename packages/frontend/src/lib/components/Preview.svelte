<script lang="ts">
    import { RefreshCw } from 'lucide-svelte';
    import { toPng } from 'html-to-image';
    import { uploadThumbnail } from '$lib/api/projects';

    let { projectId, onRefresh }: { projectId: string; onRefresh?: () => void } = $props();

    let iframe1: HTMLIFrameElement;
    let iframe2: HTMLIFrameElement;
    let showIframe1 = $state(true);
    let previewUrl = $derived(`/preview/${projectId}/index.html`);
    let refreshKey = $state(0);

    // Simple throttle to avoid frequent uploads
    let lastCaptureAt = 0;
    const CAPTURE_THROTTLE_MS = 60_000; // 1 minute
    let capturing = false;
    let forceNextCapture = false;

    // Dual iframe swap technique to prevent white flash
    export function refresh() {
        refreshKey++;
        const targetIframe = showIframe1 ? iframe2 : iframe1;

        if (targetIframe) {
            // Load new content in hidden iframe
            targetIframe.src = `${previewUrl}?v=${refreshKey}`;
        }

        if (onRefresh) {
            onRefresh();
        }
    }

    async function tryCaptureAndUpload(ignoreThrottle = false) {
        const now = Date.now();
        if (capturing || (!ignoreThrottle && now - lastCaptureAt < CAPTURE_THROTTLE_MS)) return;

        // Choose the visible iframe after any swap
        const activeIframe = showIframe1 ? iframe1 : iframe2;
        if (!activeIframe || !activeIframe.contentDocument) return;

        const root = activeIframe.contentDocument.documentElement;
        if (!root) return;

        capturing = true;
        try {
            // Give the page a moment to settle for consistent thumbnails
            await new Promise((r) => setTimeout(r, 250));
            const dataUrl = await toPng(root, {
                cacheBust: true,
                pixelRatio: 1,
                // Prefer viewport-like captures; full page can be huge
                // width/height omitted to use node size
            });
            const blob = await (await fetch(dataUrl)).blob();
            // Must be PNG to match backend expectations
            if (blob.type !== 'image/png') {
                // Convert by re-encoding: create canvas from image
                // Fallback: still upload; backend enforces PNG and will reject
            }
            await uploadThumbnail(projectId, blob);
            lastCaptureAt = Date.now();
        } catch (err) {
            // Non-fatal: just skip errors
            console.warn('Thumbnail capture/upload failed:', err);
        } finally {
            capturing = false;
        }
    }

    function handleIframeLoad(isIframe1: boolean) {
        // When hidden iframe loads, swap to show it
        if ((isIframe1 && !showIframe1) || (!isIframe1 && showIframe1)) {
            showIframe1 = !showIframe1;
        }

        // Attempt a thumbnail capture after each load
        // Delay slightly to allow layout and fonts to settle
        setTimeout(() => {
            const ignore = forceNextCapture;
            forceNextCapture = false;
            tryCaptureAndUpload(ignore);
        }, 200);
    }

    // Helper: request an immediate thumbnail capture on next load
    // This forces bypassing the throttle once
    export function requestThumbnailCapture() {
        forceNextCapture = true;
        refresh();
    }
</script>

<div class="preview">
	<iframe
		bind:this={iframe1}
		src="{previewUrl}?v=0"
		title="Site Preview"
		sandbox="allow-scripts allow-same-origin"
		style="display: {showIframe1 ? 'block' : 'none'}; width: 100%; height: 100%; border: none;"
		onload={() => handleIframeLoad(true)}
	></iframe>
	<iframe
		bind:this={iframe2}
		src="about:blank"
		title="Site Preview"
		sandbox="allow-scripts allow-same-origin"
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
</style>
