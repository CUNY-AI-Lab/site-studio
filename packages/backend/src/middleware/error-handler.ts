import { Request, Response, NextFunction } from 'express';

/**
 * Custom API error class for throwing application-specific errors
 */
export class ApiError extends Error {
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
 * Sanitizes error messages and prevents internal details from leaking to clients
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
 * Usage: app.get('/path', asyncHandler(async (req, res) => { ... }))
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
