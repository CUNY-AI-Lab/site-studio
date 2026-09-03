<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import Button from '$lib/components/ui/button/button.svelte';
	import { AtSign, Check, Loader2, X } from 'lucide-svelte';
	import {
		checkHandle as checkHandleRequest,
		claimHandle as claimHandleRequest,
		type HandleCheckResult
	} from '$lib/api/handles';
	import { resolvePath } from '$lib/utils/paths';
	import { browserWindow } from '$lib/contracts';

	let {
		open = false,
		onOpenChange,
		onClaimed,
		checkHandle = checkHandleRequest,
		claimHandle = claimHandleRequest
	}: {
		open: boolean;
		onOpenChange: (open: boolean) => void;
		/** Called with the claimed handle after a successful claim. */
		onClaimed: (handle: string) => void;
		checkHandle?: typeof checkHandleRequest;
		claimHandle?: typeof claimHandleRequest;
	} = $props();

	let value = $state('');
	let checking = $state(false);
	let claiming = $state(false);
	let result = $state<HandleCheckResult | null>(null);
	let claimError = $state<string | null>(null);
	let inputEl = $state<HTMLInputElement | null>(null);

	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let checkSeq = 0;

	function invalidateHandleCheck() {
		checkSeq += 1;
		if (debounceTimer !== null) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
	}

	// Preview of the public address. Uses the live origin so it matches reality.
	let origin = $derived(browserWindow()?.location.origin ?? '');
	let previewHandle = $derived(value.trim() || 'your-handle');
	let publicPath = $derived(resolvePath(`/u/${previewHandle}/`));

	// Focus the input when the dialog opens; reset state on close.
	$effect(() => {
		if (!open) {
			invalidateHandleCheck();
			value = '';
			result = null;
			claimError = null;
			checking = false;
			claiming = false;
			return;
		}

		value = '';
		result = null;
		claimError = null;
		checking = false;
		claiming = false;
		// Focus after the dialog content mounts.
		const focusTimer = setTimeout(() => inputEl?.focus(), 30);

		return () => {
			clearTimeout(focusTimer);
			invalidateHandleCheck();
		};
	});

	function onInput(event: Event) {
		// Lowercase as the user types (handles are lowercase-only).
		const target = event.target;
		if (!(target instanceof HTMLInputElement)) return;
		const raw = target.value.toLowerCase();
		value = raw;
		claimError = null;
		result = null;

		if (debounceTimer !== null) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
		const seq = ++checkSeq;
		const trimmed = raw.trim();
		if (trimmed.length === 0) {
			checking = false;
			return;
		}

		checking = true;
		debounceTimer = setTimeout(async () => {
			debounceTimer = null;
			try {
				const res = await checkHandle(trimmed);
				// Ignore stale responses from earlier keystrokes.
				if (seq === checkSeq) {
					result = res;
				}
			} catch {
				if (seq === checkSeq) {
					claimError = "Couldn't check that address. Check your connection and try again.";
				}
			} finally {
				if (seq === checkSeq) checking = false;
			}
		}, 350);
	}

	let canClaim = $derived(
		value.trim().length > 0 && !!result && result.valid && result.available && !claiming
	);

	async function handleClaim() {
		const trimmed = value.trim();
		if (!trimmed || claiming) return;
		claiming = true;
		claimError = null;
		try {
			const res = await claimHandle(trimmed);
			if (res.ok) {
				onClaimed(res.handle);
			} else {
				claimError = res.message;
			}
		} catch (e) {
			claimError = e instanceof Error ? e.message : "We couldn't save that address.";
		} finally {
			claiming = false;
		}
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && canClaim) {
			event.preventDefault();
			void handleClaim();
		}
	}

	// The inline status message + its severity, for the aria-live region.
	let status = $derived.by((): { tone: 'ok' | 'bad' | 'muted'; text: string } | null => {
		if (claimError) return { tone: 'bad', text: claimError };
		if (checking) return { tone: 'muted', text: 'Checking availability…' };
		if (!result || value.trim().length === 0) return null;
		if (!result.valid) return { tone: 'bad', text: result.reason ?? "That address isn't available." };
		if (!result.available) return { tone: 'bad', text: result.reason ?? 'That address is already taken.' };
		return { tone: 'ok', text: 'Available' };
	});
