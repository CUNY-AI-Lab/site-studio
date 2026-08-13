<script lang="ts">
	import type { HTMLInputAttributes, HTMLInputTypeAttribute } from "svelte/elements";
	import { cn, type WithElementRef } from "$lib/utils.js";

	type InputType = Exclude<HTMLInputTypeAttribute, "file">;

	type Props = WithElementRef<
		Omit<HTMLInputAttributes, "type"> &
			({ type: "file"; files?: FileList } | { type?: InputType; files?: undefined })
	>;

	let {
		ref = $bindable(null),
		value = $bindable(),
		type,
		files = $bindable(),
		class: className,
		"data-slot": dataSlot = "input",
		...restProps
	}: Props = $props();
</script>

{#if type === "file"}
	<input
		bind:this={ref}
		data-slot={dataSlot}
		class={cn(
			"font-sans selection:bg-primary/20 selection:text-foreground border-[var(--color-text-secondary)] placeholder:text-muted-foreground flex h-10 w-full min-w-0 rounded-none border-2 bg-background px-3.5 pt-2 text-sm font-normal transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50",
			"focus-visible:outline-[3px] focus-visible:outline-solid focus-visible:outline-offset-0 focus-visible:outline-[var(--color-focus)]",
			"aria-invalid:border-destructive",
			className
		)}
		type="file"
		bind:files
		bind:value
		{...restProps}
	/>
{:else}
	<input
		bind:this={ref}
		data-slot={dataSlot}
		class={cn(
			"font-sans border-[var(--color-text-secondary)] bg-background selection:bg-primary/20 selection:text-foreground placeholder:text-muted-foreground flex h-10 w-full min-w-0 rounded-none border-2 px-3.5 py-2 text-base transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
			"focus-visible:outline-[3px] focus-visible:outline-solid focus-visible:outline-offset-0 focus-visible:outline-[var(--color-focus)]",
			"aria-invalid:border-destructive",
			className
		)}
		{type}
		bind:value
		{...restProps}
	/>
{/if}
