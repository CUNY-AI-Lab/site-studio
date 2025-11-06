import { z } from 'zod';
import { Request, Response, NextFunction } from 'express';

/**
 * Zod validation schemas for API request bodies and query parameters
 */

// Project-related schemas
export const createProjectSchema = z.object({
  name: z.string().min(1, 'Project name is required').max(100, 'Project name too long'),
  template: z.string().optional(),
});

export const renameProjectSchema = z.object({
  name: z.string().min(1, 'New project name is required').max(100, 'Project name too long'),
});

// File operation schemas
export const saveFileSchema = z.object({
  path: z.string().min(1, 'File path is required'),
  content: z.string(), // Can be empty string
});

export const renameFileSchema = z.object({
  oldPath: z.string().min(1, 'Old path is required'),
  newPath: z.string().min(1, 'New path is required'),
});

// Agent query schemas
export const querySchema = z.object({
  prompt: z.string().min(1, 'Prompt is required'),
  projectId: z.string().min(1, 'Project ID is required'),
  sessionId: z.string().optional(),
  mode: z.enum(['plan', 'execute']).optional(),
  uploadedFile: z.string().optional(),
});

export const approvalSchema = z.object({
  sessionId: z.string().min(1, 'Session ID is required'),
  projectId: z.string().min(1, 'Project ID is required'),
});

/**
 * Validation middleware factory
 * Returns Express middleware that validates request body against a Zod schema
 */
export function validateBody<T extends z.ZodSchema>(schema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const validated = schema.parse(req.body);
      req.body = validated; // Replace with validated/sanitized data
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: 'Validation failed',
          details: error.errors.map(err => ({
            path: err.path.join('.'),
            message: err.message,
          })),
        });
        return;
      }
      next(error);
    }
  };
}

/**
 * Validation middleware for query parameters
 */
export function validateQuery<T extends z.ZodSchema>(schema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const validated = schema.parse(req.query);
      req.query = validated as any; // Type assertion needed for Express
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: 'Validation failed',
          details: error.errors.map(err => ({
            path: err.path.join('.'),
            message: err.message,
          })),
        });
        return;
      }
      next(error);
    }
  };
}

/**
 * Validation middleware for URL parameters
 */
export function validateParams<T extends z.ZodSchema>(schema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const validated = schema.parse(req.params);
      req.params = validated as any;
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: 'Validation failed',
          details: error.errors.map(err => ({
            path: err.path.join('.'),
            message: err.message,
          })),
        });
        return;
      }
      next(error);
    }
  };
}
