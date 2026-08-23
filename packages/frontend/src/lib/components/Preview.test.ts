import { describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { fireEvent, render } from '@testing-library/svelte';
import Preview from './Preview.svelte';

describe('Preview lifecycle', () => {
	function previewFrame(container: HTMLElement): HTMLIFrameElement {
		const frame = container.querySelector<HTMLIFrameElement>('iframe');
		if (!frame) throw new Error('Preview iframe was not rendered');
		return frame;
	}

	it('owns the loading state with the active iframe load', async () => {
		const onRefresh = vi.fn();
		const rendered = render(Preview, { props: { projectId: 'project-a', onRefresh } });
		const frame = previewFrame(rendered.container);
		expect(rendered.container.querySelectorAll('iframe')).toHaveLength(1);

		expect(rendered.container.querySelector('.loading-overlay')).not.toBeNull();
		await fireEvent.load(frame);
		flushSync();
		expect(rendered.container.querySelector('.loading-overlay')).toBeNull();

		rendered.component.refresh();
		flushSync();
		expect(frame.src).toContain('?v=1');
		expect(rendered.container.querySelector('.loading-overlay')).not.toBeNull();

		// A second refresh supersedes the first without creating a second frame
		// whose load event could strand the overlay over the usable preview.
		rendered.component.refresh();
		flushSync();
		expect(frame.src).toContain('?v=2');
		await fireEvent.load(frame);
		flushSync();
		expect(rendered.container.querySelector('.loading-overlay')).toBeNull();
		expect(onRefresh).toHaveBeenCalledTimes(2);
	});
});
