<script lang="ts">
	import { RefreshCw } from 'lucide-svelte';

	let { projectId, onRefresh }: { projectId: string; onRefresh?: () => void } = $props();

	let iframe1: HTMLIFrameElement;
	let iframe2: HTMLIFrameElement;
	let showIframe1 = $state(true);
	let previewUrl = $derived(`/preview/${projectId}/index.html`);
	let refreshKey = $state(0);

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

	function handleIframeLoad(isIframe1: boolean) {
		// When hidden iframe loads, swap to show it
		if ((isIframe1 && !showIframe1) || (!isIframe1 && showIframe1)) {
			showIframe1 = !showIframe1;
		}
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
