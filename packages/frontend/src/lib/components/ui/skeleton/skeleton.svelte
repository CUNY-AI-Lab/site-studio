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
		background: var(--color-bg-secondary);
		border-radius: var(--radius-md);
	}

	.skeleton::before {
		content: '';
		position: absolute;
		top: 0;
		left: -100%;
		width: 100%;
		height: 100%;
		background: linear-gradient(
			90deg,
			transparent 0%,
			var(--color-bg-tertiary) 50%,
			transparent 100%
		);
		animation: shimmer 2s infinite;
	}

	@keyframes shimmer {
		0% {
			left: -100%;
		}
		100% {
			left: 100%;
		}
	}

	/* Dark mode enhancements */
	@media (prefers-color-scheme: dark) {
		.skeleton {
			background: var(--color-bg-secondary);
		}

		.skeleton::before {
			background: linear-gradient(
				90deg,
				transparent 0%,
				var(--color-bg-tertiary) 50%,
				transparent 100%
			);
		}
	}
</style>
