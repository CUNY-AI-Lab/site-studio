import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { authenticateUser, type AuthenticatedRequest } from '../auth.js';

describe('Authentication Middleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockRequest = {
      cookies: {},
      headers: {},
    };

    mockResponse = {
      cookie: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    mockNext = vi.fn();
  });

  it('should create a new session for anonymous mode when no session cookie exists', async () => {
    // Set AUTH_MODE to anonymous
    process.env.AUTH_MODE = 'anonymous';

    await authenticateUser(
      mockRequest as Request,
      mockResponse as Response,
      mockNext
    );

    // Should set a cookie
    expect(mockResponse.cookie).toHaveBeenCalledWith(
      'site-studio-session',
      expect.any(String),
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'lax',
      })
    );

    // Should call next
    expect(mockNext).toHaveBeenCalled();
  });

  it('should return 401 in required auth mode when no session cookie exists', async () => {
    // Set AUTH_MODE to required
    process.env.AUTH_MODE = 'required';

    await authenticateUser(
      mockRequest as Request,
      mockResponse as Response,
      mockNext
    );

    // Should return 401
    expect(mockResponse.status).toHaveBeenCalledWith(401);
    expect(mockResponse.json).toHaveBeenCalledWith({
      error: 'Authentication required',
    });
  });

  it('should accept session ID from header', async () => {
    process.env.AUTH_MODE = 'anonymous';
    mockRequest.headers = {
      'x-session-id': 'test-session-id',
    };

    await authenticateUser(
      mockRequest as Request,
      mockResponse as Response,
      mockNext
    );

    // Should process the session
    expect(mockNext).toHaveBeenCalled();
  });
});
