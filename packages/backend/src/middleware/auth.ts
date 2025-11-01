import { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import type { User } from '../types/user.js';
import { ISessionStore } from './session-store.js';
import { R2SessionStore } from './r2-session-store.js';
import { MemorySessionStore } from './memory-session-store.js';

// Extended Express Request to include user
export interface AuthenticatedRequest extends Request {
  user: User;
}

// Session store instance (initialized on first use)
let sessionStore: ISessionStore | null = null;

/**
 * Get or create the session store based on STORAGE_TYPE
 */
function getSessionStore(): ISessionStore {
  if (!sessionStore) {
    const storageType = process.env.STORAGE_TYPE || 'filesystem';

    if (storageType === 'r2') {
      const accountId = process.env.R2_ACCOUNT_ID;
      const accessKeyId = process.env.R2_ACCESS_KEY_ID;
      const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
      const bucketName = process.env.R2_BUCKET_NAME || 'site-studio';

      if (!accountId || !accessKeyId || !secretAccessKey) {
        throw new Error('R2 credentials not configured');
      }

      sessionStore = new R2SessionStore(accountId, accessKeyId, secretAccessKey, bucketName);
      console.log('Using R2 session storage');
    } else {
      sessionStore = new MemorySessionStore();
      console.log('Using in-memory session storage (sessions will not persist across restarts)');
    }
  }

  return sessionStore;
}

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
export async function authenticateUser(req: Request, res: Response, next: NextFunction) {
  const authReq = req as AuthenticatedRequest;
  const store = getSessionStore();

  try {
    // Check for existing session ID in cookie or header
    let sessionId = req.cookies?.['site-studio-session'] || req.headers['x-session-id'] as string;

    // If no session exists, create a new one
    if (!sessionId) {
      sessionId = randomBytes(32).toString('hex');
      const newUser: User = {
        id: generateUserId(),
        createdAt: new Date(),
      };
      await store.set(sessionId, newUser);

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
    let user = await store.get(sessionId);

    // Session expired or invalid - create new one
    if (!user) {
      sessionId = randomBytes(32).toString('hex');
      user = {
        id: generateUserId(),
        createdAt: new Date(),
      };
      await store.set(sessionId, user);

      res.cookie('site-studio-session', sessionId, {
        httpOnly: true,
        maxAge: 30 * 24 * 60 * 60 * 1000,
        sameSite: 'lax',
      });
    }

    authReq.user = user;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
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
export async function clearSession(req: Request, res: Response) {
  const sessionId = req.cookies?.['site-studio-session'] || req.headers['x-session-id'] as string;
  const store = getSessionStore();

  if (sessionId) {
    await store.delete(sessionId);
  }

  res.clearCookie('site-studio-session');
  res.json({ message: 'Session cleared' });
}

/**
 * Get session count for monitoring
 */
export async function getSessionCount(): Promise<number> {
  const store = getSessionStore();
  return await store.count();
}

/**
 * Cleanup old sessions (call periodically)
 */
export async function cleanupSessions(): Promise<number> {
  const store = getSessionStore();
  return await store.cleanup();
}
