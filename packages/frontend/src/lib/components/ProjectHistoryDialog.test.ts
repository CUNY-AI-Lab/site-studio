import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import ProjectHistoryDialog from './ProjectHistoryDialog.svelte';
import type { ProjectSnapshot } from '$lib/api/projects';
import { invalidateCsrfToken } from '$lib/api/csrf';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
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
});
