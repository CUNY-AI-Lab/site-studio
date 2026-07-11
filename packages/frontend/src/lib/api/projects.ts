import { resolvePath } from '$lib/utils/paths';
import { apiFetch, handleApiError } from './errors';
import { csrfFetch } from './csrf';

const API_BASE = resolvePath('/api');

export interface Project {
	id: string;
	name: string;
	published?: boolean;
	publishedUrl?: string;
	thumbnailUrl?: string;
}

export type ProjectSnapshotTrigger = 'agent' | 'manual' | 'restore';

export interface ProjectSnapshot {
	id: string;
	createdAt: string;
	projectId: string;
	trigger: ProjectSnapshotTrigger;
	label?: string;
	fileCount: number;
	restoredFromSnapshotId?: string;
}

export interface TemplateMetadata {
	id: string;
	title: string;
	description: string;
	icon: string;
	categoryName: string;
}

export interface TemplateCategory {
	name: string;
	description: string;
	templates: TemplateMetadata[];
}

export interface ProjectFile {
	name: string;
	path: string;
	type: 'file' | 'directory';
	contentType?: string;
	isText?: boolean;
	children?: ProjectFile[];
}

/**
 * Fetch all projects for the current user
 */
export async function fetchProjects(): Promise<Project[]> {
	const data = await apiFetch<{ projects: Project[] }>(`${API_BASE}/projects`);
	return data.projects;
}

/**
 * Create a new project
 */
export async function createProject(name: string, template?: string): Promise<Project> {
	return apiFetch<Project>(`${API_BASE}/projects`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ name, template }),
	});
}

/**
 * Rename an existing project
 */
export async function renameProject(projectId: string, newName: string): Promise<Project> {
	return apiFetch<Project>(`${API_BASE}/projects/${projectId}`, {
		method: 'PATCH',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ name: newName }),
	});
}

/**
 * Delete a project
 */
export async function deleteProject(projectId: string): Promise<void> {
	await apiFetch<void>(`${API_BASE}/projects/${projectId}`, {
		method: 'DELETE',
	});
}

/**
 * Upload an image into the project's images/ folder. The backend validates the
 * magic bytes against the extension and rejects non-image or oversized files.
 * Returns the stored path (e.g. "images/photo.png").
 */
export async function uploadProjectImage(projectId: string, file: File): Promise<string> {
	const formData = new FormData();
	formData.append('file', file);
	formData.append('dir', 'images');

	const response = await csrfFetch(`${API_BASE}/projects/${projectId}/upload`, {
		method: 'POST',
		body: formData,
	});

	if (!response.ok) {
		await handleApiError(response);
	}

	const data = (await response.json()) as { path: string };
	return data.path;
}

/** An image file that exists in the project. */
export interface ProjectImage {
	path: string;
	size: number;
}

/** A placehold.co placeholder still present in the project's HTML. */
export interface PlaceholderFinding {
	file: string;
	line: number | null;
	message: string;
	/** The placehold.co URL, when it could be pulled from the line. */
	src?: string;
}

export interface ProjectImagesResult {
	images: ProjectImage[];
	placeholders: PlaceholderFinding[];
}

/**
 * Fetch the project's image inventory: real image files plus any placehold.co
 * placeholders still referenced in the HTML.
 */
export async function fetchProjectImages(projectId: string): Promise<ProjectImagesResult> {
	return apiFetch<ProjectImagesResult>(`${API_BASE}/projects/${projectId}/images`);
}

/**
 * Download a file from the project
 */
export async function downloadFile(projectId: string, filePath: string): Promise<void> {
	const response = await fetch(
		`${API_BASE}/projects/${projectId}/download?path=${encodeURIComponent(filePath)}`,
		{
			credentials: 'include',
		}
	);

	if (!response.ok) {
		await handleApiError(response);
	}

	const blob = await response.blob();
	const url = window.URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filePath.split('/').pop() || 'download';
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	window.URL.revokeObjectURL(url);
}

/**
 * A single accessibility finding surfaced when publishing a project.
 */
export interface A11yFinding {
	file: string;
	line: number | null;
	rule: string;
	severity: 'error' | 'warning';
	message: string;
}

export interface PublishSuccess {
	ok: true;
	url: string;
	a11yFindings?: A11yFinding[];
}

/**
 * The publish endpoint returns 409 { error: "handle_required" } when the user
 * has not yet claimed a public handle. Surfaced as a typed result so the caller
 * can open the handle-claim dialog instead of showing a raw error string.
 */
export interface PublishNeedsHandle {
	ok: false;
	reason: 'handle_required';
	message: string;
}

export type PublishResult = PublishSuccess | PublishNeedsHandle;

/**
 * Publish a project to make it publicly accessible. Resolves to a typed result;
 * only unexpected failures throw.
 */
export async function publishProject(projectId: string): Promise<PublishResult> {
	const response = await csrfFetch(`${API_BASE}/projects/${projectId}/publish`, {
		method: 'POST',
	});

	if (response.status === 409) {
		const data = await response.json().catch(() => ({}) as Record<string, unknown>);
		if ((data as { error?: string }).error === 'handle_required') {
			return {
				ok: false,
				reason: 'handle_required',
				message:
					(data as { message?: string }).message || 'Choose a public handle before publishing.',
			};
		}
	}

	if (!response.ok) {
		await handleApiError(response);
	}

	const data = (await response.json()) as { url: string; a11yFindings?: A11yFinding[] };
	return { ok: true, url: data.url, a11yFindings: data.a11yFindings };
}

/**
 * Unpublish a project to make it private again
 */
export async function unpublishProject(projectId: string): Promise<void> {
	await apiFetch<void>(`${API_BASE}/projects/${projectId}/unpublish`, {
		method: 'POST',
	});
}

export async function fetchProjectSnapshots(projectId: string): Promise<ProjectSnapshot[]> {
	const data = await apiFetch<{ snapshots: ProjectSnapshot[] }>(`${API_BASE}/projects/${projectId}/snapshots`);
	return data.snapshots;
}

export async function createProjectSnapshot(projectId: string, label?: string): Promise<ProjectSnapshot> {
	const data = await apiFetch<{ snapshot: ProjectSnapshot }>(`${API_BASE}/projects/${projectId}/snapshots`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(label ? { label } : {}),
	});
	return data.snapshot;
}

export async function restoreProjectSnapshot(
	projectId: string,
	snapshotId: string
): Promise<{ restoredSnapshot: ProjectSnapshot; restorePoint: ProjectSnapshot }> {
	return apiFetch<{ restoredSnapshot: ProjectSnapshot; restorePoint: ProjectSnapshot }>(
		`${API_BASE}/projects/${projectId}/snapshots/${snapshotId}/restore`,
		{
			method: 'POST',
		}
	);
}

/**
 * Fetch all template categories with metadata
 * This endpoint doesn't require authentication
 */
export async function fetchTemplateCategories(): Promise<TemplateCategory[]> {
	const data = await apiFetch<{ categories: TemplateCategory[] }>(`${API_BASE}/templates`);
	return data.categories;
}
