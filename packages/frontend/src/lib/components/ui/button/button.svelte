<script lang="ts" module>
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from "svelte/elements";

	const baseClasses = "aria-invalid:border-destructive inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-none no-underline text-sm font-medium font-sans transition-colors duration-200 disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0 border border-transparent cursor-pointer";
	const variantClasses = {
		default: "bg-primary text-primary-foreground hover:bg-[var(--color-primary-hover)]",
		destructive: "bg-destructive text-destructive-foreground hover:brightness-90",
		outline: "bg-background hover:bg-muted border-border",
		secondary: "bg-secondary text-secondary-foreground hover:bg-[var(--color-secondary-hover)]",
		ghost: "hover:bg-muted hover:text-foreground border-transparent",
		link: "text-primary underline decoration-2 underline-offset-2 hover:decoration-[3px]",
	} as const;
	const sizeClasses = {
		default: "h-10 px-5 py-2.5 has-[>svg]:px-4",
		sm: "h-8 gap-1.5 px-3 has-[>svg]:px-2.5 text-xs",
		lg: "h-11 px-7 has-[>svg]:px-5 text-base",
		icon: "size-10",
		"icon-sm": "size-8",
		"icon-lg": "size-11",
	} as const;

	type ButtonVariant = keyof typeof variantClasses;
	type ButtonSize = keyof typeof sizeClasses;
	const buttonClasses = (variant: ButtonVariant, size: ButtonSize) =>
		cn(baseClasses, variantClasses[variant], sizeClasses[size]);

	type ButtonProps = WithElementRef<HTMLButtonAttributes> &
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
		class={cn(buttonClasses(variant, size), className)}
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
		class={cn(buttonClasses(variant, size), className)}
		{type}
		{disabled}
		{...restProps}
	>
		{@render children?.()}
	</button>
{/if}
