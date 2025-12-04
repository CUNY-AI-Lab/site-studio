/**
 * Session Manager
 * Manages user sessions and project paths
 *
 * NOTE: This does NOT provide security sandboxing. Security is enforced by:
 * 1. disallowedTools in agent.ts (prevents Bash, WebSearch, etc.)
 * 2. Path validation in storage abstraction (prevents path traversal)
 * 3. Storage key prefixes (userId/projectId isolation)
 */

import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { getUserProjectPath, getUserUploadsPath } from './config.js';
import { getLogger } from '../config/logger.js';

const log = getLogger('session');

/**
 * Session data for a user's project
 */
export interface SandboxSession {
  sessionId: string;
  userId: string;
  projectId: string;
  projectPath: string;
  uploadsPath: string;
  createdAt: Date;
  lastActivity: Date;
}

/**
 * Manages sessions for users
 */
export class SandboxSessionManager {
  private activeSessions: Map<string, SandboxSession> = new Map();
  private readonly SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

  /**
   * Get or create a session for a user's project
   */
  async getOrCreateSession(userId: string, projectId: string, sessionId?: string): Promise<SandboxSession> {
    const key = sessionId || randomUUID();

    // Check if session exists and is still valid
    let session = this.activeSessions.get(key);
    if (session) {
      session.lastActivity = new Date();
      log.debug({
        sessionId: key,
        userId,
        projectId,
        age: Date.now() - session.createdAt.getTime(),
      }, 'Resuming existing session');
      return session;
    }

    // Create new session
    log.info({
      sessionId: key,
      userId,
      projectId,
      isProvided: !!sessionId,
    }, 'Creating new session');

    session = await this.createSession(userId, projectId, key);
    this.activeSessions.set(key, session);

    log.info({
      sessionId: key,
      userId,
      projectId,
      projectPath: session.projectPath,
      activeSessionCount: this.activeSessions.size,
    }, 'Session created');

    return session;
  }

  /**
   * Create a new session
   */
  private async createSession(userId: string, projectId: string, sessionId: string): Promise<SandboxSession> {
    const projectPath = getUserProjectPath(userId, projectId);
    const uploadsPath = getUserUploadsPath(userId);

    // Create directories if they don't exist
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(uploadsPath, { recursive: true });

    return {
      sessionId,
      userId,
      projectId,
      projectPath,
      uploadsPath,
      createdAt: new Date(),
      lastActivity: new Date(),
    };
  }

  /**
   * End a session
   */
  async endSession(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      log.debug({ sessionId }, 'Attempted to end non-existent session');
      return;
    }

    log.info({
      sessionId,
      userId: session.userId,
      projectId: session.projectId,
      age: Date.now() - session.createdAt.getTime(),
      activeSessionCount: this.activeSessions.size - 1,
    }, 'Ending session');

    this.activeSessions.delete(sessionId);
  }

  /**
   * Cleanup inactive sessions
   */
  async cleanupInactiveSessions(): Promise<void> {
    const now = Date.now();
    const sessionsToEnd: string[] = [];

    for (const [sessionId, session] of this.activeSessions.entries()) {
      const inactiveTime = now - session.lastActivity.getTime();
      if (inactiveTime > this.SESSION_TIMEOUT_MS) {
        sessionsToEnd.push(sessionId);
      }
    }

    if (sessionsToEnd.length > 0) {
      log.info({
        count: sessionsToEnd.length,
        totalActiveSessions: this.activeSessions.size,
      }, 'Cleaning up inactive sessions');

      for (const sessionId of sessionsToEnd) {
        await this.endSession(sessionId);
      }
    }
  }

  /**
   * Get active session count for monitoring
   */
  getActiveSessionCount(): number {
    return this.activeSessions.size;
  }
}

// Singleton instance
let sessionManager: SandboxSessionManager | null = null;

/**
 * Get the global session manager instance
 */
export function getSandboxManager(): SandboxSessionManager {
  if (!sessionManager) {
    sessionManager = new SandboxSessionManager();

    // Start cleanup interval
    setInterval(() => {
      sessionManager?.cleanupInactiveSessions();
    }, 5 * 60 * 1000); // Cleanup every 5 minutes
  }

  return sessionManager;
}
