/**
 * Frontend API error handling utilities
 * Corresponds to backend ApiError class for consistent error handling
 */

import { csrfFetch } from './csrf';
import { browserWindow, decodeJson, type JsonValue } from '$lib/contracts';

export interface ValidationDetail {
	path: string;
	message: string;
}

interface ApiErrorEnvelope {
	error?: string;
	message?: string;
	code?: string;
	details?: ValidationDetail[];
}

/**
 * Structured API error that matches backend error responses
 */
export class ApiError extends Error {
	constructor(
		public statusCode: number,
		message: string,
		public code?: string,
		public details?: ValidationDetail[]
	) {
		super(message);
		this.name = 'ApiError';
	}

	/**
	 * Check if this is a validation error (400 with details)
	 */
	isValidationError(): boolean {
		return this.statusCode === 400 && !!this.details && this.details.length > 0;
	}

	/**
	 * Get a user-friendly error message
	 */
	getUserMessage(): string {
		if (this.isValidationError() && this.details) {
			// For validation errors, show the first validation message
			return this.details[0].message;
		}
		return this.message;
	}

	/**
	 * Get all validation errors as a formatted string
	 */
	getValidationMessages(): string {
		if (!this.details || this.details.length === 0) {
			return this.message;
		}
		return this.details.map(d => `${d.path}: ${d.message}`).join('; ');
	}
}

/**
 * Redirect the browser to the standalone CAIL Doorway login, preserving where
 * to return.
 *
 * Site Studio is served directly by its Worker, so `/login` on either service
 * is not a login page. Doorway owns the protected `/site-studio/` route; send
 * the browser there and let Doorway's route policy start CUNY sign-in.
 */
const CAIL_DOORWAY_ORIGIN = 'https://cail-doorway.ailab-452.workers.dev';
const SITE_STUDIO_DOORWAY_PATH = '/site-studio';

function redirectToLogin(): void {
	const browser = browserWindow();
	if (!browser) return;
	const currentPath = browser.location.pathname;
	const safeCurrentPath = currentPath.startsWith('/') && !currentPath.startsWith('//')
		? currentPath
		: '/';
	const doorwayPath = safeCurrentPath === SITE_STUDIO_DOORWAY_PATH ||
		safeCurrentPath.startsWith(`${SITE_STUDIO_DOORWAY_PATH}/`)
		? safeCurrentPath
		: `${SITE_STUDIO_DOORWAY_PATH}${safeCurrentPath}`;
	const target = new URL(doorwayPath, CAIL_DOORWAY_ORIGIN);
	// Doorway stores this classified protected path as the login return target;
	// its route policy keeps the path on Site Studio and forwards it after auth.
	target.search = browser.location.search;
	target.hash = '';
	browser.location.assign(target.href);
}

function isAuthenticationRequiredEnvelope(status: number, errorData: ApiErrorEnvelope): boolean {
	return status === 401 && errorData?.error === 'authentication_required';
}

function maybeRedirectToLogin(status: number, errorData: ApiErrorEnvelope): void {
	if (!isAuthenticationRequiredEnvelope(status, errorData)) {
		return;
	}

	redirectToLogin();
}

function toApiError(response: Response, errorData: ApiErrorEnvelope): ApiError {
	const message = errorData.message || errorData.error || 'Something went wrong. Try again.';
	const code = errorData.code || errorData.error;
	const details = errorData.details;

	return new ApiError(response.status, message, code, details);
}

/**
 * Parse error response from API and throw ApiError.
 * Handles both structured API errors and generic network errors.
 *
 * CAIL `authentication_required` (401) redirects browsers to the SSO login so
 * the user can sign in with CUNY Login (docs/INTEGRATION.md §2). Other CAIL
 * envelopes (quota_exceeded, invalid_api_key, upstream_auth_error, …) pass
 * through unmodified as ApiError so callers can show `message` as-is.
 */
export async function handleApiError(response: Response): Promise<never> {
	let errorData: ApiErrorEnvelope;

	try {
		errorData = decodeJson<ApiErrorEnvelope>(await response.text());
	} catch {
		// Response doesn't contain JSON, throw generic error
		throw new ApiError(
			response.status,
			"That didn't work. Try again.",
			'NETWORK_ERROR'
		);
	}

	// CAIL envelopes carry a machine code in `error` and a human sentence in
	// `message`. Redirect to login on authentication_required.
	maybeRedirectToLogin(response.status, errorData);

	throw toApiError(response, errorData);
}

/**
 * Wrapper for fetch callers that need the raw Response (blob downloads, 415
 * branching) while still honoring the shared 401 authentication redirect.
 */
export async function apiResponseFetch(
	input: RequestInfo | URL,
	init?: RequestInit
): Promise<Response> {
	const response = await csrfFetch(input, init);

	if (response.status !== 401) {
		return response;
	}

	let errorData: ApiErrorEnvelope;
	try {
		errorData = decodeJson<ApiErrorEnvelope>(await response.clone().text());
	} catch {
		return response;
	}

	if (!isAuthenticationRequiredEnvelope(response.status, errorData)) {
		return response;
	}

	maybeRedirectToLogin(response.status, errorData);
	throw toApiError(response, errorData);
}

/**
 * Wrapper for fetch that automatically handles errors
 * Returns the parsed JSON response or throws ApiError
 *
 * Routes through `csrfFetch` so state-changing methods carry the anti-CSRF
 * header (CAIL INTEGRATION.md §3¾); GET/HEAD pass through without it.
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

/**
 * Check if an error is an ApiError instance
 */
export type CaughtError = ApiError | Error | string | null | undefined;

export function isApiError(error: CaughtError): error is ApiError {
	return error instanceof ApiError;
}

/**
 * Get a user-friendly error message from any error
 */
export function getErrorMessage(error: CaughtError): string {
	if (isApiError(error)) {
		return error.getUserMessage();
	}
	if (error instanceof Error) {
		return error.message;
	}
	return 'Something went wrong. Try again.';
}
