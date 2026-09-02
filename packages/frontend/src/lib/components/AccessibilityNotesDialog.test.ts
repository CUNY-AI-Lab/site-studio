import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import AccessibilityNotesDialog from './AccessibilityNotesDialog.svelte';
import type { A11yFinding } from '$lib/api/projects';

function finding(overrides: Partial<A11yFinding> = {}): A11yFinding {
	return {
		file: 'index.html',
		line: 12,
		rule: 'img-alt',
		severity: 'warning',
		message: 'Image is missing alt text',
		...overrides
	};
}

describe('AccessibilityNotesDialog', () => {
	it('shows the finding count in the title (plural)', () => {
		render(AccessibilityNotesDialog, {
			props: {
				open: true,
				findings: [finding(), finding({ severity: 'error' })],
				onOpenChange: () => {}
			}
		});
		expect(screen.getByText(/Published, with 2 accessibility notes/i)).toBeInTheDocument();
	});

	it('uses the singular "note" for a single finding', () => {
		render(AccessibilityNotesDialog, {
			props: {
				open: true,
				findings: [finding()],
				onOpenChange: () => {}
			}
		});
		expect(screen.getByText(/Published, with 1 accessibility note$/i)).toBeInTheDocument();
	});

	it('sorts errors before warnings regardless of input order', () => {
		render(AccessibilityNotesDialog, {
			props: {
				open: true,
				findings: [
					finding({ severity: 'warning', message: 'W-first' }),
					finding({ severity: 'error', message: 'E-second' }),
					finding({ severity: 'warning', message: 'W-third' })
				],
				onOpenChange: () => {}
			}
		});
		const messages = screen.getAllByText(/^[EW]-/).map((el) => el.textContent);
		// Error must come first even though it was second in the input.
		expect(messages[0]).toBe('E-second');
		expect(messages.slice(1)).toEqual(['W-first', 'W-third']);
	});

	it('renders the ask-assistant button and invokes the callback when provided', async () => {
		const user = userEvent.setup({ delay: null });
		const onAskAssistant = vi.fn();
		render(AccessibilityNotesDialog, {
			props: {
				open: true,
				findings: [finding()],
				onOpenChange: () => {},
				onAskAssistant
			}
		});
		const btn = screen.getByRole('button', { name: /ask the assistant to fix these/i });
		await user.click(btn);
		expect(onAskAssistant).toHaveBeenCalledOnce();
	});

	it('renders each finding location as file:line', () => {
		render(AccessibilityNotesDialog, {
			props: {
				open: true,
				findings: [finding({ file: 'about.html', line: 40 }), finding({ file: 'contact.html', line: null })],
				onOpenChange: () => {}
			}
		});
		expect(screen.getByText('about.html:40')).toBeInTheDocument();
		// Null line renders just the file name.
		expect(screen.getByText('contact.html')).toBeInTheDocument();
	});
});
