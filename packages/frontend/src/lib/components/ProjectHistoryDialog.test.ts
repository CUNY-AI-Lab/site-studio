import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/svelte';
import ProjectHistoryDialog from './ProjectHistoryDialog.svelte';
import type { ProjectSnapshot } from '$lib/api/projects';

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
	let fetchMock: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fetchMock = vi.spyOn(globalThis, 'fetch');
	});

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
});
