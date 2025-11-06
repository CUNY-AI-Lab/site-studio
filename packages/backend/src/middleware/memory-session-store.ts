/**
 * In-memory session storage for Site Studio
 * Used for development and filesystem storage mode
 * Sessions are lost on server restart
 */

import { ISessionStore, User, StoredSession } from './session-store.js';
import { getLogger } from '../config/logger.js';
import { SESSION_CLEANUP_INTERVAL_MS } from '../config/constants.js';

const log = getLogger('session-store');

export class MemorySessionStore implements ISessionStore {
  private sessions: Map<string, StoredSession>;
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    this.sessions = new Map();

    // Run cleanup every hour to prevent memory leaks
    this.cleanupInterval = setInterval(() => {
      this.cleanup().then((count) => {
        if (count > 0) {
          log.info({ cleanedSessions: count }, 'Cleaned up expired sessions');
        }
      }).catch((error) => {
        log.error({ error }, 'Error during session cleanup');
      });
    }, SESSION_CLEANUP_INTERVAL_MS);

    // Ensure cleanup runs even if process is shutting down
    process.on('SIGTERM', () => this.destroy());
    process.on('SIGINT', () => this.destroy());
  }

  /**
   * Stop the cleanup interval (for graceful shutdown)
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  /**
   * Get a session by ID
   */
  async get(sessionId: string): Promise<User | null> {
    const stored = this.sessions.get(sessionId);

    if (!stored) {
      return null;
    }

    // Check if session has expired
    if (stored.expiresAt < new Date()) {
      // Session expired, delete it
      this.sessions.delete(sessionId);
      return null;
    }

    return stored.user;
  }

  /**
   * Set/update a session
   */
  async set(sessionId: string, user: User, ttlDays: number = 30): Promise<void> {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + ttlDays);

    const stored: StoredSession = {
      user,
      expiresAt,
    };

    this.sessions.set(sessionId, stored);
  }

  /**
   * Delete a session
   */
  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  /**
   * Get count of active sessions
   */
  async count(): Promise<number> {
    // Clean up expired sessions first
    await this.cleanup();
    return this.sessions.size;
  }

  /**
   * Clean up expired sessions
   */
  async cleanup(): Promise<number> {
    const now = new Date();
    let cleanedCount = 0;

    for (const [sessionId, stored] of this.sessions.entries()) {
      if (stored.expiresAt < now) {
        this.sessions.delete(sessionId);
        cleanedCount++;
      }
    }

    return cleanedCount;
  }
}
