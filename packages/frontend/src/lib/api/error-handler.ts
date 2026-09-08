import {
	CAIL_CANONICAL_ORIGIN,
	CAIL_AUTH_ERROR_CODES,
	parseCailAuthErrorJson,
	type CailAuthError
} from '@cuny-ai-lab/cail-identity';
import { browserWindow } from '$lib/contracts';
import { z } from 'zod';

export interface ValidationDetail {
	path: string;
	message: string;
}

interface DirectApiErrorEnvelope {
	source: 'direct';
	error: string;
	message?: string;
	code?: string;
	details?: ValidationDetail[];
}

interface CanonicalApiErrorEnvelope {
	source: 'canonical';
	error: CailAuthError;
}

export type ApiErrorEnvelope = DirectApiErrorEnvelope | CanonicalApiErrorEnvelope;

const AUTHENTICATION_REQUIRED = 'authentication_required';
const SESSION_INVALID = 'session_invalid';
const SIGN_IN_CODES = new Set([AUTHENTICATION_REQUIRED, SESSION_INVALID]);
const CANONICAL_ERROR_CODES: ReadonlySet<string> = new Set(CAIL_AUTH_ERROR_CODES);
const SITE_STUDIO_LAUNCH_PATH = '/launch/site-studio';

const directApiErrorEnvelopeSchema = z.object({
	error: z.string().refine(
		(code) => !CANONICAL_ERROR_CODES.has(code),
		'Auth errors must use the canonical nested envelope'
	),
	message: z.string().optional(),
	code: z.string().optional(),
	details: z.array(z.object({ path: z.string(), message: z.string() })).optional()
});

/** Parse canonical auth envelopes through the shared cail-identity primitive. */
export function parseApiErrorEnvelope(payload: string): ApiErrorEnvelope {
	const canonical = parseCailAuthErrorJson(payload);
	if (canonical !== null) {
		return { source: 'canonical', error: canonical.error };
	}

	const direct = directApiErrorEnvelopeSchema.safeParse(JSON.parse(payload));
	if (direct.success) {
		return { source: 'direct', ...direct.data };
	}

	throw new Error('Invalid API error envelope');
}

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

	isValidationError(): boolean {
		return this.statusCode === 400 && !!this.details && this.details.length > 0;
	}

	getUserMessage(): string {
		if (this.isValidationError() && this.details) {
			return this.details[0].message;
		}
		return this.message;
	}

	getRecoveryAction(): 'sign-in' | 'request-access' | 'retry' | 'none' {
		if (this.code && SIGN_IN_CODES.has(this.code)) return 'sign-in';
		if (this.code === 'admission_required') return 'request-access';
		if (this.code === 'admission_unavailable') return 'retry';
		return 'none';
	}
}

function maybeRedirectToLogin(status: number, errorData: ApiErrorEnvelope): void {
	if (
		status !== 401 ||
		errorData.source !== 'canonical' ||
		!SIGN_IN_CODES.has(errorData.error.code)
	) {
		return;
	}

	const browser = browserWindow();
	if (!browser) return;

	// The shared parser validates the received launch field, but Site Studio's
	// route is fixed. Never turn a response value or current URL into a redirect.
	const target = new URL(SITE_STUDIO_LAUNCH_PATH, CAIL_CANONICAL_ORIGIN);
	browser.location.assign(target.href);
}

function toApiError(response: Response, errorData: ApiErrorEnvelope): ApiError {
	const message =
		errorData.source === 'canonical'
			? errorData.error.message
			: errorData.message || errorData.error || 'Something went wrong. Try again.';
	const code = errorData.source === 'canonical' ? errorData.error.code : errorData.code || errorData.error;
	const details = errorData.source === 'canonical' ? undefined : errorData.details;

	return new ApiError(response.status, message, code, details);
}

export async function handleApiErrorResponse(response: Response): Promise<never> {
	let errorData: ApiErrorEnvelope;

	try {
		errorData = parseApiErrorEnvelope(await response.text());
	} catch {
		throw new ApiError(response.status, "That didn't work. Try again.", 'NETWORK_ERROR');
	}

	maybeRedirectToLogin(response.status, errorData);
	throw toApiError(response, errorData);
}

export async function redirectCanonicalAuthentication(
	response: Response
): Promise<CailAuthError | null> {
	if (response.status !== 401) return null;

	try {
		const errorData = parseApiErrorEnvelope(await response.clone().text());
		if (
			errorData.source !== 'canonical' ||
			!SIGN_IN_CODES.has(errorData.error.code)
		) {
			return null;
		}
		maybeRedirectToLogin(response.status, errorData);
		return errorData.error;
	} catch {
		return null;
	}
}
