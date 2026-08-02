import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import NewProjectDialog from './NewProjectDialog.svelte';
import {
	fetchProjects,
	fetchTemplateCategories,
	type Project,
	type TemplateCategory
} from '$lib/api/projects';

vi.mock('$lib/api/projects', async () => {
	const actual = await vi.importActual<typeof import('$lib/api/projects')>('$lib/api/projects');
	return {
		...actual,
		createProject: vi.fn(),
		fetchProjects: vi.fn(),
		fetchTemplateCategories: vi.fn()
	};
});

const mockFetchProjects = vi.mocked(fetchProjects);
const mockFetchTemplateCategories = vi.mocked(fetchTemplateCategories);

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

async function flushPendingUpdates() {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

const templateA = {
	id: 'alpha',
	title: 'Alpha template',
	description: 'An alpha project',
	icon: 'FileText',
	categoryName: 'Templates'
};

const templateB = {
	id: 'beta',
	title: 'Beta template',
	description: 'A beta project',
	icon: 'FileText',
	categoryName: 'Templates'
};

const categories: TemplateCategory[] = [
	{
		name: 'Templates',
		description: 'Start from a template',
		templates: [templateA, templateB]
	}
];

function openDialog() {
	render(NewProjectDialog, {
		props: {
			open: true,
			onOpenChange: vi.fn()
		}
	});
}

async function chooseTemplate(name: RegExp) {
	const user = userEvent.setup({ delay: null });
	await user.click(await screen.findByRole('button', { name }));
	return { user, input: screen.getByLabelText('Project Name (optional)') as HTMLInputElement };
}

describe('NewProjectDialog project-name suggestion race', () => {
	beforeEach(() => {
		mockFetchProjects.mockReset();
		mockFetchTemplateCategories.mockReset();
		mockFetchTemplateCategories.mockResolvedValue(categories);
	});

	it('keeps a custom name entered while the suggestion request is pending', async () => {
		const projects = deferred<Project[]>();
		mockFetchProjects.mockReturnValueOnce(projects.promise);
		openDialog();

		const { user, input } = await chooseTemplate(/Alpha template/);
		await user.clear(input);
		await user.type(input, 'custom-name');

		projects.resolve([]);
		await projects.promise;
		await flushPendingUpdates();
		expect(mockFetchProjects).toHaveBeenCalledOnce();
		expect(input.value).toBe('custom-name');
	});

	it('ignores a stale template request after switching templates', async () => {
		const alphaProjects = deferred<Project[]>();
		const betaProjects = deferred<Project[]>();
		mockFetchProjects
			.mockReturnValueOnce(alphaProjects.promise)
			.mockReturnValueOnce(betaProjects.promise);
		openDialog();

		const { user } = await chooseTemplate(/Alpha template/);
		await user.click(screen.getByRole('button', { name: 'Change' }));
		await user.click(await screen.findByRole('button', { name: /Beta template/ }));
		expect(mockFetchProjects).toHaveBeenCalledTimes(2);
		const input = screen.getByLabelText('Project Name (optional)') as HTMLInputElement;

		alphaProjects.resolve([]);
		await alphaProjects.promise;
		await flushPendingUpdates();
		expect(input.value).toBe('');

		betaProjects.resolve([]);
		await betaProjects.promise;
		await flushPendingUpdates();
		expect(input.value).toBe('beta-1');
	});

	it('keeps the newest same-template suggestion when an older request settles later', async () => {
		const firstRequest = deferred<Project[]>();
		const secondRequest = deferred<Project[]>();
		mockFetchProjects
			.mockReturnValueOnce(firstRequest.promise)
			.mockReturnValueOnce(secondRequest.promise);
		openDialog();

		const { user } = await chooseTemplate(/Alpha template/);
		await user.click(screen.getByRole('button', { name: 'Change' }));
		await user.click(await screen.findByRole('button', { name: /Alpha template/ }));
		expect(mockFetchProjects).toHaveBeenCalledTimes(2);
		const input = screen.getByLabelText('Project Name (optional)') as HTMLInputElement;

		secondRequest.resolve([{ id: 'alpha-4', name: 'alpha-4' }]);
		await secondRequest.promise;
		await flushPendingUpdates();
		expect(input.value).toBe('alpha-5');

		firstRequest.resolve([]);
		await firstRequest.promise;
		await flushPendingUpdates();
		expect(input.value).toBe('alpha-5');
	});
});
