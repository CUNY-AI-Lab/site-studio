<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import type { ComponentType } from 'svelte';

	interface Props {
		title: string;
		description: string;
		icon: ComponentType;
		gradient: string;
		onclick?: () => void;
		disabled?: boolean;
	}

	let { title, description, icon: Icon, gradient, onclick, disabled = false }: Props = $props();
</script>

<button
	class="template-card"
	class:disabled
	onclick={onclick}
	{disabled}
	type="button"
>
	<Card.Root class="card-inner">
		<Card.Content class="card-content">
			<div class="icon-container" style="background: {gradient};">
				<Icon size={32} strokeWidth={1.5} />
			</div>
			<div class="content">
				<Card.Title class="title">{title}</Card.Title>
				<Card.Description class="description">{description}</Card.Description>
			</div>
			<div class="arrow">
				<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
					<path d="M7.5 15L12.5 10L7.5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</div>
		</Card.Content>
	</Card.Root>
</button>

<style>
	.template-card {
		all: unset;
		cursor: pointer;
		transition: all 0.2s ease;
		width: 100%;
		box-sizing: border-box;
		display: block;
	}

	.template-card:hover:not(.disabled) {
		transform: translateY(-2px);
	}

	.template-card:active:not(.disabled) {
		transform: translateY(0);
	}

	.template-card.disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	:global(.template-card .card-inner) {
		transition: all 0.2s ease;
		border-width: 2px;
	}

	:global(.template-card:hover:not(.disabled) .card-inner) {
		border-color: hsl(var(--primary));
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
	}

	:global(.card-content) {
		display: flex;
		align-items: center;
		gap: 1.5rem;
		padding: 1.5rem !important;
	}

	.icon-container {
		flex-shrink: 0;
		width: 64px;
		height: 64px;
		border-radius: 12px;
		display: flex;
		align-items: center;
		justify-content: center;
		color: white;
	}

	.content {
		flex: 1;
		text-align: left;
	}

	:global(.title) {
		font-size: 1.125rem;
		margin-bottom: 0.5rem;
	}

	:global(.description) {
		font-size: 0.875rem;
	}

	.arrow {
		flex-shrink: 0;
		color: hsl(var(--muted-foreground));
		transition: transform 0.2s ease, color 0.2s ease;
	}

	.template-card:hover:not(.disabled) .arrow {
		transform: translateX(4px);
		color: hsl(var(--primary));
	}
</style>
