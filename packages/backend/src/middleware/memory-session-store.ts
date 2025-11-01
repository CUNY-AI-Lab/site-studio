/**
 * In-memory session storage for Site Studio
 * Used for development and filesystem storage mode
 * Sessions are lost on server restart
 */

import { ISessionStore, User, StoredSession } from './session-store.js';

export class MemorySessionStore implements ISessionStore {
  private sessions: Map<string, StoredSession>;

  constructor() {
    this.sessions = new Map();
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
