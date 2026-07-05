/**
 * Frontend API error handling utilities
 * Corresponds to backend ApiError class for consistent error handling
 */

import { csrfFetch } from './csrf';

export interface ValidationDetail {
	path: string;
	message: string;
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
 * Redirect the browser to the CAIL SSO login, preserving where to return.
 *
 * The SSO gate serves `/login?rt=<same-origin-path>` (docs/INTEGRATION.md §2).
 * Only same-origin paths are used as the return target to avoid open-redirects.
 */
function redirectToLogin(loginUrl: string): void {
	if (typeof window === 'undefined') return;
	const rt = window.location.pathname + window.location.search;
	// Ignore any absolute login_url the backend might send; always same-origin.
	const path = loginUrl && loginUrl.startsWith('/') ? loginUrl : '/login';
	window.location.assign(`${path}?rt=${encodeURIComponent(rt)}`);
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
	let errorData: any;

	try {
		errorData = await response.json();
	} catch {
		// Response doesn't contain JSON, throw generic error
		throw new ApiError(
			response.status,
			`Request failed with status ${response.status}`,
			'NETWORK_ERROR'
		);
	}

	// CAIL envelopes carry a machine code in `error` and a human sentence in
	// `message`. Redirect to login on authentication_required.
	if (response.status === 401 && errorData.error === 'authentication_required') {
		redirectToLogin(typeof errorData.login_url === 'string' ? errorData.login_url : '/login');
	}

	// Extract error information from response
	const message = errorData.message || errorData.error || 'An error occurred';
	const code = errorData.code || errorData.error;
	const details = errorData.details;

	throw new ApiError(response.status, message, code, details);
}

/**
 * Wrapper for fetch that automatically handles errors
 * Returns the parsed JSON response or throws ApiError
 *
 * Routes through `csrfFetch` so state-changing methods carry the anti-CSRF
 * header (CAIL INTEGRATION.md §3¾); GET/HEAD pass through without it.
 */
export async function apiFetch<T = any>(
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
export function isApiError(error: unknown): error is ApiError {
	return error instanceof ApiError;
}

/**
 * Get a user-friendly error message from any error
 */
export function getErrorMessage(error: unknown): string {
	if (isApiError(error)) {
		return error.getUserMessage();
	}
	if (error instanceof Error) {
		return error.message;
	}
	return 'An unexpected error occurred';
}
