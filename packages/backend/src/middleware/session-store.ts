/**
 * Session storage abstraction for Site Studio
 * Allows switching between in-memory and R2-based session storage
 */

export interface User {
  id: string;
  email?: string;
  createdAt: Date;
}

export interface StoredSession {
  user: User;
  expiresAt: Date;
}

/**
 * Session store interface
 * Implementations: MemorySessionStore, R2SessionStore
 */
export interface ISessionStore {
  /**
   * Get a session by ID
   */
  get(sessionId: string): Promise<User | null>;

  /**
   * Set/update a session
   */
  set(sessionId: string, user: User, ttlDays?: number): Promise<void>;

  /**
   * Delete a session
   */
  delete(sessionId: string): Promise<void>;

  /**
   * Get count of active sessions (for monitoring)
   */
  count(): Promise<number>;

  /**
   * Clean up expired sessions
   */
  cleanup(): Promise<number>;
}
