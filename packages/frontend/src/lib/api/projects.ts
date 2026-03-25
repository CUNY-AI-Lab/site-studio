import { resolvePath } from '$lib/utils/paths';
import { apiFetch, handleApiError } from './errors';

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
 * Fetch files for a specific project
 */
export async function fetchProjectFiles(projectId: string): Promise<ProjectFile[]> {
	const data = await apiFetch<{ files: ProjectFile[] }>(`${API_BASE}/projects/${projectId}/files`);
	return data.files;
}

/**
 * Fetch a specific file's content
 */
export async function fetchFileContent(projectId: string, filePath: string): Promise<string> {
	const data = await apiFetch<{ content: string }>(
		`${API_BASE}/projects/${projectId}/file?path=${encodeURIComponent(filePath)}`
	);
	return data.content;
}

/**
 * Save file content
 */
export async function saveFileContent(
	projectId: string,
	filePath: string,
	content: string
): Promise<void> {
	await apiFetch<void>(`${API_BASE}/projects/${projectId}/file`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ path: filePath, content }),
	});
}

/**
 * Upload a file to the project
 */
export async function uploadFile(projectId: string, file: File): Promise<string> {
	const formData = new FormData();
	formData.append('file', file);

	const response = await fetch(`${API_BASE}/projects/${projectId}/upload`, {
		method: 'POST',
		credentials: 'include',
		body: formData,
	});

	if (!response.ok) {
		await handleApiError(response);
	}

	const data = await response.json();
	return data.filename;
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
 * Upload a generated thumbnail image (PNG) for a project
 */
export async function uploadThumbnail(projectId: string, blob: Blob): Promise<void> {
	const form = new FormData();
	form.append('image', blob, 'thumbnail.png');

	const response = await fetch(`${API_BASE}/projects/${projectId}/thumbnail`, {
		method: 'POST',
		credentials: 'include',
		body: form,
	});

	if (!response.ok) {
		// Non-fatal for UX; throw structured error so callers can handle
		await handleApiError(response);
	}
}

/**
 * Publish a project to make it publicly accessible
 */
export async function publishProject(projectId: string): Promise<{ url: string }> {
	return apiFetch<{ url: string }>(`${API_BASE}/projects/${projectId}/publish`, {
		method: 'POST',
	});
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
