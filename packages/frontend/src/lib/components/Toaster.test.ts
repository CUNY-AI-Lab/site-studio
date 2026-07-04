import { describe, it, expect, beforeEach, vi } from 'vitest';
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
		const user = userEvent.setup();
		render(Toaster);
		emit(() => toast.error('Dismiss me'));
		const alert = screen.getByRole('alert');
		const btn = within(alert).getByRole('button', { name: /dismiss notification/i });
		await user.click(btn);
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
	});

	it('Escape on a focused toast dismisses it', async () => {
		const user = userEvent.setup();
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
});
