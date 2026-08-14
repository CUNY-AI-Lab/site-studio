<script lang="ts">
	import { type Snippet } from 'svelte';

	interface SkeletonProps {
		class?: string;
		children?: Snippet;
	}

	let { class: className, children }: SkeletonProps = $props();
</script>

<div class="skeleton {className || ''}" data-skeleton>
	{#if children}
		{@render children()}
	{/if}
</div>

<style>
	.skeleton {
		position: relative;
		overflow: hidden;
		background: var(--color-bg-tertiary);
		animation: skeleton-pulse 1.5s ease-in-out infinite;
	}

	@keyframes skeleton-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.5;
		}
	}
</style>
