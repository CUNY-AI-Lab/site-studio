import { SandboxManager as AnthropicSandboxManager } from '@anthropic-ai/sandbox-runtime';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { createUserSandboxConfig, getUserProjectPath, getUserUploadsPath, type SandboxConfig } from './config.js';
import type { UserSession } from '../types/user.js';

/**
 * Manages sandboxed environments for users
 */
export class SandboxSessionManager {
  private activeSessions: Map<string, SandboxSession> = new Map();
  private readonly SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

  /**
   * Get or create a sandbox session for a user's project
   */
  async getOrCreateSession(userId: string, projectId: string, sessionId?: string): Promise<SandboxSession> {
    // Generate a valid UUID for Claude Code if no session ID provided
    const key = sessionId || randomUUID();

    // Check if session exists and is still valid
    let session = this.activeSessions.get(key);
    if (session) {
      session.lastActivity = new Date();
      return session;
    }

    // Create new session
    session = await this.createSession(userId, projectId, key);
    this.activeSessions.set(key, session);

    return session;
  }

  /**
   * Create a new sandboxed session
   */
  private async createSession(userId: string, projectId: string, sessionId: string): Promise<SandboxSession> {
    // Create user project directory if it doesn't exist
    const projectPath = getUserProjectPath(userId, projectId);
    const uploadsPath = getUserUploadsPath(userId);

    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(uploadsPath, { recursive: true });

    // Generate sandbox configuration
    const config = createUserSandboxConfig(userId, projectId);

    // Note: AnthropicSandboxManager.initialize() is called globally
    // The sandbox configuration is applied when wrapping commands
    // Store config for later use when wrapping tool executions

    const session: SandboxSession = {
      sessionId,
      userId,
      projectId,
      projectPath,
      uploadsPath,
      config,
      createdAt: new Date(),
      lastActivity: new Date(),
    };

    return session;
  }

  /**
   * End a sandbox session and cleanup resources
   */
  async endSession(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      return;
    }

    this.activeSessions.delete(sessionId);
    // Note: AnthropicSandboxManager doesn't expose a cleanup method yet
    // Resources are cleaned up when the process ends
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

    for (const sessionId of sessionsToEnd) {
      await this.endSession(sessionId);
    }
  }

  /**
   * Get active session count for monitoring
   */
  getActiveSessionCount(): number {
    return this.activeSessions.size;
  }

  /**
   * Validate that a path is within the user's sandbox
   */
  validatePath(session: SandboxSession, requestedPath: string): string {
    const resolvedPath = path.resolve(session.projectPath, requestedPath);

    // Ensure the path stays within the project directory
    if (!resolvedPath.startsWith(session.projectPath)) {
      throw new Error('Access denied: Path outside sandbox boundary');
    }

    return resolvedPath;
  }

  /**
   * Execute a command within the sandbox
   */
  async executeSandboxed(session: SandboxSession, command: string): Promise<string> {
    // Update last activity
    session.lastActivity = new Date();

    try {
      // Wrap command with sandbox runtime
      const wrappedCommand = await AnthropicSandboxManager.wrapWithSandbox(command);
      return wrappedCommand;
    } catch (error) {
      throw new Error(`Sandbox execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}

export interface SandboxSession {
  sessionId: string;
  userId: string;
  projectId: string;
  projectPath: string;
  uploadsPath: string;
  config: SandboxConfig;
  createdAt: Date;
  lastActivity: Date;
}

// Singleton instance
let sandboxManager: SandboxSessionManager | null = null;

/**
 * Get the global sandbox manager instance
 */
export function getSandboxManager(): SandboxSessionManager {
  if (!sandboxManager) {
    sandboxManager = new SandboxSessionManager();

    // Start cleanup interval
    setInterval(() => {
      sandboxManager?.cleanupInactiveSessions();
    }, 5 * 60 * 1000); // Cleanup every 5 minutes
  }

  return sandboxManager;
}
