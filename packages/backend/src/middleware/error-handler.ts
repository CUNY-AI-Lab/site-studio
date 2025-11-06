import { Request, Response, NextFunction } from 'express';

/**
 * Custom API error class for throwing application-specific errors
 *
 * Use this class to throw errors with specific HTTP status codes and error codes.
 * These errors are handled by the errorHandler middleware and returned to clients
 * with appropriate status codes.
 *
 * @example
 * throw new ApiError(404, 'Project not found', 'PROJECT_NOT_FOUND');
 * throw new ApiError(403, 'Insufficient permissions', 'FORBIDDEN');
 */
export class ApiError extends Error {
  /**
   * @param {number} statusCode - HTTP status code (e.g., 400, 404, 500)
   * @param {string} message - User-friendly error message
   * @param {string} [code] - Optional machine-readable error code
   */
  constructor(
    public statusCode: number,
    message: string,
    public code?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Global error handling middleware
 *
 * Centralizes error handling across all routes. Logs full error details server-side
 * while returning sanitized messages to clients to prevent information disclosure.
 *
 * Handles three error types:
 * 1. ApiError - Returns specified status code and message
 * 2. ValidationError/ZodError - Returns 400 with validation message
 * 3. Unknown errors - Returns 500 with generic message
 *
 * @param {Error} error - The error that was thrown
 * @param {Request} req - Express request object
 * @param {Response} res - Express response object
 * @param {NextFunction} next - Express next function (unused but required by Express)
 *
 * @example
 * // Apply as last middleware in Express app
 * app.use(errorHandler);
 */
export function errorHandler(
  error: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Log full error details server-side for debugging
  console.error('[API Error]', {
    path: req.path,
    method: req.method,
    error: error.message,
    stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
  });

  // Handle known ApiError instances with specific status codes
  if (error instanceof ApiError) {
    res.status(error.statusCode).json({
      error: error.message,
      code: error.code,
    });
    return;
  }

  // Handle validation errors (from Zod or other validators)
  if (error.name === 'ValidationError' || error.name === 'ZodError') {
    res.status(400).json({
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
    });
    return;
  }

  // Default to 500 Internal Server Error with sanitized message
  // Never expose internal error details to clients
  res.status(500).json({
    error: 'An internal error occurred. Please try again.',
    code: 'INTERNAL_ERROR',
  });
}

/**
 * Async route handler wrapper to catch errors and pass to error middleware
 *
 * Wraps async route handlers to automatically catch rejected promises and pass
 * them to Express error handling middleware. Without this, unhandled promise
 * rejections in route handlers would crash the server.
 *
 * @param {Function} fn - Async route handler function
 * @returns {Function} Wrapped route handler that catches errors
 *
 * @example
 * app.get('/api/projects', asyncHandler(async (req, res) => {
 *   const projects = await getProjects();
 *   res.json(projects);
 * }));
 *
 * @example
 * // Without asyncHandler, this would crash the server on error
 * app.get('/bad', async (req, res) => {
 *   throw new Error('Unhandled!'); // Server crash
 * });
 *
 * // With asyncHandler, error is caught and handled properly
 * app.get('/good', asyncHandler(async (req, res) => {
 *   throw new ApiError(404, 'Not found'); // Properly handled
 * }));
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
