import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import ImageManagerDialog from './ImageManagerDialog.svelte';
import { fetchProjectImages, type ProjectImagesResult } from '$lib/api/projects';

// Mock the api module boundary — the dialog fetches images when it opens.
vi.mock('$lib/api/projects', async () => {
	const actual = await vi.importActual<typeof import('$lib/api/projects')>('$lib/api/projects');
	return {
		...actual,
		fetchProjectImages: vi.fn(),
		uploadProjectImage: vi.fn()
	};
});

const mockFetch = vi.mocked(fetchProjectImages);

const imagesResult: ProjectImagesResult = {
	images: [
		{ path: 'images/one.png', size: 1024 },
		{ path: 'images/two.jpg', size: 2048 }
	],
	placeholders: [
		{ file: 'index.html', line: 20, message: 'Gray placeholder box', src: 'https://placehold.co/600' }
	]
};

function open(overrides: Record<string, unknown> = {}) {
	const onOpenChange = vi.fn();
	const onAskAssistant = vi.fn();
	render(ImageManagerDialog, {
		props: {
			open: true,
			projectId: 'proj1',
			onOpenChange,
			onAskAssistant,
			...overrides
		}
	});
	return { onOpenChange, onAskAssistant };
}

async function waitForImages() {
	await waitFor(() => expect(screen.getByText('images/one.png')).toBeInTheDocument());
}

// The two thumbnails share a title/accessible-name, so select by index. Index 0
// is images/one.png, index 1 is images/two.jpg.
function thumbnail(index: number): HTMLElement {
	const buttons = screen.getAllByRole('button', {
		name: /insert this image|use this image for the replacement/i
	});
	return buttons[index];
}

