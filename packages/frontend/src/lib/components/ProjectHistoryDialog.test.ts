import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import ProjectHistoryDialog from './ProjectHistoryDialog.svelte';
import type { ProjectSnapshot } from '$lib/api/projects';
import { invalidateCsrfToken } from '$lib/api/csrf';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: Error) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

const firstSnapshot: ProjectSnapshot = {
	id: 'snapshot-1',
	createdAt: '2026-08-24T12:00:00.000Z',
	projectId: 'project-a',
	trigger: 'manual',
	label: 'Before the agent run',
	fileCount: 2
};

const agentSnapshot: ProjectSnapshot = {
	id: 'snapshot-2',
	createdAt: '2026-08-24T12:05:00.000Z',
	projectId: 'project-a',
	trigger: 'agent',
	label: 'Agent changes',
	fileCount: 3
};

describe('ProjectHistoryDialog', () => {
	type FetchFunction = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	let fetchMock: Mock<FetchFunction>;

	beforeEach(() => {
		document.cookie = 'cail_csrf_sitestudio=test-csrf-token';
		invalidateCsrfToken();
		fetchMock = vi.fn<FetchFunction>();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => vi.unstubAllGlobals());

	it('reloads snapshots whenever the dialog opens', async () => {
		fetchMock
			.mockResolvedValueOnce(new Response(JSON.stringify({ snapshots: [firstSnapshot] }), { status: 200 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ snapshots: [agentSnapshot, firstSnapshot] }), { status: 200 })
			);
		const props = {
			open: true,
			projectId: 'project-a',
			projectName: 'Project A',
			onOpenChange: vi.fn()
		};
		const rendered = render(ProjectHistoryDialog, { props });

		await screen.findByText('Before the agent run');
		expect(fetchMock).toHaveBeenCalledTimes(1);

		await rendered.rerender({ ...props, open: false });
		await rendered.rerender({ ...props, open: true });

		await screen.findByText('Agent changes');
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
	});

	it('owns snapshot creation before awaiting the pending-save flush', async () => {
		const flush = deferred<boolean>();
		const onBeforeCreateSnapshot = vi.fn(() => flush.promise);
		fetchMock.mockImplementation(async (_input, init) => {
			if ((init?.method || 'GET') === 'POST') {
				return new Response(JSON.stringify({ snapshot: agentSnapshot }), { status: 200 });
			}
			return new Response(JSON.stringify({ snapshots: [firstSnapshot] }), { status: 200 });
		});
		render(ProjectHistoryDialog, {
			props: {
				open: true,
				projectId: 'project-a',
				onOpenChange: vi.fn(),
				onBeforeCreateSnapshot
			}
		});

		await screen.findByText('Before the agent run');
		const save = screen.getByRole('button', { name: 'Save version' });
		await Promise.all([fireEvent.click(save), fireEvent.click(save)]);

		expect(onBeforeCreateSnapshot).toHaveBeenCalledOnce();
		expect(screen.getByRole('button', { name: 'Creating...' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Restore' })).toBeDisabled();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		flush.resolve(true);
		await screen.findByText('Agent changes');
		const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
		expect(posts).toHaveLength(1);
	});

	it('owns restore before awaiting the pending-save flush', async () => {
		const flush = deferred<boolean>();
		const onBeforeRestore = vi.fn(() => flush.promise);
		const onRestoreSuccess = vi.fn();
		fetchMock.mockImplementation(async (_input, init) => {
			if ((init?.method || 'GET') === 'POST') {
				return new Response(JSON.stringify({
					restoredSnapshot: firstSnapshot,
					restorePoint: agentSnapshot
				}), { status: 200 });
			}
			return new Response(JSON.stringify({ snapshots: [firstSnapshot] }), { status: 200 });
		});
		render(ProjectHistoryDialog, {
			props: {
				open: true,
				projectId: 'project-a',
				onOpenChange: vi.fn(),
				onBeforeRestore,
				onRestoreSuccess
			}
		});

		await screen.findByText('Before the agent run');
		const restore = screen.getByRole('button', { name: 'Restore' });
		await Promise.all([fireEvent.click(restore), fireEvent.click(restore)]);

		expect(onBeforeRestore).toHaveBeenCalledOnce();
		expect(screen.getByRole('button', { name: 'Restoring...' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Save version' })).toBeDisabled();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		flush.resolve(true);
		await waitFor(() => expect(onRestoreSuccess).toHaveBeenCalledOnce());
		const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
		expect(posts).toHaveLength(1);
	});

	it('releases creation ownership when the save flush fails so retry works', async () => {
		const onBeforeCreateSnapshot = vi.fn()
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);
		fetchMock.mockImplementation(async (_input, init) => {
			if ((init?.method || 'GET') === 'POST') {
				return new Response(JSON.stringify({ snapshot: agentSnapshot }), { status: 200 });
			}
			return new Response(JSON.stringify({ snapshots: [firstSnapshot] }), { status: 200 });
		});
		render(ProjectHistoryDialog, {
			props: {
				open: true,
				projectId: 'project-a',
				onOpenChange: vi.fn(),
				onBeforeCreateSnapshot
			}
		});

		await screen.findByText('Before the agent run');
		await fireEvent.click(screen.getByRole('button', { name: 'Save version' }));
		await waitFor(() => expect(screen.getByRole('button', { name: 'Save version' })).toBeEnabled());
		expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);

		await fireEvent.click(screen.getByRole('button', { name: 'Save version' }));
		await screen.findByText('Agent changes');
		expect(onBeforeCreateSnapshot).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
	});

	it('keeps a newly saved version when the initial list response settles later', async () => {
		const initialList = deferred<Response>();
		fetchMock.mockImplementation(async (_input, init) => {
			if ((init?.method || 'GET') === 'POST') {
				return new Response(JSON.stringify({ snapshot: agentSnapshot }), { status: 200 });
			}
			return initialList.promise;
		});
		render(ProjectHistoryDialog, {
			props: {
				open: true,
				projectId: 'project-a',
				onOpenChange: vi.fn()
			}
		});

		await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
		await fireEvent.click(screen.getByRole('button', { name: 'Save version' }));
		await screen.findByText('Agent changes');

		initialList.resolve(new Response(JSON.stringify({ snapshots: [firstSnapshot] }), { status: 200 }));
		await initialList.promise;
		await waitFor(() => expect(screen.getByText('Agent changes')).toBeInTheDocument());
		expect(screen.queryByText('Before the agent run')).not.toBeInTheDocument();
	});

	it('clears snapshots when a project switch load fails', async () => {
		const switchedLoad = deferred<Response>();
		fetchMock.mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/projects/project-a/snapshots')) {
				return new Response(JSON.stringify({ snapshots: [firstSnapshot] }), { status: 200 });
			}
			if (url.endsWith('/projects/project-b/snapshots')) return switchedLoad.promise;
			throw new Error(`Unexpected request: ${url}`);
		});
		const props = {
			open: true,
			projectId: 'project-a',
			onOpenChange: vi.fn()
		};
		const rendered = render(ProjectHistoryDialog, { props });

		await screen.findByText('Before the agent run');
		await rendered.rerender({ ...props, projectId: 'project-b' });
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		switchedLoad.reject(new Error('project B unavailable'));

		await waitFor(() =>
			expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong. Try again.')
		);
		expect(screen.queryByText('Before the agent run')).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
	});

	it('does not restore an old snapshot after switching projects during preflight', async () => {
		const preflight = deferred<boolean>();
		const restoreCalls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
		fetchMock.mockImplementation(async (input, init) => {
			const url = String(input);
			if (url.endsWith('/projects/project-a/snapshots') && (init?.method || 'GET') === 'GET') {
				return new Response(JSON.stringify({ snapshots: [firstSnapshot] }), { status: 200 });
			}
			if (url.endsWith('/projects/project-b/snapshots') && (init?.method || 'GET') === 'GET') {
				return new Response(JSON.stringify({ snapshots: [] }), { status: 200 });
			}
			if ((init?.method || 'GET') === 'POST') {
				restoreCalls.push([input, init]);
				return new Response(
					JSON.stringify({ restoredSnapshot: firstSnapshot, restorePoint: agentSnapshot }),
					{ status: 200 }
				);
			}
			throw new Error(`Unexpected request: ${url}`);
		});
		const onBeforeRestore = vi.fn(() => preflight.promise);
		const onRestoreSuccess = vi.fn();
		const props = {
			open: true,
			projectId: 'project-a',
			onOpenChange: vi.fn(),
			onBeforeRestore,
			onRestoreSuccess
		};
		const rendered = render(ProjectHistoryDialog, { props });

		await screen.findByText('Before the agent run');
		await fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
		await rendered.rerender({ ...props, projectId: 'project-b' });
		await screen.findByText('No saved versions yet.');
		preflight.resolve(true);
		await preflight.promise;
		await waitFor(() => expect(screen.getByRole('button', { name: 'Save version' })).toBeEnabled());

		expect(restoreCalls).toHaveLength(0);
		expect(onRestoreSuccess).not.toHaveBeenCalled();
	});

	it('does not report a restore failure after switching projects', async () => {
		const restore = deferred<Response>();
		fetchMock.mockImplementation(async (input, init) => {
			const url = String(input);
			if (url.endsWith('/projects/project-a/snapshots') && (init?.method || 'GET') === 'GET') {
				return new Response(JSON.stringify({ snapshots: [firstSnapshot] }), { status: 200 });
			}
			if (url.endsWith('/projects/project-b/snapshots') && (init?.method || 'GET') === 'GET') {
				return new Response(JSON.stringify({ snapshots: [] }), { status: 200 });
			}
			if ((init?.method || 'GET') === 'POST') return restore.promise;
			throw new Error(`Unexpected request: ${url}`);
		});
		const onRestoreSuccess = vi.fn();
		const props = {
			open: true,
			projectId: 'project-a',
			onOpenChange: vi.fn(),
			onRestoreSuccess
		};
		const rendered = render(ProjectHistoryDialog, { props });

		await screen.findByText('Before the agent run');
		await fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
		await waitFor(() =>
			expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
		);
		await rendered.rerender({ ...props, projectId: 'project-b' });
		await screen.findByText('No saved versions yet.');
		restore.reject(new Error('old restore failed'));
		await waitFor(() => expect(screen.getByRole('button', { name: 'Save version' })).toBeEnabled());

		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
		expect(onRestoreSuccess).not.toHaveBeenCalled();
	});

	it('does not finish a restore callback after switching projects', async () => {
		const restore = deferred<Response>();
		fetchMock.mockImplementation(async (input, init) => {
			const url = String(input);
			if (url.endsWith('/projects/project-a/snapshots') && (init?.method || 'GET') === 'GET') {
				return new Response(JSON.stringify({ snapshots: [firstSnapshot] }), { status: 200 });
			}
			if (url.endsWith('/projects/project-b/snapshots') && (init?.method || 'GET') === 'GET') {
				return new Response(JSON.stringify({ snapshots: [] }), { status: 200 });
			}
			if ((init?.method || 'GET') === 'POST') return restore.promise;
			throw new Error(`Unexpected request: ${url}`);
		});
		const onRestoreSuccess = vi.fn();
		const props = {
			open: true,
			projectId: 'project-a',
			onOpenChange: vi.fn(),
			onRestoreSuccess
		};
		const rendered = render(ProjectHistoryDialog, { props });

		await screen.findByText('Before the agent run');
		await fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
		await waitFor(() =>
			expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
		);
		await rendered.rerender({ ...props, projectId: 'project-b' });
		await screen.findByText('No saved versions yet.');
		restore.resolve(
			new Response(
				JSON.stringify({ restoredSnapshot: firstSnapshot, restorePoint: agentSnapshot }),
				{ status: 200 }
			)
		);
		await restore.promise;
		await waitFor(() => expect(screen.getByRole('button', { name: 'Save version' })).toBeEnabled());

		expect(onRestoreSuccess).not.toHaveBeenCalled();
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
	});

	it('does not show a save failure after closing and reopening another project', async () => {
		const save = deferred<Response>();
		fetchMock.mockImplementation(async (input, init) => {
			const url = String(input);
			if (url.endsWith('/projects/project-a/snapshots') && (init?.method || 'GET') === 'GET') {
				return new Response(JSON.stringify({ snapshots: [firstSnapshot] }), { status: 200 });
			}
			if (url.endsWith('/projects/project-b/snapshots') && (init?.method || 'GET') === 'GET') {
				return new Response(JSON.stringify({ snapshots: [] }), { status: 200 });
			}
			if ((init?.method || 'GET') === 'POST') return save.promise;
			throw new Error(`Unexpected request: ${url}`);
		});
		const props = {
			open: true,
			projectId: 'project-a',
			onOpenChange: vi.fn()
		};
		const rendered = render(ProjectHistoryDialog, { props });

		await screen.findByText('Before the agent run');
		await fireEvent.click(screen.getByRole('button', { name: 'Save version' }));
		await waitFor(() =>
			expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
		);
		await rendered.rerender({ ...props, open: false });
		await rendered.rerender({ ...props, open: true, projectId: 'project-b' });
		await screen.findByText('No saved versions yet.');
		save.reject(new Error('old save failed'));
		await waitFor(() => expect(screen.getByRole('button', { name: 'Save version' })).toBeEnabled());

		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
	});
});
