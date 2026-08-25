export type FileTreeRefreshSource = 'project-load' | 'manual' | 'agent';

export interface FileTreeRefreshRequest {
	projectId: string;
	contextVersion: number;
	source: FileTreeRefreshSource;
	reloadCurrentFile: boolean;
	refreshPreview: boolean;
}

export interface FileTreeRefreshCallbacks<T> {
	load: (projectId: string) => Promise<T>;
	isCurrent: (request: FileTreeRefreshRequest) => boolean;
	onLoaded: (request: FileTreeRefreshRequest, value: T) => void | Promise<void>;
	onError: (request: FileTreeRefreshRequest, error: Error) => void | Promise<void>;
}

export interface FileTreeRefreshCoordinator {
	request: (request: FileTreeRefreshRequest) => Promise<void>;
	dispose: () => void;
}

function mergeRequests(
	current: FileTreeRefreshRequest,
	next: FileTreeRefreshRequest
): FileTreeRefreshRequest {
	if (current.projectId !== next.projectId || current.contextVersion !== next.contextVersion) {
		return next;
	}

	return {
		...next,
		reloadCurrentFile: current.reloadCurrentFile || next.reloadCurrentFile,
		refreshPreview: current.refreshPreview || next.refreshPreview
	};
}

/**
 * Keep file-tree reads single-flight while coalescing invalidations that happen
 * during the current read. The parent owns the callbacks so a stale project
 * response cannot update a newer project or clear its error state.
 */
export function createFileTreeRefreshCoordinator<T>(
	callbacks: FileTreeRefreshCallbacks<T>
): FileTreeRefreshCoordinator {
	let pending: FileTreeRefreshRequest | null = null;
	let inFlight: Promise<void> | null = null;
	let disposed = false;

	async function run(): Promise<void> {
		while (!disposed && pending) {
			const request = pending;
			pending = null;

			let value: T;
			try {
				value = await callbacks.load(request.projectId);
			} catch (error) {
				if (!disposed && callbacks.isCurrent(request)) {
					await callbacks.onError(
						request,
						error instanceof Error ? error : new Error('File tree refresh failed')
					);
				}
				continue;
			}

			if (!disposed && callbacks.isCurrent(request)) {
				try {
					await callbacks.onLoaded(request, value);
				} catch (error) {
					await callbacks.onError(
						request,
						error instanceof Error ? error : new Error('File tree refresh failed')
					);
				}
			}
		}
	}

	function request(next: FileTreeRefreshRequest): Promise<void> {
		if (disposed) return Promise.resolve();

		pending = pending ? mergeRequests(pending, next) : next;
		if (!inFlight) {
			inFlight = run().finally(() => {
				inFlight = null;
			});
		}
		return inFlight;
	}

	function dispose(): void {
		disposed = true;
		pending = null;
	}

	return { request, dispose };
}
