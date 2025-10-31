import { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import type { User } from '../types/user.js';

// Extended Express Request to include user
export interface AuthenticatedRequest extends Request {
  user: User;
}

// In-memory session store (replace with Redis/database in production)
const sessions = new Map<string, User>();

/**
 * Generate a simple user ID for demo purposes
 * In production, replace with proper authentication (OAuth, JWT, etc.)
 */
function generateUserId(): string {
  return `user_${randomBytes(16).toString('hex')}`;
}

/**
 * Get or create a user session based on a session cookie
 * This is a simplified auth system for demo purposes
 */
export function authenticateUser(req: Request, res: Response, next: NextFunction) {
  const authReq = req as AuthenticatedRequest;

  // Check for existing session ID in cookie or header
  let sessionId = req.cookies?.['site-studio-session'] || req.headers['x-session-id'] as string;

  // If no session exists, create a new one
  if (!sessionId) {
    sessionId = randomBytes(32).toString('hex');
    const newUser: User = {
      id: generateUserId(),
      createdAt: new Date(),
    };
    sessions.set(sessionId, newUser);

    // Set session cookie (httpOnly for security)
    res.cookie('site-studio-session', sessionId, {
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      sameSite: 'lax',
    });

    authReq.user = newUser;
    return next();
  }

  // Retrieve existing user session
  let user = sessions.get(sessionId);

  // Session expired or invalid - create new one
  if (!user) {
    sessionId = randomBytes(32).toString('hex');
    user = {
      id: generateUserId(),
      createdAt: new Date(),
    };
    sessions.set(sessionId, user);

    res.cookie('site-studio-session', sessionId, {
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
    });
  }

  authReq.user = user;
  next();
}

/**
 * Require authentication - returns 401 if not authenticated
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authReq = req as AuthenticatedRequest;

  if (!authReq.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  next();
}

/**
 * Optional: Clear a user session (logout)
 */
export function clearSession(req: Request, res: Response) {
  const sessionId = req.cookies?.['site-studio-session'] || req.headers['x-session-id'] as string;

  if (sessionId) {
    sessions.delete(sessionId);
  }

  res.clearCookie('site-studio-session');
  res.json({ message: 'Session cleared' });
}

/**
 * Get session count for monitoring
 */
export function getSessionCount(): number {
  return sessions.size;
}

/**
 * Cleanup old sessions (call periodically)
 */
export function cleanupSessions() {
  // In production, implement proper session expiration logic
  // For now, this is a placeholder
}
