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
			"font-mono selection:bg-primary selection:text-primary-foreground border-input ring-offset-background placeholder:text-muted-foreground shadow-sm flex h-9 w-full min-w-0 rounded-sm border-2 bg-background px-3 pt-1.5 text-sm font-medium outline-none transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50",
			"focus-visible:border-primary focus-visible:shadow-md focus-visible:-translate-y-0.5",
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
			"font-mono border-input bg-background selection:bg-primary selection:text-primary-foreground ring-offset-background placeholder:text-muted-foreground shadow-sm flex h-9 w-full min-w-0 rounded-sm border-2 px-3 py-1 text-base outline-none transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
			"focus-visible:border-primary focus-visible:shadow-md focus-visible:-translate-y-0.5",
			"aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
			className
		)}
		{type}
		bind:value
		{...restProps}
	/>
{/if}