</script>

<Dialog.Root {open} {onOpenChange}>
	<Dialog.Content class="handle-dialog">
		<Dialog.Header>
			<Dialog.Title>Choose your public address</Dialog.Title>
			<Dialog.Description>
				Every site you publish will use this address. You can't change it right now, so choose
				something you'll be happy to share.
			</Dialog.Description>
		</Dialog.Header>

		<div class="field">
			<label class="field-label" for="handle-input">Address</label>
			<div class="input-wrap" class:ok={status?.tone === 'ok'} class:bad={status?.tone === 'bad'}>
				<span class="input-icon" aria-hidden="true"><AtSign size={15} /></span>
				<input
					id="handle-input"
					bind:this={inputEl}
					class="handle-input"
					type="text"
					autocomplete="off"
					autocapitalize="none"
					spellcheck="false"
					placeholder="e.g. jane-rivera"
					aria-describedby="handle-status handle-preview"
					value={value}
					oninput={onInput}
					onkeydown={onKeydown}
				/>
				<span class="input-state" aria-hidden="true">
					{#if checking}
						<Loader2 size={15} class="spin" />
					{:else if status?.tone === 'ok'}
						<Check size={15} />
					{:else if status?.tone === 'bad'}
						<X size={15} />
					{/if}
				</span>
			</div>

			<p id="handle-preview" class="preview">
				{origin}{publicPath}
			</p>

			<p id="handle-status" class="status {status?.tone ?? 'muted'}" aria-live="polite">
				{status?.text ?? ''}
			</p>
		</div>

		<Dialog.Footer class="handle-dialog-footer">
			<Button variant="outline" onclick={() => onOpenChange(false)} disabled={claiming}>
				Cancel
			</Button>
			<Button onclick={handleClaim} disabled={!canClaim}>
				{#if claiming}
					<Loader2 size={15} class="spin" />
					Saving…
				{:else}
					Save and publish
				{/if}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<style>
	.field {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.field-label {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--color-text-secondary);
	}

	.input-wrap {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0 0.625rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		background: var(--color-bg-secondary);
		transition:
			border-color 0.15s ease,
			box-shadow 0.15s ease;
	}

	.input-wrap:focus-within {
		border-color: var(--color-primary, var(--color-text-primary));
		box-shadow: 0 0 0 3px var(--color-primary-light, rgba(0, 0, 0, 0.06));
	}

	.input-wrap.ok {
		border-color: var(--color-success, #16a34a);
	}
	.input-wrap.bad {
		border-color: var(--color-error);
	}

	.input-icon {
		display: flex;
		color: var(--color-text-tertiary);
		flex-shrink: 0;
	}

	.handle-input {
		flex: 1;
		min-width: 0;
		border: none;
		outline: none;
		background: transparent;
		padding: 0.55rem 0;
		font-size: 0.9375rem;
		color: var(--color-text-primary);
		font-family: var(--font-mono, monospace);
	}

	.input-state {
		display: flex;
		flex-shrink: 0;
	}
	.input-wrap.ok .input-state {
		color: var(--color-success, #16a34a);
	}
	.input-wrap.bad .input-state {
		color: var(--color-error);
	}

	.preview {
		margin: 0;
		font-size: 0.75rem;
		color: var(--color-text-tertiary);
		font-family: var(--font-mono, monospace);
		word-break: break-all;
	}
	.status {
		margin: 0;
		min-height: 1.1em;
		font-size: 0.8125rem;
		line-height: 1.35;
	}
	.status.ok {
		color: var(--color-success, #16a34a);
	}
	.status.bad {
		color: var(--color-error);
	}
	.status.muted {
		color: var(--color-text-tertiary);
	}

	:global(.handle-dialog) {
		max-height: calc(100dvh - 2rem);
		overflow-y: auto;
	}

	:global(.handle-dialog-footer) {
		display: flex;
		width: 100%;
		flex-direction: row;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: 0.5rem;
		padding-top: 0.25rem;
	}

	:global(.handle-dialog .spin) {
		animation: handle-spin 0.8s linear infinite;
	}
	@keyframes handle-spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
