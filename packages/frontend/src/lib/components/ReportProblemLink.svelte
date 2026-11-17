<script lang="ts">
	import Button from '#lib/components/ui/button/button.svelte';
	import { LifeBuoy } from 'lucide-svelte';

	const REPORT_PROBLEM_URL = 'https://tools.ailab.gc.cuny.edu/help/projects/support/issues/new?topic=other';

	let { iconOnly = false }: { iconOnly?: boolean } = $props();
</script>

<Button
	variant="ghost"
	size={iconOnly ? 'sm' : 'default'}
	href={REPORT_PROBLEM_URL}
	target="_blank"
	rel="noopener noreferrer"
	aria-label={iconOnly ? 'Report a problem' : undefined}
	title={iconOnly ? 'Report a problem' : undefined}
>
	<LifeBuoy size={18} />
	{#if !iconOnly}Report a problem{/if}
</Button>
