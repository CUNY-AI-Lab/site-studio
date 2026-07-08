import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutosave, type SaveSnapshot } from './autosave';

function snapshot(content: string): SaveSnapshot {
	return {
		projectId: 'project-1',
		filePath: 'index.html',
		content
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

async function flushMicrotasks() {
	await Promise.resolve();
	await Promise.resolve();
}

describe('createAutosave', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('debounces queued saves and persists the last queued snapshot', async () => {
		const persist = vi.fn(async () => true);
		const autosave = createAutosave({ persist, delayMs: 100 });

		autosave.queue(snapshot('A'));
		await vi.advanceTimersByTimeAsync(50);
		autosave.queue(snapshot('B'));
		await vi.advanceTimersByTimeAsync(99);

		expect(persist).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);

		expect(persist).toHaveBeenCalledTimes(1);
		expect(persist).toHaveBeenCalledWith(snapshot('B'));
	});

	it('persists a newer edit queued during an in-flight successful save in the same drain', async () => {
		const first = deferred<boolean>();
		const persist = vi
			.fn<(snapshot: SaveSnapshot) => Promise<boolean>>()
			.mockReturnValueOnce(first.promise)
			.mockResolvedValueOnce(true);
		const autosave = createAutosave({ persist, delayMs: 100 });

		autosave.queue(snapshot('A'));
		await vi.advanceTimersByTimeAsync(100);
		expect(persist).toHaveBeenCalledTimes(1);

		autosave.queue(snapshot('B'));
		first.resolve(true);
		await flushMicrotasks();

		expect(persist).toHaveBeenCalledTimes(2);
		expect(persist).toHaveBeenNthCalledWith(2, snapshot('B'));
		await expect(autosave.flush()).resolves.toBe(true);
	});

	it('retains a newer edit queued while an older in-flight save fails (SS-35 regression)', async () => {
		const first = deferred<boolean>();
		const persist = vi
			.fn<(snapshot: SaveSnapshot) => Promise<boolean>>()
			.mockReturnValueOnce(first.promise)
			.mockResolvedValueOnce(true);
		const autosave = createAutosave({ persist, delayMs: 100 });

		autosave.queue(snapshot('A'));
		await vi.advanceTimersByTimeAsync(100);
		autosave.queue(snapshot('B'));

		first.resolve(false);
		await flushMicrotasks();

		expect(persist).toHaveBeenCalledTimes(1);
		await expect(autosave.flush()).resolves.toBe(true);
		expect(persist).toHaveBeenCalledTimes(2);
		expect(persist).toHaveBeenNthCalledWith(2, snapshot('B'));
	});

	it('retries a failed background save on later flush instead of returning true vacuously (SS-35 regression)', async () => {
		const persist = vi
			.fn<(snapshot: SaveSnapshot) => Promise<boolean>>()
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);
		const autosave = createAutosave({ persist, delayMs: 100 });

		autosave.queue(snapshot('A'));
		await vi.advanceTimersByTimeAsync(100);
		await flushMicrotasks();

		await expect(autosave.flush()).resolves.toBe(false);
		expect(persist).toHaveBeenCalledTimes(2);
		expect(persist).toHaveBeenNthCalledWith(2, snapshot('A'));

		await expect(autosave.flush()).resolves.toBe(true);
		expect(persist).toHaveBeenCalledTimes(3);
		expect(persist).toHaveBeenNthCalledWith(3, snapshot('A'));
	});

	it('does not schedule an automatic retry after a failed background drain', async () => {
		const persist = vi.fn<(snapshot: SaveSnapshot) => Promise<boolean>>().mockResolvedValue(false);
		const autosave = createAutosave({ persist, delayMs: 100 });

		autosave.queue(snapshot('A'));
		await vi.advanceTimersByTimeAsync(100);
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(10_000);

		expect(persist).toHaveBeenCalledTimes(1);
	});

	it('coalesces flush with an in-flight drain without a duplicate persist', async () => {
		const first = deferred<boolean>();
		const persist = vi.fn<(snapshot: SaveSnapshot) => Promise<boolean>>().mockReturnValueOnce(first.promise);
		const autosave = createAutosave({ persist, delayMs: 100 });

		autosave.queue(snapshot('A'));
		await vi.advanceTimersByTimeAsync(100);
		const flushPromise = autosave.flush();

		expect(persist).toHaveBeenCalledTimes(1);
		first.resolve(true);

		await expect(flushPromise).resolves.toBe(true);
		expect(persist).toHaveBeenCalledTimes(1);
	});

	it('cancels a pending timer on dispose and performs no persist afterward', async () => {
		const persist = vi.fn(async () => true);
		const autosave = createAutosave({ persist, delayMs: 100 });

		autosave.queue(snapshot('A'));
		autosave.dispose();
		await vi.advanceTimersByTimeAsync(100);

		expect(persist).not.toHaveBeenCalled();
	});
});
