import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import type { Project, TemplateCategory } from '$lib/api/projects';
import { invalidateCsrfToken } from '$lib/api/csrf';
import ProjectDashboard from './ProjectDashboard.svelte';

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: Error) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

const oldProject: Project = { id: 'old-project', name: 'Old project' };
const newProject: Project = { id: 'new-project', name: 'New project' };

const categories: TemplateCategory[] = [
	{
		name: 'Templates',
		description: 'Start from a template',
		templates: [
			{
				id: 'blank',
				title: 'Blank template',
				description: 'A blank project',
				icon: 'FileText',
				categoryName: 'Templates'
			}
		]
	}
];

describe('ProjectDashboard project-list race', () => {
	type FetchFunction = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	let fetchMock: Mock<FetchFunction>;

	beforeEach(() => {
		document.cookie = 'cail_csrf_sitestudio=test-csrf-token';
		invalidateCsrfToken();
		fetchMock = vi.fn<FetchFunction>();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => vi.unstubAllGlobals());

	it('keeps the newest post-create project list when the initial load settles later', async () => {
		const initialLoad = deferred<Project[]>();
		const postCreateLoad = deferred<Project[]>();
		let projectListRequest = 0;
		fetchMock.mockImplementation(async (input, init) => {
			const url = String(input);
			const method = init?.method?.toUpperCase() ?? 'GET';
			if (url.endsWith('/templates')) {
				return new Response(JSON.stringify({ categories }), { status: 200 });
			}
			if (url.endsWith('/projects') && method === 'GET') {
				projectListRequest += 1;
				if (projectListRequest === 1) return new Response(JSON.stringify({ projects: await initialLoad.promise }), { status: 200 });
				if (projectListRequest === 2) return new Response(JSON.stringify({ projects: [] }), { status: 200 });
				if (projectListRequest === 3) return new Response(JSON.stringify({ projects: await postCreateLoad.promise }), { status: 200 });
			}
			if (url.endsWith('/projects') && method === 'POST') {
				return new Response(JSON.stringify(newProject), { status: 200 });
			}
			throw new Error(`Unexpected request: ${method} ${url}`);
		});
		const view = render(ProjectDashboard);

		await waitFor(() => expect(projectListRequest).toBe(1));
		await fireEvent.click(screen.getByRole('button', { name: 'New Project' }));
		await screen.findByRole('button', { name: /Blank template/ });
		await fireEvent.click(screen.getByRole('button', { name: /Blank template/ }));
		await waitFor(() => expect(projectListRequest).toBe(2));
		const nameInput = await screen.findByLabelText('Project Name (optional)');
		await fireEvent.input(nameInput, { target: { value: 'new-project' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));

		await waitFor(() => expect(projectListRequest).toBe(3));
		postCreateLoad.resolve([newProject]);
		await screen.findByRole('button', { name: 'Open New project' });

		initialLoad.resolve([oldProject]);
		await initialLoad.promise;
		await waitFor(() => expect(screen.getByRole('button', { name: 'Open New project' })).toBeInTheDocument());
		expect(screen.queryByRole('button', { name: 'Open Old project' })).not.toBeInTheDocument();
		const createCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
		expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({ name: 'new-project', template: 'blank' });
		expect(projectListRequest).toBe(3);
		view.unmount();
	});

	it('does not start onboarding from an initial load superseded by a failed refresh', async () => {
		localStorage.removeItem('site-studio-onboarding-completed');
		const initialLoad = deferred<Project[]>();
		const newerLoad = deferred<Project[]>();
		let projectListRequest = 0;
		fetchMock.mockImplementation(async (input, init) => {
			const url = String(input);
			const method = init?.method?.toUpperCase() ?? 'GET';
			if (url.endsWith('/templates')) {
				return new Response(JSON.stringify({ categories }), { status: 200 });
			}
			if (url.endsWith('/projects') && method === 'GET') {
				projectListRequest += 1;
				if (projectListRequest === 1) {
					return new Response(JSON.stringify({ projects: await initialLoad.promise }), { status: 200 });
				}
				if (projectListRequest === 2) {
					return new Response(JSON.stringify({ projects: [] }), { status: 200 });
				}
				if (projectListRequest === 3) {
					const projects = await newerLoad.promise;
					return new Response(JSON.stringify({ projects }), { status: 200 });
				}
			}
			if (url.endsWith('/projects') && method === 'POST') {
				return new Response(JSON.stringify(newProject), { status: 200 });
			}
			throw new Error(`Unexpected request: ${method} ${url}`);
		});
		const view = render(ProjectDashboard);

		await waitFor(() => expect(projectListRequest).toBe(1));
		await fireEvent.click(screen.getByRole('button', { name: 'New Project' }));
		await screen.findByRole('button', { name: /Blank template/ });
		await fireEvent.click(screen.getByRole('button', { name: /Blank template/ }));
		await waitFor(() => expect(projectListRequest).toBe(2));
		const nameInput = await screen.findByLabelText('Project Name (optional)');
		await fireEvent.input(nameInput, { target: { value: 'new-project' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));
		await waitFor(() => expect(projectListRequest).toBe(3));

		newerLoad.reject(new Error('newer list failed'));
		await screen.findByRole('alert');
		initialLoad.resolve([]);
		await initialLoad.promise;
		await new Promise((resolve) => setTimeout(resolve, 650));

		expect(document.querySelector('.driver-popover')).not.toBeInTheDocument();
		expect(screen.getByRole('alert')).toHaveTextContent("We couldn't load your projects.");
		view.unmount();
		localStorage.removeItem('site-studio-onboarding-completed');
	});
});
