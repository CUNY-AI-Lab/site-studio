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
		border: 1px solid var(--color-border, #e2e0db);
		border-radius: var(--radius-lg, 0.75rem);
		padding: 0.375rem;
		box-shadow: var(--shadow-lg, 0 10px 15px -3px rgba(0, 0, 0, 0.1));
		max-height: var(--bits-dropdown-menu-content-available-height, 300px);
	}
</style>
