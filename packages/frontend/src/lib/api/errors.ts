/** Shared frontend API error handling for Doorway and the direct Worker. */

import { csrfFetch } from './csrf';
import { type JsonValue } from '$lib/contracts';
import {
	ApiError,
	handleApiErrorResponse,
	redirectCanonicalAuthentication
} from './error-handler';

export {
	ApiError,
	parseApiErrorEnvelope,
	type ApiErrorEnvelope,
	type ValidationDetail
} from './error-handler';

/**
 * Parse an error response from either the canonical Doorway envelope or the
 * direct Worker's non-gate API envelope, redirecting canonical auth failures.
 */
export async function handleApiError(response: Response): Promise<never> {
	return handleApiErrorResponse(response);
}

/**
 * Wrapper for callers that need the raw Response (blob downloads or status
 * branching) while still honoring the canonical Doorway auth redirect.
 */
export async function apiResponseFetch(
	input: RequestInfo | URL,
	init?: RequestInit
): Promise<Response> {
	const response = await csrfFetch(input, init);
	const authError = await redirectCanonicalAuthentication(response);
	if (authError) {
		throw new ApiError(
			response.status,
			authError.message,
			authError.code
		);
	}
	return response;
}

/**
 * Wrapper for fetch that automatically handles errors and returns parsed JSON.
 * State-changing calls route through csrfFetch; GET/HEAD calls carry only
 * credentials.
 */
export async function apiFetch<T = JsonValue>(
	url: string,
	options?: RequestInit
): Promise<T> {
	const response = await csrfFetch(url, options);
	if (!response.ok) {
		await handleApiError(response);
	}

	return response.json();
}

export type CaughtError = ApiError | Error | string | null | undefined;

export function isApiError(error: CaughtError): error is ApiError {
	return error instanceof ApiError;
}

export function getErrorMessage(error: CaughtError): string {
	if (isApiError(error)) {
		return error.getUserMessage();
	}
	if (error instanceof Error) {
		return error.message;
	}
	return 'Something went wrong. Try again.';
}
