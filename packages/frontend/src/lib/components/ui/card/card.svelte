<script lang="ts">
	import type { HTMLAttributes } from "svelte/elements";
	import { cn, type WithElementRef } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div
	bind:this={ref}
	data-slot="card"
	class={cn(
		"bg-card text-card-foreground flex flex-col gap-5 rounded-lg border border-border p-6 shadow-sm transition-all duration-200 hover:shadow-md hover:border-border/80",
		className
	)}
	{...restProps}
>
	{@render children?.()}
</div>
