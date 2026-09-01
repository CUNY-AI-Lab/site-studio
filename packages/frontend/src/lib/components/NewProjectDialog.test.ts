import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import NewProjectDialog from './NewProjectDialog.svelte';
import {
	createProject,
	fetchProjects,
	fetchTemplateCategories,
	type Project,
	type TemplateCategory
} from '$lib/api/projects';
const mockCreateProject = vi.fn<typeof createProject>();
const mockFetchProjects = vi.fn<typeof fetchProjects>();
const mockFetchTemplateCategories = vi.fn<typeof fetchTemplateCategories>();

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
			onOpenChange: vi.fn(),
			createProject: mockCreateProject,
			fetchProjects: mockFetchProjects,
			fetchTemplateCategories: mockFetchTemplateCategories
		}
	});
}

function projectNameInput(): HTMLInputElement {
	const input = screen.getByLabelText('Project Name (optional)');
	if (!(input instanceof HTMLInputElement)) throw new Error('expected project name input');
	return input;
}

async function chooseTemplate(name: RegExp) {
	const user = userEvent.setup({ delay: null });
	await user.click(await screen.findByRole('button', { name }));
	return { user, input: projectNameInput() };
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

	it('does not let a pending suggestion change the focused name field', async () => {
		const projects = deferred<Project[]>();
		mockFetchProjects.mockReturnValueOnce(projects.promise);
		openDialog();

		const { user, input } = await chooseTemplate(/Alpha template/);
		await user.click(input);
		projects.resolve([{ id: 'alpha-1', name: 'alpha-1' }]);
		await projects.promise;
		await flushPendingUpdates();

		expect(input.value).toBe('');
		await user.type(input, 'custom-name');
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
		const input = projectNameInput();

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
		const input = projectNameInput();

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
