import { describe, expect, it, vi } from 'vitest';
import {
	createFileTreeRefreshCoordinator,
	type FileTreeRefreshRequest
} from './file-tree-refresh';

function request(overrides: Partial<FileTreeRefreshRequest> = {}): FileTreeRefreshRequest {
	return {
		projectId: 'project-a',
		contextVersion: 1,
		source: 'manual',
		reloadCurrentFile: false,
		refreshPreview: false,
		...overrides
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

describe('file-tree refresh coordinator', () => {
	it('keeps one load in flight and performs one latest invalidation after it', async () => {
		const first = deferred<string[]>();
		const second = deferred<string[]>();
		const loads: Array<ReturnType<typeof deferred<string[]>>> = [first, second];
		const load = vi.fn(() => loads.shift()?.promise ?? Promise.resolve([]));
		let current: FileTreeRefreshRequest = request();
		const loaded: string[][] = [];
		const coordinator = createFileTreeRefreshCoordinator<string[]>({
			load,
			isCurrent: (next) => next.projectId === current.projectId && next.contextVersion === current.contextVersion,
			onLoaded: (_next, value) => {
				loaded.push(value);
			},
			onError: vi.fn()
		});

		const initial = coordinator.request(current);
		const coalesced = coordinator.request({ ...current, source: 'agent', refreshPreview: true });
		expect(load).toHaveBeenCalledTimes(1);

		first.resolve(['index.html']);
		await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
		second.resolve(['index.html', 'about.html']);
		await Promise.all([initial, coalesced]);

		expect(load).toHaveBeenCalledTimes(2);
		expect(loaded).toEqual([
			['index.html'],
			['index.html', 'about.html']
		]);
	});

	it('drops an old project result and reads the switched project through the same queue', async () => {
		const projectA = deferred<string[]>();
		const projectB = deferred<string[]>();
		const load = vi.fn((projectId: string) => (projectId === 'project-a' ? projectA.promise : projectB.promise));
		let current = request();
		const loaded: string[][] = [];
		const coordinator = createFileTreeRefreshCoordinator<string[]>({
			load,
			isCurrent: (next) => next.projectId === current.projectId && next.contextVersion === current.contextVersion,
			onLoaded: (_next, value) => {
				loaded.push(value);
			},
			onError: vi.fn()
		});

		const oldRequest = coordinator.request(current);
		current = request({ projectId: 'project-b', contextVersion: 2, source: 'project-load' });
		const newRequest = coordinator.request(current);
		projectA.resolve(['stale-a.html']);
		await Promise.resolve();
		expect(load).toHaveBeenCalledTimes(2);
		projectB.resolve(['current-b.html']);
		await Promise.all([oldRequest, newRequest]);

		expect(loaded).toEqual([['current-b.html']]);
	});

	it('reports a current failure and can recover on the next explicit invalidation', async () => {
		const load = vi
			.fn<() => Promise<string[]>>()
			.mockRejectedValueOnce(new Error('temporary read failure'))
			.mockResolvedValueOnce(['recovered.html']);
		const onError = vi.fn();
		const loaded: string[][] = [];
		const coordinator = createFileTreeRefreshCoordinator<string[]>({
			load,
			isCurrent: () => true,
			onLoaded: (_request, value) => {
				loaded.push(value);
			},
			onError
		});

		await coordinator.request(request());
		expect(onError).toHaveBeenCalledTimes(1);
		expect(loaded).toEqual([]);

		await coordinator.request(request({ source: 'manual' }));
		expect(loaded).toEqual([['recovered.html']]);
	});
});
