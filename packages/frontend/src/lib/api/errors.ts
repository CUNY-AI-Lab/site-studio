/**
 * Frontend API error handling utilities
 * Corresponds to backend ApiError class for consistent error handling
 */

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
 * Parse error response from API and throw ApiError
 * Handles both structured API errors and generic network errors
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

	// Extract error information from response
	const message = errorData.error || errorData.message || 'An error occurred';
	const code = errorData.code;
	const details = errorData.details;

	throw new ApiError(response.status, message, code, details);
}

/**
 * Wrapper for fetch that automatically handles errors
 * Returns the parsed JSON response or throws ApiError
 */
export async function apiFetch<T = any>(
	url: string,
	options?: RequestInit
): Promise<T> {
	const response = await fetch(url, {
		credentials: 'include',
		...options,
	});

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
