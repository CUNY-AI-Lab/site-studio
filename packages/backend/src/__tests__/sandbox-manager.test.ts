import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

describe('SandboxSessionManager', () => {
  let sandboxesDir: string;

  beforeEach(async () => {
    sandboxesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-manager-test-'));
    process.env.SANDBOXES_DIR = sandboxesDir;
    vi.resetModules();
  });

  afterEach(async () => {
    delete process.env.SANDBOXES_DIR;
    vi.resetModules();
    await fs.rm(sandboxesDir, { recursive: true, force: true });
  });

  it('creates a fresh session when a provided session ID belongs to another project', async () => {
    const { SandboxSessionManager } = await import('../sandbox/manager.js');

    const manager = new SandboxSessionManager();
    const originalSession = await manager.getOrCreateSession('user-1', 'project-a', 'shared-session');
    const mismatchedSession = await manager.getOrCreateSession('user-1', 'project-b', 'shared-session');

    expect(mismatchedSession.sessionId).not.toBe(originalSession.sessionId);
    expect(mismatchedSession.projectId).toBe('project-b');
    expect(mismatchedSession.projectPath).not.toBe(originalSession.projectPath);

    const resumedOriginal = await manager.getOrCreateSession('user-1', 'project-a', 'shared-session');
    expect(resumedOriginal.sessionId).toBe(originalSession.sessionId);
    expect(resumedOriginal.projectId).toBe('project-a');
  });
});
