<script lang="ts" module>
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from "svelte/elements";
	import { type VariantProps, tv } from "tailwind-variants";

	export const buttonVariants = tv({
		base: "focus-visible:ring-ring/30 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium font-sans outline-none transition-all duration-200 focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0 border border-transparent cursor-pointer",
		variants: {
			variant: {
				default: "bg-primary text-primary-foreground shadow-sm hover:shadow-md hover:brightness-110 active:shadow-none active:brightness-95",
				destructive:
					"bg-destructive shadow-sm hover:shadow-md hover:brightness-110 active:shadow-none active:brightness-95 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 text-destructive-foreground",
				outline:
					"bg-background shadow-xs hover:shadow-sm hover:bg-muted hover:border-border/80 border-border active:shadow-none",
				secondary: "bg-secondary text-secondary-foreground shadow-sm hover:shadow-md hover:brightness-110 active:shadow-none active:brightness-95",
				ghost: "hover:bg-muted hover:text-foreground shadow-none border-transparent",
				link: "text-primary underline-offset-4 hover:underline shadow-none",
			},
			size: {
				default: "h-10 px-5 py-2.5 has-[>svg]:px-4",
				sm: "h-8 gap-1.5 px-3 has-[>svg]:px-2.5 text-xs",
				lg: "h-11 px-7 has-[>svg]:px-5 text-base",
				icon: "size-10",
				"icon-sm": "size-8",
				"icon-lg": "size-11",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	});

	export type ButtonVariant = VariantProps<typeof buttonVariants>["variant"];
	export type ButtonSize = VariantProps<typeof buttonVariants>["size"];

	export type ButtonProps = WithElementRef<HTMLButtonAttributes> &
		WithElementRef<HTMLAnchorAttributes> & {
			variant?: ButtonVariant;
			size?: ButtonSize;
		};
</script>

<script lang="ts">
	let {
		class: className,
		variant = "default",
		size = "default",
		ref = $bindable(null),
		href = undefined,
		type = "button",
		disabled,
		children,
		...restProps
	}: ButtonProps = $props();
</script>

{#if href}
	<a
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		href={disabled ? undefined : href}
		aria-disabled={disabled}
		role={disabled ? "link" : undefined}
		tabindex={disabled ? -1 : undefined}
		{...restProps}
	>
		{@render children?.()}
	</a>
{:else}
	<button
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		{type}
		{disabled}
		{...restProps}
	>
		{@render children?.()}
	</button>
{/if}
