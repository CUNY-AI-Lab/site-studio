<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import Button from '$lib/components/ui/button/button.svelte';
	import { AlertCircle, AlertTriangle, Sparkles } from 'lucide-svelte';
	import type { A11yFinding } from '$lib/api/projects';

	let {
		open = false,
		findings = [],
		onOpenChange,
		onAskAssistant
	}: {
		open: boolean;
		findings: A11yFinding[];
		onOpenChange: (open: boolean) => void;
		/** When provided, renders an "Ask the assistant to fix these" button. */
		onAskAssistant?: () => void;
	} = $props();

	// Errors first, then warnings; stable within each group.
	let sorted = $derived(
		[...findings].sort((a, b) => {
			if (a.severity === b.severity) return 0;
			return a.severity === 'error' ? -1 : 1;
		})
	);

	let count = $derived(findings.length);

	function location(f: A11yFinding): string {
		return f.line != null ? `${f.file}:${f.line}` : f.file;
	}
</script>

<Dialog.Root {open} {onOpenChange}>
	<Dialog.Content class="a11y-dialog">
		<Dialog.Header>
			<Dialog.Title>
				Published, with {count} accessibility {count === 1 ? 'note' : 'notes'}
			</Dialog.Title>
			<Dialog.Description>
				Your site is live. These fixes would make it work better for more visitors.
			</Dialog.Description>
		</Dialog.Header>

		<ul class="findings">
			{#each sorted as f}
				<li class="finding {f.severity}">
					<span class="sev-icon" aria-hidden="true">
						{#if f.severity === 'error'}
							<AlertCircle size={16} />
						{:else}
							<AlertTriangle size={16} />
						{/if}
					</span>
					<div class="finding-body">
						<div class="finding-top">
							<span class="sev-badge {f.severity}">{f.severity}</span>
							<code class="loc">{location(f)}</code>
						</div>
						<p class="finding-message">{f.message}</p>
					</div>
				</li>
			{/each}
		</ul>

		<Dialog.Footer>
			{#if onAskAssistant}
				<Button variant="outline" onclick={onAskAssistant}>
					<Sparkles size={15} />
					Ask the assistant to fix these
				</Button>
			{/if}
			<Button onclick={() => onOpenChange(false)}>Got it</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<style>
	.findings {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		max-height: 45vh;
		overflow-y: auto;
	}

	.finding {
		display: flex;
		gap: 0.625rem;
		padding: 0.625rem 0.75rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		background: var(--color-bg-secondary);
	}

	.finding.error {
		border-left: 3px solid var(--color-error);
	}
	.finding.warning {
		border-left: 3px solid var(--color-warning);
	}

	.sev-icon {
		flex-shrink: 0;
		margin-top: 1px;
	}
	.finding.error .sev-icon {
		color: var(--color-error);
	}
	.finding.warning .sev-icon {
		color: var(--color-warning);
	}

	.finding-body {
		min-width: 0;
		flex: 1;
	}

	.finding-top {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.2rem;
	}

	.sev-badge {
		font-size: 0.625rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		padding: 0.1rem 0.375rem;
		border-radius: var(--radius-sm);
	}
	.sev-badge.error {
		background: var(--color-error-light);
		color: var(--color-error);
	}
	.sev-badge.warning {
		background: var(--color-warning-light);
		color: var(--color-warning);
	}

	.loc {
		font-size: 0.75rem;
		color: var(--color-text-tertiary);
		font-family: var(--font-mono, monospace);
		word-break: break-all;
	}

	.finding-message {
		margin: 0;
		font-size: 0.8125rem;
		line-height: 1.45;
		color: var(--color-text-secondary);
	}
</style>
