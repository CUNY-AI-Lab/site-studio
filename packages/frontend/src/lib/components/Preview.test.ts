import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { fireEvent, render } from '@testing-library/svelte';
import Preview from './Preview.svelte';

describe('Preview lifecycle', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	function previewFrame(container: HTMLElement): HTMLIFrameElement {
		const frame = container.querySelector<HTMLIFrameElement>('iframe');
		if (!frame) throw new Error('Preview iframe was not rendered');
		return frame;
	}

	it('becomes ready only after the active successful child reports its HTTP-backed token', async () => {
		const rendered = render(Preview, { props: { projectId: 'project-a' } });
		const frame = previewFrame(rendered.container);
		expect(rendered.container.querySelectorAll('iframe')).toHaveLength(1);
		expect(frame.src).toContain('?v=0&ready=0');

		expect(rendered.container.querySelector('.loading-overlay')).not.toBeNull();
		await fireEvent.load(frame);
		flushSync();
		expect(rendered.container.querySelector('.loading-overlay')).not.toBeNull();

		window.dispatchEvent(new MessageEvent('message', {
			data: { type: 'site-studio-preview-ready', token: 'wrong' },
			source: frame.contentWindow
		}));
		flushSync();
		expect(rendered.container.querySelector('.loading-overlay')).not.toBeNull();

		window.dispatchEvent(new MessageEvent('message', {
			data: { type: 'site-studio-preview-ready', token: '0' },
			source: frame.contentWindow
		}));
		flushSync();
		expect(rendered.container.querySelector('.loading-overlay')).toBeNull();

		rendered.component.refresh();
		flushSync();
		expect(frame.src).toContain('?v=1&ready=1');
		expect(rendered.container.querySelector('.loading-overlay')).not.toBeNull();

		// A second refresh supersedes the first without creating a second frame
		// whose load event could strand the overlay over the usable preview.
		rendered.component.refresh();
		flushSync();
		expect(frame.src).toContain('?v=2&ready=2');
		await fireEvent.load(frame);
		flushSync();
		expect(rendered.container.querySelector('.loading-overlay')).not.toBeNull();
		window.dispatchEvent(new MessageEvent('message', {
			data: { type: 'site-studio-preview-ready', token: '2' },
			source: frame.contentWindow
		}));
		flushSync();
		expect(rendered.container.querySelector('.loading-overlay')).toBeNull();
	});

	it('shows a retryable error when iframe navigation fails', async () => {
		const rendered = render(Preview, { props: { projectId: 'project-a' } });
		const frame = previewFrame(rendered.container);

		await fireEvent.error(frame);
		flushSync();
		expect(rendered.getByRole('alert')).toHaveTextContent('The preview could not be loaded.');

		await fireEvent.click(rendered.getByRole('button', { name: 'Retry preview' }));
		flushSync();
		expect(frame.src).toContain('?v=1&ready=1');
		expect(rendered.container.querySelector('.loading-overlay')).not.toBeNull();
		expect(rendered.queryByRole('alert')).toBeNull();
	});

	it('turns a stalled navigation into the same retryable error', async () => {
		vi.useFakeTimers();
		const rendered = render(Preview, { props: { projectId: 'project-a' } });

		vi.advanceTimersByTime(14_999);
		flushSync();
		expect(rendered.queryByRole('alert')).toBeNull();

		vi.advanceTimersByTime(1);
		flushSync();
		expect(rendered.getByRole('alert')).toHaveTextContent('The preview could not be loaded.');
	});
});