describe('ImageManagerDialog', () => {
	beforeEach(() => {
		mockFetch.mockReset();
		mockFetch.mockResolvedValue(imagesResult);
	});

	it('loads and lists the project images when opened', async () => {
		open();
		await waitForImages();
		expect(screen.getByText('images/two.jpg')).toBeInTheDocument();
		expect(mockFetch).toHaveBeenCalledWith('proj1');
	});

	describe('alt-text validation', () => {
		it('disables the insert button until alt text is entered', async () => {
			const user = userEvent.setup();
			open();
			await waitForImages();
			// Open the insert form by selecting a thumbnail.
			await user.click(thumbnail(0));

			const insertBtn = screen.getByRole('button', { name: /insert with the assistant/i });
			expect(insertBtn).toBeDisabled();

			await user.type(screen.getByLabelText(/describe this image/i), 'A photo');
			expect(insertBtn).toBeEnabled();
		});

		it('marking decorative empties and disables the alt input and enables submit', async () => {
			const user = userEvent.setup();
			open();
			await waitForImages();
			await user.click(thumbnail(0));

			const altInput = screen.getByLabelText(/describe this image/i) as HTMLInputElement;
			await user.type(altInput, 'some alt');
			expect(altInput.value).toBe('some alt');

			await user.click(screen.getByRole('checkbox', { name: /this image is decorative/i }));
			expect(altInput.value).toBe('');
			expect(altInput).toBeDisabled();
			expect(screen.getByRole('button', { name: /insert with the assistant/i })).toBeEnabled();
		});
	});

	describe('the switch-while-scoped regression', () => {
		it('switching thumbnails during a replacement keeps the placeholder scope and typed alt text', async () => {
			const user = userEvent.setup();
			const { onAskAssistant } = open();
			await waitForImages();

			// Start a replacement scoped to the placeholder (uses images[0]).
			await user.click(screen.getByRole('button', { name: /^replace$/i }));
			expect(screen.getByText(/replace placeholder with this image/i)).toBeInTheDocument();

			// Type alt text into the scoped form.
			await user.type(screen.getByLabelText(/describe this image/i), 'Team photo');

			// Now click the OTHER thumbnail to switch which image replaces the placeholder.
			await user.click(thumbnail(1));

			// Still in replace mode (scope kept) and the typed alt text survived.
			expect(screen.getByText(/replace placeholder with this image/i)).toBeInTheDocument();
			expect((screen.getByLabelText(/describe this image/i) as HTMLInputElement).value).toBe('Team photo');

			// Submitting produces a REPLACE prompt with the newly-selected image path.
			await user.click(screen.getByRole('button', { name: /replace with the assistant/i }));
			expect(onAskAssistant).toHaveBeenCalledWith(
				'Replace the placeholder image at index.html:20 with images/two.jpg and set its alt text to "Team photo".'
			);
		});

		it('cancel clears the replacement scope back to plain insertion', async () => {
			const user = userEvent.setup();
			open();
			await waitForImages();

			await user.click(screen.getByRole('button', { name: /^replace$/i }));
			expect(screen.getByText(/replace placeholder with this image/i)).toBeInTheDocument();

			// Two elements are named "Cancel": the header X (title="Cancel") and the
			// footer ghost button. Click the footer one (last in DOM order).
			const cancels = screen.getAllByRole('button', { name: /^cancel$/i });
			await user.click(cancels[cancels.length - 1]);

			// Form is closed; selecting a thumbnail now opens the plain insert form.
			await user.click(thumbnail(0));
			expect(screen.getByText(/add this image to your site/i)).toBeInTheDocument();
			// Insert form offers the location hint field that replace mode hides.
			expect(screen.getByLabelText(/where should it go/i)).toBeInTheDocument();
		});
	});

	describe('exact prompt strings for all four combos', () => {
		it('insert + described', async () => {
			const user = userEvent.setup();
			const { onAskAssistant } = open();
			await waitForImages();
			await user.click(thumbnail(0));
			await user.type(screen.getByLabelText(/describe this image/i), 'A student poster');
			await user.click(screen.getByRole('button', { name: /insert with the assistant/i }));
			expect(onAskAssistant).toHaveBeenCalledWith(
				'Insert images/one.png into the site. Use alt text: "A student poster".'
			);
		});

		it('insert + decorative', async () => {
			const user = userEvent.setup();
			const { onAskAssistant } = open();
			await waitForImages();
			await user.click(thumbnail(0));
			await user.click(screen.getByRole('checkbox', { name: /this image is decorative/i }));
			await user.click(screen.getByRole('button', { name: /insert with the assistant/i }));
			expect(onAskAssistant).toHaveBeenCalledWith(
				'Insert images/one.png into the site. It is decorative, so use alt="".'
			);
		});

		it('insert + described with a location hint', async () => {
			const user = userEvent.setup();
			const { onAskAssistant } = open();
			await waitForImages();
			await user.click(thumbnail(0));
			await user.type(screen.getByLabelText(/describe this image/i), 'A photo');
			await user.type(screen.getByLabelText(/where should it go/i), 'top of About page');
			await user.click(screen.getByRole('button', { name: /insert with the assistant/i }));
			expect(onAskAssistant).toHaveBeenCalledWith(
				'Insert images/one.png into the site (top of About page). Use alt text: "A photo".'
			);
		});

		it('replace + described', async () => {
			const user = userEvent.setup();
			const { onAskAssistant } = open();
			await waitForImages();
			await user.click(screen.getByRole('button', { name: /^replace$/i }));
			await user.type(screen.getByLabelText(/describe this image/i), 'A lab bench');
			await user.click(screen.getByRole('button', { name: /replace with the assistant/i }));
			expect(onAskAssistant).toHaveBeenCalledWith(
				'Replace the placeholder image at index.html:20 with images/one.png and set its alt text to "A lab bench".'
			);
		});

		it('replace + decorative', async () => {
			const user = userEvent.setup();
			const { onAskAssistant } = open();
			await waitForImages();
			await user.click(screen.getByRole('button', { name: /^replace$/i }));
			await user.click(screen.getByRole('checkbox', { name: /this image is decorative/i }));
			await user.click(screen.getByRole('button', { name: /replace with the assistant/i }));
			expect(onAskAssistant).toHaveBeenCalledWith(
				'Replace the placeholder image at index.html:20 with images/one.png and mark it decorative with alt="".'
			);
		});
	});

	it('closes the dialog after handing a prompt to the assistant', async () => {
		const user = userEvent.setup();
		const { onAskAssistant, onOpenChange } = open();
		await waitForImages();
		await user.click(thumbnail(0));
		await user.click(screen.getByRole('checkbox', { name: /this image is decorative/i }));
		await user.click(screen.getByRole('button', { name: /insert with the assistant/i }));
		expect(onAskAssistant).toHaveBeenCalled();
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});
