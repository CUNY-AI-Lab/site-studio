import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import HandleClaimDialog from './HandleClaimDialog.svelte';
import { checkHandle, claimHandle } from '$lib/api/handles';

// Mock at the api-module boundary. The component debounces checkHandle by 350ms;
// we drive that with fake timers where needed.
vi.mock('$lib/api/handles', () => ({
	checkHandle: vi.fn(),
	claimHandle: vi.fn()
}));

const mockCheck = vi.mocked(checkHandle);
const mockClaim = vi.mocked(claimHandle);

describe('HandleClaimDialog', () => {
	beforeEach(() => {
		mockCheck.mockReset();
		mockClaim.mockReset();
	});

	function open(overrides: Record<string, unknown> = {}) {
		const onOpenChange = vi.fn();
		const onClaimed = vi.fn();
		render(HandleClaimDialog, {
			props: { open: true, onOpenChange, onClaimed, ...overrides }
		});
		return { onOpenChange, onClaimed };
	}

	it('has an aria-live status region wired to the input', () => {
		open();
		const status = document.getElementById('handle-status');
		expect(status).not.toBeNull();
		expect(status).toHaveAttribute('aria-live', 'polite');
		const input = screen.getByLabelText('Address');
		expect(input).toHaveAttribute('aria-describedby', expect.stringContaining('handle-status'));
	});

	it('lowercases the handle as the user types', async () => {
		const user = userEvent.setup({ delay: null });
		mockCheck.mockResolvedValue({ handle: 'jane', valid: true, available: true });
		open();
		const input = screen.getByLabelText('Address') as HTMLInputElement;
		await user.type(input, 'JaNe');
		expect(input.value).toBe('jane');
	});

	it('shows the invalid reason when the handle is not valid', async () => {
		vi.useFakeTimers();
		try {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockCheck.mockResolvedValue({
				handle: 'no!',
				valid: false,
				available: false,
				reason: 'Only letters, numbers and dashes are allowed.'
			});
			open();
			const input = screen.getByLabelText('Address');
			await user.type(input, 'no');
			await vi.advanceTimersByTimeAsync(400);
			expect(screen.getByText('Only letters, numbers and dashes are allowed.')).toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});

	it('shows "taken" when valid but unavailable', async () => {
		vi.useFakeTimers();
		try {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockCheck.mockResolvedValue({
				handle: 'taken',
				valid: true,
				available: false,
				reason: 'That handle is taken.'
			});
			open();
			await user.type(screen.getByLabelText('Address'), 'taken');
			await vi.advanceTimersByTimeAsync(400);
			expect(screen.getByText('That handle is taken.')).toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});

	it('explains how to recover when the availability check fails', async () => {
		vi.useFakeTimers();
		try {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockCheck.mockRejectedValue(new TypeError('network down'));
			open();
			await user.type(screen.getByLabelText('Address'), 'jane');
			await vi.advanceTimersByTimeAsync(400);
			expect(
				screen.getByText("Couldn't check that address. Check your connection and try again.")
			).toBeInTheDocument();
			expect(screen.getByRole('button', { name: /claim and publish/i })).toBeDisabled();
		} finally {
			vi.useRealTimers();
		}
	});

	it('shows "Available" and enables the claim button when valid + available', async () => {
		vi.useFakeTimers();
		try {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockCheck.mockResolvedValue({ handle: 'open', valid: true, available: true });
			open();
			await user.type(screen.getByLabelText('Address'), 'open');
			await vi.advanceTimersByTimeAsync(400);
			expect(screen.getByText('Available')).toBeInTheDocument();
			expect(screen.getByRole('button', { name: /claim and publish/i })).toBeEnabled();
		} finally {
			vi.useRealTimers();
		}
	});

	it('claim success invokes onClaimed with the returned handle', async () => {
		vi.useFakeTimers();
		try {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockCheck.mockResolvedValue({ handle: 'jane', valid: true, available: true });
			mockClaim.mockResolvedValue({ ok: true, handle: 'jane', alreadyOwned: false });
			const { onClaimed } = open();
			await user.type(screen.getByLabelText('Address'), 'jane');
			await vi.advanceTimersByTimeAsync(400);
			await user.click(screen.getByRole('button', { name: /claim and publish/i }));
			await vi.waitFor(() => expect(onClaimed).toHaveBeenCalledWith('jane'));
		} finally {
			vi.useRealTimers();
		}
	});

	it('claim failure surfaces the returned message inline', async () => {
		vi.useFakeTimers();
		try {
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			mockCheck.mockResolvedValue({ handle: 'jane', valid: true, available: true });
			mockClaim.mockResolvedValue({ ok: false, message: 'Someone grabbed it first.' });
			const { onClaimed } = open();
			await user.type(screen.getByLabelText('Address'), 'jane');
			await vi.advanceTimersByTimeAsync(400);
			await user.click(screen.getByRole('button', { name: /claim and publish/i }));
			await vi.waitFor(() => expect(screen.getByText('Someone grabbed it first.')).toBeInTheDocument());
			expect(onClaimed).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it('leaves the claim button disabled until a check confirms availability', () => {
		open();
		expect(screen.getByRole('button', { name: /claim and publish/i })).toBeDisabled();
	});
});
