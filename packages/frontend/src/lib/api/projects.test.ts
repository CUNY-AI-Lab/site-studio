import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { invalidateCsrfToken } from './csrf';
import { uploadProjectFile } from './projects';

const CSRF_COOKIE = 'cail_csrf_sitestudio';
type FetchFunction = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
let fetchMock: Mock<FetchFunction>;

function setCookieToken(token: string | null): void {
	if (token === null) {
		document.cookie = `${CSRF_COOKIE}=; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
		return;
	}
	document.cookie = `${CSRF_COOKIE}=${token}`;
}

function uploadedResponse(path: string, filename: string, size: number): Response {
	return new Response(
		JSON.stringify({
			success: true,
			filename,
			path,
			size,
			message: `Uploaded ${filename}`
		}),
		{ status: 200, headers: { 'Content-Type': 'application/json' } }
	);
}

describe('project uploads', () => {
	beforeEach(() => {
		invalidateCsrfToken();
		setCookieToken('test-csrf-token');
		fetchMock = vi.fn<FetchFunction>();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		invalidateCsrfToken();
		setCookieToken(null);
	});

	it('sends the exact file bytes in ordinary multipart form data', async () => {
		const bytes = new Uint8Array([0, 17, 34, 255, 8]);
		const file = new File([bytes], 'index.html', { type: 'text/html' });
		fetchMock.mockResolvedValue(uploadedResponse('index.html', 'index.html', bytes.byteLength));

		const result = await uploadProjectFile('project-a', file);

		expect(result).toEqual({
			success: true,
			filename: 'index.html',
			path: 'index.html',
			size: bytes.byteLength,
			message: 'Uploaded index.html'
		});
		expect(fetchMock).toHaveBeenCalledOnce();
		const [request, init] = fetchMock.mock.calls[0];
		expect(String(request)).toBe('/api/projects/project-a/upload');
		expect(init?.method).toBe('POST');
		expect(init?.credentials).toBe('include');
		const headers = new Headers(init?.headers);
		expect(headers.get('X-CSRF-Token')).toBe('test-csrf-token');
		expect(headers.has('Content-Type')).toBe(false);
		expect(init?.body).toBeInstanceOf(FormData);

		const formData = init?.body;
		if (!(formData instanceof FormData)) throw new Error('expected multipart form data');
		expect(formData.get('dir')).toBeNull();
		const uploaded = formData.get('file');
		if (!(uploaded instanceof File)) throw new Error('expected uploaded file');
		expect(uploaded.name).toBe('index.html');
		expect(Array.from(new Uint8Array(await uploaded.arrayBuffer()))).toEqual(
			Array.from(bytes)
		);
	});

	it('adds the images directory only for image-manager uploads', async () => {
		const file = new File(['png bytes'], 'photo.png', { type: 'image/png' });
		fetchMock.mockResolvedValue(uploadedResponse('images/photo.png', 'photo.png', file.size));

		await uploadProjectFile('project-a', file, 'images');

		const [, init] = fetchMock.mock.calls[0];
		const formData = init?.body;
		if (!(formData instanceof FormData)) throw new Error('expected multipart form data');
		expect(formData.get('dir')).toBe('images');
		const uploaded = formData.get('file');
		if (!(uploaded instanceof File)) throw new Error('expected uploaded file');
		expect(uploaded.name).toBe('photo.png');
	});
});
