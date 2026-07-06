<script lang="ts">
	import { CheckCircle2, AlertCircle, Info, X } from 'lucide-svelte';
	import { toasts, dismiss, type ToastKind } from '$lib/toast.svelte';

	const icons = {
		success: CheckCircle2,
		error: AlertCircle,
		info: Info
	} as const;

	function label(kind: ToastKind): string {
		return kind === 'error' ? 'Error' : kind === 'success' ? 'Success' : 'Notice';
	}
</script>

<!--
	SS-24: exactly ONE live-region layer. Each toast carries its own live-region
	semantics (errors assertive via role="alert", info/success polite via
	role="status"); the CONTAINER must NOT also be a live region, or nested live
	regions double-announce in some screen readers. Each toast is
	keyboard-dismissible (button + Esc).
-->
<div class="toaster">
	{#each toasts as t (t.id)}
		{@const Icon = icons[t.kind]}
		<div
			class="toast {t.kind}"
			role={t.kind === 'error' ? 'alert' : 'status'}
			aria-live={t.kind === 'error' ? 'assertive' : 'polite'}
			onkeydown={(e) => e.key === 'Escape' && dismiss(t.id)}
			tabindex="-1"
		>
			<span class="icon" aria-hidden="true">
				<Icon size={18} />
			</span>
			<div class="body">
				<span class="sr-only">{label(t.kind)}:</span>
				<p class="message">{t.message}</p>
			</div>
			<button
				type="button"
				class="dismiss"
				aria-label="Dismiss notification"
				onclick={() => dismiss(t.id)}
			>
				<X size={15} />
			</button>
		</div>
	{/each}
</div>

<style>
	.toaster {
		position: fixed;
		bottom: 1.25rem;
		right: 1.25rem;
		z-index: 9999;
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		max-width: min(24rem, calc(100vw - 2rem));
		pointer-events: none;
	}

	.toast {
		pointer-events: auto;
		display: flex;
		align-items: flex-start;
		gap: 0.625rem;
		padding: 0.75rem 0.75rem 0.75rem 0.875rem;
		border-radius: 12px;
		background: linear-gradient(
			145deg,
			rgba(30, 32, 38, 0.98) 0%,
			rgba(24, 26, 32, 0.98) 100%
		);
		border: 1px solid rgba(255, 255, 255, 0.08);
		box-shadow:
			0 8px 28px rgba(0, 0, 0, 0.4),
			0 0 0 1px rgba(255, 255, 255, 0.03) inset;
		color: #e4e4e7;
		animation: toastIn 0.25s cubic-bezier(0.16, 1, 0.3, 1);
		border-left-width: 3px;
	}

	.toast.success {
		border-left-color: #10b981;
	}
	.toast.error {
		border-left-color: #ef4444;
	}
	.toast.info {
		border-left-color: #14b8a6;
	}

	@keyframes toastIn {
		from {
			opacity: 0;
			transform: translateY(8px) scale(0.98);
		}
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}

	.icon {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		margin-top: 1px;
	}
	.toast.success .icon {
		color: #34d399;
	}
	.toast.error .icon {
		color: #f87171;
	}
	.toast.info .icon {
		color: #5eead4;
	}

	.body {
		flex: 1;
		min-width: 0;
	}

	.message {
		margin: 0;
		font-size: 0.8125rem;
		line-height: 1.45;
		color: #e4e4e7;
		font-family: var(--font-sans);
		word-break: break-word;
	}

	.dismiss {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 24px;
		height: 24px;
		border-radius: 6px;
		border: none;
		background: transparent;
		color: #a1a1aa;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.dismiss:hover {
		background: rgba(255, 255, 255, 0.08);
		color: #e4e4e7;
	}

	.dismiss:focus-visible {
		outline: 2px solid rgba(94, 234, 212, 0.6);
		outline-offset: 1px;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	@media (prefers-reduced-motion: reduce) {
		.toast {
			animation: none;
		}
	}
</style>
