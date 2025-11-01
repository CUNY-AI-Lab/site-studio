const API_BASE = '/api';

export interface Project {
	id: string;
	name: string;
	published?: boolean;
	publishedUrl?: string;
	thumbnailUrl?: string;
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
	const response = await fetch(`${API_BASE}/projects`, {
		credentials: 'include',
	});

	if (!response.ok) {
		throw new Error('Failed to fetch projects');
	}

	const data = await response.json();
	return data.projects;
}

/**
 * Create a new project
 */
export async function createProject(name: string, template?: string): Promise<Project> {
	const response = await fetch(`${API_BASE}/projects`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		credentials: 'include',
		body: JSON.stringify({ name, template }),
	});

	if (!response.ok) {
		const error = await response.json().catch(() => ({ error: 'Failed to create project' }));
		throw new Error(error.error || 'Failed to create project');
	}

	return response.json();
}

/**
 * Rename an existing project
 */
export async function renameProject(projectId: string, newName: string): Promise<Project> {
	const response = await fetch(`${API_BASE}/projects/${projectId}`, {
		method: 'PATCH',
		headers: {
			'Content-Type': 'application/json',
		},
		credentials: 'include',
		body: JSON.stringify({ name: newName }),
	});

	if (!response.ok) {
		const error = await response.json().catch(() => ({ error: 'Failed to rename project' }));
		throw new Error(error.error || 'Failed to rename project');
	}

	return response.json();
}

/**
 * Delete a project
 */
export async function deleteProject(projectId: string): Promise<void> {
	const response = await fetch(`${API_BASE}/projects/${projectId}`, {
		method: 'DELETE',
		credentials: 'include',
	});

	if (!response.ok) {
		const error = await response.json().catch(() => ({ error: 'Failed to delete project' }));
		throw new Error(error.error || 'Failed to delete project');
	}
}

/**
 * Fetch files for a specific project
 */
export async function fetchProjectFiles(projectId: string): Promise<ProjectFile[]> {
	const response = await fetch(`${API_BASE}/projects/${projectId}/files`, {
		credentials: 'include',
	});

	if (!response.ok) {
		throw new Error('Failed to fetch project files');
	}

	const data = await response.json();
	return data.files;
}

/**
 * Fetch a specific file's content
 */
export async function fetchFileContent(projectId: string, filePath: string): Promise<string> {
	const response = await fetch(
		`${API_BASE}/projects/${projectId}/file?path=${encodeURIComponent(filePath)}`,
		{
			credentials: 'include',
		}
	);

	if (!response.ok) {
		throw new Error('Failed to fetch file content');
	}

	const data = await response.json();
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
	const response = await fetch(`${API_BASE}/projects/${projectId}/file`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		credentials: 'include',
		body: JSON.stringify({ path: filePath, content }),
	});

	if (!response.ok) {
		throw new Error('Failed to save file');
	}
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
		throw new Error('Upload failed');
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
		throw new Error('Download failed');
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
 * Publish a project to make it publicly accessible
 */
export async function publishProject(projectId: string): Promise<{ url: string }> {
	const response = await fetch(`${API_BASE}/projects/${projectId}/publish`, {
		method: 'POST',
		credentials: 'include',
	});

	if (!response.ok) {
		const error = await response.json().catch(() => ({ error: 'Failed to publish project' }));
		throw new Error(error.error || 'Failed to publish project');
	}

	return response.json();
}

/**
 * Unpublish a project to make it private again
 */
export async function unpublishProject(projectId: string): Promise<void> {
	const response = await fetch(`${API_BASE}/projects/${projectId}/unpublish`, {
		method: 'POST',
		credentials: 'include',
	});

	if (!response.ok) {
		const error = await response.json().catch(() => ({ error: 'Failed to unpublish project' }));
		throw new Error(error.error || 'Failed to unpublish project');
	}
}

/**
 * Fetch all template categories with metadata
 * This endpoint doesn't require authentication
 */
export async function fetchTemplateCategories(): Promise<TemplateCategory[]> {
	const response = await fetch(`${API_BASE}/templates`);

	if (!response.ok) {
		throw new Error('Failed to fetch templates');
	}

	const data = await response.json();
	return data.categories;
}
