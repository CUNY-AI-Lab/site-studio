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
	for (let index = 0; index < 8; index += 1) {
		await Promise.resolve();
	}
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
		expect(persist).toHaveBeenCalledWith(snapshot('B'), expect.any(AbortSignal));
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
		expect(persist).toHaveBeenNthCalledWith(2, snapshot('B'), expect.any(AbortSignal));
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
		expect(persist).toHaveBeenNthCalledWith(2, snapshot('B'), expect.any(AbortSignal));
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
		expect(persist).toHaveBeenNthCalledWith(2, snapshot('A'), expect.any(AbortSignal));

		await expect(autosave.flush()).resolves.toBe(true);
		expect(persist).toHaveBeenCalledTimes(3);
		expect(persist).toHaveBeenNthCalledWith(3, snapshot('A'), expect.any(AbortSignal));
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

	it('flushes a queued snapshot before the debounce timer fires', async () => {
		const persist = vi.fn(async () => true);
		const autosave = createAutosave({ persist, delayMs: 100 });

		autosave.queue(snapshot('A'));

		await expect(autosave.flush()).resolves.toBe(true);
		expect(persist).toHaveBeenCalledOnce();
		expect(persist).toHaveBeenCalledWith(snapshot('A'), expect.any(AbortSignal));
	});

	it('flushes a pending snapshot after dispose', async () => {
		const persist = vi.fn(async () => true);
		const autosave = createAutosave({ persist, delayMs: 100 });

		autosave.queue(snapshot('A'));
		autosave.dispose();

		await expect(autosave.flush()).resolves.toBe(true);
		expect(persist).toHaveBeenCalledOnce();
		expect(persist).toHaveBeenCalledWith(snapshot('A'), expect.any(AbortSignal));
	});

	it('reports the queued snapshot until a successful drain completes', async () => {
		const persist = vi.fn(async () => true);
		const autosave = createAutosave({ persist, delayMs: 100 });
		const queued = snapshot('A');

		autosave.queue(queued);
		expect(autosave.pending()).toEqual(queued);

		await expect(autosave.flush()).resolves.toBe(true);
		expect(autosave.pending()).toBeNull();
	});

	it('cancels a pending timer on dispose and performs no persist afterward', async () => {
		const persist = vi.fn(async () => true);
		const autosave = createAutosave({ persist, delayMs: 100 });

		autosave.queue(snapshot('A'));
		autosave.dispose();
		await vi.advanceTimersByTimeAsync(100);

		expect(persist).not.toHaveBeenCalled();
	});

	it('bounds a never-resolving persist and keeps the snapshot pending', async () => {
		const persist = vi.fn<(snapshot: SaveSnapshot, signal: AbortSignal) => Promise<boolean>>(
			() => new Promise<boolean>(() => {})
		);
		const queued = snapshot('A');
		const autosave = createAutosave({ persist, delayMs: 100, persistTimeoutMs: 50 });

		autosave.queue(queued);
		const flushPromise = autosave.flush();
		await flushMicrotasks();

		await vi.advanceTimersByTimeAsync(50);
		await expect(flushPromise).resolves.toBe(false);
		expect(autosave.pending()).toEqual(queued);
		expect(persist.mock.calls[0]?.[1]?.aborted).toBe(true);

		// A non-cooperative operation remains owned by the first save and cannot
		// make a later flush start a concurrent write.
		await expect(autosave.flush()).resolves.toBe(false);
		expect(persist).toHaveBeenCalledOnce();
	});

	it('does not duplicate a timed-out snapshot when its late persist succeeds', async () => {
		const first = deferred<boolean>();
		const persist = vi
			.fn<(snapshot: SaveSnapshot, signal: AbortSignal) => Promise<boolean>>()
			.mockReturnValueOnce(first.promise);
		const queued = snapshot('A');
		const autosave = createAutosave({ persist, delayMs: 100, persistTimeoutMs: 50 });

		autosave.queue(queued);
		const flushPromise = autosave.flush();
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(50);
		await expect(flushPromise).resolves.toBe(false);
		expect(autosave.pending()).toEqual(queued);

		first.resolve(true);
		await flushMicrotasks();
		expect(autosave.pending()).toBeNull();
		await expect(autosave.flush()).resolves.toBe(true);
		expect(persist).toHaveBeenCalledOnce();
	});
});
