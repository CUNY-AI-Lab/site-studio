// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ApiError,
	apiResponseFetch,
	getErrorMessage,
	handleApiError,
	UserFacingError
} from './errors';

const AUTHENTICATION_REQUIRED = {
	error: {
		code: 'authentication_required',
		message: 'Please sign in to continue.',
		launch: '/launch/site-studio'
	}
} as const;
const SESSION_INVALID = {
	error: {
		code: 'session_invalid',
		message: 'Your sign-in has expired or is no longer valid. Sign in again.',
		launch: '/launch/site-studio'
	}
} as const;
const ADMISSION_REQUIRED = {
	error: {
		code: 'admission_required',
		message:
			'Your CAIL Lab membership is not currently active. Request access or contact the Lab administrator.'
	}
} as const;
const ADMISSION_UNAVAILABLE = {
	error: {
		code: 'admission_unavailable',
		message: 'Membership verification is temporarily unavailable. Try again later.'
	}
} as const;

let fetchMock: ReturnType<typeof vi.fn>;
let assignMock: ReturnType<typeof vi.fn>;

async function thrownApiError(response: Response): Promise<ApiError> {
	try {
		await handleApiError(response);
	} catch (error) {
		expect(error).toBeInstanceOf(ApiError);
		// SAFETY: handleApiError throws ApiError for a parsed canonical envelope.
		return error as ApiError;
	}
	throw new Error('Expected handleApiError to throw');
}

describe('getErrorMessage', () => {
	it('passes through ApiError user messages', () => {
		expect(getErrorMessage(new ApiError(403, 'Request access to continue.'))).toBe(
			'Request access to continue.'
		);
	});

	it('passes through UserFacingError messages', () => {
		expect(
			getErrorMessage(new UserFacingError('The connection to the assistant expired. Send your message again.'))
		).toBe('The connection to the assistant expired. Send your message again.');
	});

	it('collapses plain Errors to the generic message', () => {
		expect(getErrorMessage(new Error('ReferenceError: x is not defined'))).toBe(
			'Something went wrong. Try again.'
		);
	});
});

describe('canonical Doorway API errors', () => {
	beforeEach(() => {
		fetchMock = vi.fn();
		assignMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		vi.stubGlobal('window', {
			location: {
				origin: 'https://tools.ailab.gc.cuny.edu',
				pathname: '/site-studio/editor/project-1',
				search: '?panel=code',
				assign: assignMock
			}
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('redirects a canonical authentication_required response to the fixed Site Studio launch', async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify(AUTHENTICATION_REQUIRED), {
				status: 401,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		await expect(apiResponseFetch('/site-studio/api/projects')).rejects.toMatchObject({
			statusCode: 401,
			code: 'authentication_required',
			message: 'Please sign in to continue.'
		});

		expect(assignMock).toHaveBeenCalledWith(
			'https://tools.ailab.gc.cuny.edu/launch/site-studio'
		);
	});

	it('redirects a canonical session_invalid response to the fixed Site Studio launch', async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify(SESSION_INVALID), {
				status: 401,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		await expect(apiResponseFetch('/site-studio/api/projects')).rejects.toMatchObject({
			statusCode: 401,
			code: 'session_invalid',
			message: 'Your sign-in has expired or is no longer valid. Sign in again.'
		});
		expect(assignMock).toHaveBeenCalledWith(
			'https://tools.ailab.gc.cuny.edu/launch/site-studio'
		);
	});

	it('uses the fixed launch when a canonical response names another safe route', async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					error: {
						code: 'authentication_required',
						message: 'Please sign in to continue.',
						launch: '/launch/agent-studio'
					}
				}),
				{ status: 401, headers: { 'Content-Type': 'application/json' } }
			)
		);

		await expect(apiResponseFetch('/site-studio/api/projects')).rejects.toBeInstanceOf(ApiError);
		expect(assignMock).toHaveBeenCalledWith(
			'https://tools.ailab.gc.cuny.edu/launch/site-studio'
		);
	});

	it.each([
		'https://evil.example/login',
		'//evil.example/login',
		'/\\evil.example/login',
		'/launch/site-studio?next=https://evil.example'
	])('ignores an untrusted launch value (%s)', async (launch) => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					error: {
						code: 'authentication_required',
						message: 'Please sign in to continue.',
						launch
					}
				}),
				{ status: 401, headers: { 'Content-Type': 'application/json' } }
			)
		);

		await expect(apiResponseFetch('/site-studio/api/projects')).resolves.toBeInstanceOf(Response);
		expect(assignMock).not.toHaveBeenCalled();
	});

	it.each(['authentication_required', 'session_invalid', 'admission_required', 'admission_unavailable'])(
		'does not treat the removed flat %s envelope as a direct-service response',
		async (code) => {
			const response = new Response(JSON.stringify({ error: code }), {
				status: 401,
				headers: { 'Content-Type': 'application/json' }
			});
			fetchMock.mockResolvedValue(response);

			await expect(apiResponseFetch('/site-studio/api/projects')).resolves.toBe(response);
			expect(assignMock).not.toHaveBeenCalled();
		}
	);

	it('maps admission_required to request-access recovery UX', async () => {
		const error = await thrownApiError(
			new Response(JSON.stringify(ADMISSION_REQUIRED), {
				status: 403,
				headers: { 'Content-Type': 'application/json' }
			})
		);
		expect(error).toMatchObject({
			statusCode: 403,
			code: 'admission_required',
			message:
				'Your CAIL Lab membership is not currently active. Request access or contact the Lab administrator.'
		});
		expect(error.getRecoveryAction()).toBe('request-access');
	});

	it('maps admission_unavailable to retryable service UX', async () => {
		const error = await thrownApiError(
			new Response(JSON.stringify(ADMISSION_UNAVAILABLE), {
				status: 503,
				headers: { 'Content-Type': 'application/json' }
			})
		);
		expect(error).toMatchObject({
			statusCode: 503,
			code: 'admission_unavailable',
			message: 'Membership verification is temporarily unavailable. Try again later.'
		});
		expect(error.getRecoveryAction()).toBe('retry');
	});

	it('returns malformed and ordinary direct-service responses without an auth redirect', async () => {
		const malformed = new Response('not-json', { status: 401 });
		fetchMock.mockResolvedValue(malformed);
		await expect(apiResponseFetch('/site-studio/api/projects')).resolves.toBe(malformed);

		const direct = new Response(JSON.stringify({ error: 'unauthorized' }), {
			status: 401,
			headers: { 'Content-Type': 'application/json' }
		});
		fetchMock.mockResolvedValue(direct);
		await expect(apiResponseFetch('/site-studio/api/projects')).resolves.toBe(direct);
		expect(assignMock).not.toHaveBeenCalled();
	});
});
