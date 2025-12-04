<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";

	let {
		ref = $bindable(null),
		class: className,
		inset,
		variant = "default",
		...restProps
	}: DropdownMenuPrimitive.ItemProps & {
		inset?: boolean;
		variant?: "default" | "destructive";
	} = $props();
</script>

<DropdownMenuPrimitive.Item
	bind:ref
	data-slot="dropdown-menu-item"
	data-inset={inset}
	data-variant={variant}
	class={cn(
		"dropdown-menu-item outline-hidden relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm data-[disabled]:pointer-events-none data-[inset]:pl-8 data-[disabled]:opacity-50 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
		className
	)}
	{...restProps}
/>

<style>
	:global(.dropdown-menu-item) {
		color: var(--color-text-primary, #1f2937);
		background: transparent;
		transition: background 0.15s ease, color 0.15s ease;
	}

	:global(.dropdown-menu-item:hover),
	:global(.dropdown-menu-item[data-highlighted]) {
		background: var(--color-bg-secondary, #f5f4f1);
		color: var(--color-text-primary, #1f2937);
	}

	:global(.dropdown-menu-item[data-variant="destructive"]) {
		color: var(--color-error, #dc2626);
	}

	:global(.dropdown-menu-item[data-variant="destructive"]:hover),
	:global(.dropdown-menu-item[data-variant="destructive"][data-highlighted]) {
		background: var(--color-error-light, #fef2f2);
		color: var(--color-error, #dc2626);
	}

	:global(.dropdown-menu-item svg) {
		color: var(--color-text-tertiary, #6b7280);
	}
</style>
