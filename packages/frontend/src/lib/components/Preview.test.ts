import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { flushSync } from 'svelte';
import { fireEvent, render } from '@testing-library/svelte';
import Preview from './Preview.svelte';

type RafCallback = (timestamp: number) => void;

describe('Preview lifecycle', () => {
	let callbacks: Map<number, RafCallback>;
	let nextCallbackId: number;
	let originalAnimate: typeof Element.prototype.animate;

	beforeEach(() => {
		vi.useFakeTimers();
		originalAnimate = Element.prototype.animate;
		Object.defineProperty(Element.prototype, 'animate', {
			configurable: true,
			value: vi.fn(() => ({ cancel: vi.fn(), finished: Promise.resolve() }))
		});
		callbacks = new Map();
		nextCallbackId = 0;
		vi.stubGlobal('requestAnimationFrame', (callback: RafCallback) => {
			const id = ++nextCallbackId;
			callbacks.set(id, callback);
			return id;
		});
		vi.stubGlobal('cancelAnimationFrame', (id: number) => {
			callbacks.delete(id);
		});
	});

	afterEach(() => {
		Object.defineProperty(Element.prototype, 'animate', {
			configurable: true,
			value: originalAnimate
		});
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	function flushAnimationFrame(): void {
		const pending = [...callbacks.values()];
		callbacks.clear();
		for (const callback of pending) callback(0);
		flushSync();
	}

	function previewFrameSources(container: HTMLElement): HTMLIFrameElement[] {
		return [...container.querySelectorAll<HTMLIFrameElement>('iframe')];
	}

	it('does not let an older delayed frame load replace a newer refresh', async () => {
		const rendered = render(Preview, { props: { projectId: 'project-a' } });
		const [activeFrame, loadingFrame] = previewFrameSources(rendered.container);

		await fireEvent.load(activeFrame);
		flushSync();
		rendered.component.refresh();
		flushAnimationFrame();
		expect(loadingFrame.src).toContain('?v=1');

		// Refresh again before the first response is accepted. The hidden frame is
		// blanked and receives a strictly newer source.
		rendered.component.refresh();
		flushAnimationFrame();
		expect(loadingFrame.src).toContain('?v=2');

		// Simulate a delayed v=1 response. The expected URL is v=2, so the old
		// frame cannot be shown.
		loadingFrame.src = '/preview/project-a/index.html?v=1';
		await fireEvent.load(loadingFrame);
		flushSync();
		expect(activeFrame.style.display).toBe('block');
		expect(loadingFrame.style.display).toBe('none');

		loadingFrame.src = '/preview/project-a/index.html?v=2';
		await fireEvent.load(loadingFrame);
		flushSync();
		expect(loadingFrame.style.display).toBe('block');
		expect(activeFrame.src).toContain('?v=0');

		// The old document is retired only after the new frame gets paint time.
		flushAnimationFrame();
		expect(activeFrame.src).toContain('?v=0');
		flushAnimationFrame();
		expect(activeFrame.src).toBe('about:blank');
	});

	it('cancels a pending refresh when the preview is unmounted', () => {
		const rendered = render(Preview, { props: { projectId: 'project-a' } });
		const [, loadingFrame] = previewFrameSources(rendered.container);

		rendered.component.refresh();
		rendered.unmount();
		flushAnimationFrame();

		expect(loadingFrame.src).toBe('about:blank');
		expect(callbacks.size).toBe(0);
	});
});
