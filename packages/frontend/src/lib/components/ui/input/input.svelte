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
			"font-sans selection:bg-primary/20 selection:text-foreground border-input placeholder:text-muted-foreground flex h-10 w-full min-w-0 rounded-md border bg-background px-3.5 pt-2 text-sm font-normal outline-none transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-50",
			"focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-primary/15",
			"aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
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
			"font-sans border-input bg-background selection:bg-primary/20 selection:text-foreground placeholder:text-muted-foreground flex h-10 w-full min-w-0 rounded-md border px-3.5 py-2 text-base outline-none transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
			"focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-primary/15",
			"aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
			className
		)}
		{type}
		bind:value
		{...restProps}
	/>
{/if}
