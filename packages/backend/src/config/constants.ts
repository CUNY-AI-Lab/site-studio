/**
 * Application constants
 * Centralizes magic numbers and configuration values for maintainability
 */

// ============================================================================
// Time Constants (in milliseconds)
// ============================================================================

/** One hour in milliseconds */
export const ONE_HOUR_MS = 60 * 60 * 1000;

/** 15 minutes in milliseconds */
export const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

/** One day in milliseconds */
export const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** 30 days in milliseconds (default session duration) */
export const THIRTY_DAYS_MS = 30 * ONE_DAY_MS;

/** One minute in milliseconds */
export const ONE_MINUTE_MS = 60 * 1000;

// ============================================================================
// Session Constants
// ============================================================================

/** Default session cookie max age (30 days) */
export const SESSION_COOKIE_MAX_AGE = THIRTY_DAYS_MS;

/** Default session TTL in days */
export const DEFAULT_SESSION_TTL_DAYS = 30;

/** Session cleanup interval for memory store (1 hour) */
export const SESSION_CLEANUP_INTERVAL_MS = ONE_HOUR_MS;

/** Session cookie name */
export const SESSION_COOKIE_NAME = 'site-studio-session';

// ============================================================================
// Rate Limiting Constants
// ============================================================================

/** Rate limit window duration (15 minutes) */
export const RATE_LIMIT_WINDOW_MS = FIFTEEN_MINUTES_MS;

/** Max requests per window for general API endpoints */
export const API_RATE_LIMIT_MAX = 100;

/** Max requests per window for agent query endpoints */
export const AGENT_RATE_LIMIT_MAX = 10;

/** Max requests per window for file upload endpoints */
export const UPLOAD_RATE_LIMIT_MAX = 20;

/** Max requests per window for authentication endpoints */
export const AUTH_RATE_LIMIT_MAX = 5;

// ============================================================================
// File Upload Constants
// ============================================================================

/** Maximum file upload size (32 MB) */
export const MAX_FILE_SIZE = 32 * 1024 * 1024;

/** Maximum file upload size as human-readable string */
export const MAX_FILE_SIZE_DISPLAY = '32 MB';

// ============================================================================
// Server Constants
// ============================================================================

/** Default server port if PORT environment variable is not set */
export const DEFAULT_PORT = 3001;

/** Default server host */
export const DEFAULT_HOST = '0.0.0.0';

// ============================================================================
// Validation Constants
// ============================================================================

/** Maximum project name length */
export const MAX_PROJECT_NAME_LENGTH = 100;

/** Minimum project name length */
export const MIN_PROJECT_NAME_LENGTH = 1;
