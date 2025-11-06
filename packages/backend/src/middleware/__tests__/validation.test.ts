import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import {
  validateBody,
  createProjectSchema,
  renameProjectSchema,
  saveFileSchema,
  querySchema,
} from '../validation.js';

describe('Validation Middleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockRequest = {
      body: {},
    };

    mockResponse = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    mockNext = vi.fn();
  });

  describe('createProjectSchema', () => {
    it('should validate valid project creation data', () => {
      mockRequest.body = {
        name: 'My New Project',
        template: 'portfolio-minimal',
      };

      const middleware = validateBody(createProjectSchema);
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it('should reject missing project name', () => {
      mockRequest.body = {};

      const middleware = validateBody(createProjectSchema);
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Validation failed',
          details: expect.any(Array),
        })
      );
    });

    it('should reject project name that is too long', () => {
      mockRequest.body = {
        name: 'a'.repeat(101),
      };

      const middleware = validateBody(createProjectSchema);
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(400);
    });
  });

  describe('saveFileSchema', () => {
    it('should validate valid file save data', () => {
      mockRequest.body = {
        path: 'index.html',
        content: '<html></html>',
      };

      const middleware = validateBody(saveFileSchema);
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should allow empty content', () => {
      mockRequest.body = {
        path: 'styles.css',
        content: '',
      };

      const middleware = validateBody(saveFileSchema);
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should reject missing path', () => {
      mockRequest.body = {
        content: 'test',
      };

      const middleware = validateBody(saveFileSchema);
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(400);
    });
  });

  describe('querySchema', () => {
    it('should validate valid agent query', () => {
      mockRequest.body = {
        prompt: 'Create a homepage',
        projectId: 'my-project',
        mode: 'plan',
      };

      const middleware = validateBody(querySchema);
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should reject invalid mode', () => {
      mockRequest.body = {
        prompt: 'Create a homepage',
        projectId: 'my-project',
        mode: 'invalid',
      };

      const middleware = validateBody(querySchema);
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(400);
    });
  });
});
