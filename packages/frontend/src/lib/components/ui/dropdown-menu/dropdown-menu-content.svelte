<script lang="ts">
	import { cn } from "$lib/utils.js";
	import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";

	let {
		ref = $bindable(null),
		sideOffset = 4,
		portalProps,
		class: className,
		...restProps
	}: DropdownMenuPrimitive.ContentProps & {
		portalProps?: DropdownMenuPrimitive.PortalProps;
	} = $props();
</script>

<DropdownMenuPrimitive.Portal {...portalProps}>
	<DropdownMenuPrimitive.Content
		bind:ref
		data-slot="dropdown-menu-content"
		{sideOffset}
		class={cn(
			"dropdown-menu-content data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-y-auto overflow-x-hidden outline-none",
			className
		)}
		{...restProps}
	/>
</DropdownMenuPrimitive.Portal>

<style>
	:global(.dropdown-menu-content) {
		background: var(--color-bg-elevated, #ffffff);
		color: var(--color-text-primary, #1f2937);
		border: 1px solid var(--color-border-hover, #cbd2dc);
		border-top: 3px solid var(--color-navy, #1d3a83);
		padding: 0.375rem;
		max-height: var(--bits-dropdown-menu-content-available-height, 300px);
	}
</style>
