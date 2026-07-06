import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { flushSync } from 'svelte';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import Toaster from './Toaster.svelte';
import { toast, toasts, dismiss } from '$lib/toast.svelte';

// The toast store is a module-level $state array shared across tests. Clear it
// between tests so each starts from an empty toaster.
function clearToasts() {
	toasts.splice(0, toasts.length);
	flushSync();
}

// Push a toast and flush Svelte's scheduler so the DOM reflects the store
// mutation synchronously (the store lives outside the render's reactive tick).
function emit(fn: () => number): number {
	const id = fn();
	flushSync();
	return id;
}

describe('Toaster + toast store', () => {
	beforeEach(() => {
		clearToasts();
	});

	// Restore real timers even if a fake-timer test throws mid-body, so this
	// file can never leak fake timers into the next (the global setup also does
	// this; kept here as a local guarantee for the tests that opt into them).
	afterEach(() => {
		vi.useRealTimers();
	});

	it('renders an error toast with role="alert" and the message', () => {
		render(Toaster);
		emit(() => toast.error('Something broke'));
		const alert = screen.getByRole('alert');
		expect(alert).toHaveTextContent('Something broke');
		expect(alert).toHaveAttribute('aria-live', 'assertive');
	});

	it('renders a success toast with role="status"', () => {
		render(Toaster);
		emit(() => toast.success('Saved'));
		const status = screen.getByRole('status');
		expect(status).toHaveTextContent('Saved');
		expect(status).toHaveAttribute('aria-live', 'polite');
	});

	it('prefixes each toast with a screen-reader-only severity label', () => {
		render(Toaster);
		emit(() => toast.error('Boom'));
		expect(screen.getByText('Error:')).toBeInTheDocument();
	});

	it('error toasts persist (duration 0, no auto-dismiss)', () => {
		vi.useFakeTimers();
		try {
			render(Toaster);
			emit(() => toast.error('Persistent'));
			vi.advanceTimersByTime(60_000);
			flushSync();
			expect(screen.getByRole('alert')).toHaveTextContent('Persistent');
		} finally {
			vi.useRealTimers();
		}
	});

	it('success toasts auto-dismiss after 5s', () => {
		vi.useFakeTimers();
		try {
			render(Toaster);
			emit(() => toast.success('Bye soon'));
			expect(screen.getByRole('status')).toBeInTheDocument();
			vi.advanceTimersByTime(5000);
			flushSync();
			expect(screen.queryByRole('status')).not.toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});

	it('the dismiss button removes the toast', async () => {
		const user = userEvent.setup({ delay: null });
		render(Toaster);
		emit(() => toast.error('Dismiss me'));
		const alert = screen.getByRole('alert');
		const btn = within(alert).getByRole('button', { name: /dismiss notification/i });
		await user.click(btn);
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
	});

	it('Escape on a focused toast dismisses it', async () => {
		const user = userEvent.setup({ delay: null });
		render(Toaster);
		emit(() => toast.error('Esc me'));
		const alert = screen.getByRole('alert');
		alert.focus();
		await user.keyboard('{Escape}');
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
	});

	it('stacks multiple toasts and dismiss() removes only the targeted one', () => {
		render(Toaster);
		const id1 = emit(() => toast.error('First'));
		emit(() => toast.error('Second'));
		expect(screen.getAllByRole('alert')).toHaveLength(2);
		dismiss(id1);
		flushSync();
		const remaining = screen.getAllByRole('alert');
		expect(remaining).toHaveLength(1);
		expect(remaining[0]).toHaveTextContent('Second');
	});

	// SS-23: error toasts persist, so repeated identical failures must not stack
	// unboundedly. Identical messages de-dupe; the total stack is capped.
	describe('SS-23: de-dupe + cap', () => {
		it('pushing the same error twice yields a single toast and the same id', () => {
			render(Toaster);
			const first = emit(() => toast.error('Save failed'));
			const second = emit(() => toast.error('Save failed'));
			expect(second).toBe(first);
			expect(screen.getAllByRole('alert')).toHaveLength(1);
		});

		it('de-dupe is per kind+message, so distinct messages still stack', () => {
			render(Toaster);
			emit(() => toast.error('A'));
			emit(() => toast.error('B'));
			expect(screen.getAllByRole('alert')).toHaveLength(2);
		});

		it('caps the stack at 4, dropping the oldest', () => {
			render(Toaster);
			for (let i = 1; i <= 6; i++) {
				emit(() => toast.error(`err ${i}`));
			}
			const alerts = screen.getAllByRole('alert');
			expect(alerts).toHaveLength(4);
			// The two oldest ("err 1", "err 2") were dropped.
			expect(toasts.map((t) => t.message)).toEqual(['err 3', 'err 4', 'err 5', 'err 6']);
		});
	});

	// SS-24: exactly one live-region layer. The per-toast role/aria-live stays;
	// the container must NOT also be a live region (nested regions double-announce).
	it('SS-24: the container declares no competing aria-live', () => {
		const { container } = render(Toaster);
		emit(() => toast.error('Boom'));
		const toaster = container.querySelector('.toaster');
		expect(toaster).not.toBeNull();
		expect(toaster).not.toHaveAttribute('aria-live');
		// The per-toast live region is still present.
		expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'assertive');
	});
});
