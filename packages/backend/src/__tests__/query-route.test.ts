import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const mocks = vi.hoisted(() => {
  const storage = {
    projectExists: vi.fn(),
  };

  const syncService = {
    hydrate: vi.fn(),
    sync: vi.fn(),
  };

  const sandboxSession = {
    sessionId: 'sandbox-session',
    userId: 'user-1',
    projectId: 'project-a',
    projectPath: '/tmp/site-studio-query-route',
    uploadsPath: '/tmp/site-studio-query-route/uploads',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    lastActivity: new Date('2026-01-01T00:00:00Z'),
  };

  return {
    authenticateUser: vi.fn((req: any, _res: any, next: () => void) => {
      req.user = {
        id: 'user-1',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      };
      next();
    }),
    sessionStore: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      count: vi.fn().mockResolvedValue(0),
      cleanup: vi.fn().mockResolvedValue(0),
    },
    storage,
    syncService,
    sandboxManager: {
      getOrCreateSession: vi.fn().mockResolvedValue(sandboxSession),
      cleanupInactiveSessions: vi.fn().mockResolvedValue(undefined),
    },
    runSiteAgent: vi.fn(),
  };
});

vi.mock('../agent.js', () => ({
  runSiteAgent: mocks.runSiteAgent,
}));

vi.mock('../middleware/auth.js', () => ({
  authenticateUser: mocks.authenticateUser,
  getSessionStoreInstance: vi.fn(() => mocks.sessionStore),
}));

vi.mock('../storage/index.js', () => ({
  initializeStorage: vi.fn().mockResolvedValue(undefined),
  getStorage: vi.fn(() => mocks.storage),
}));

vi.mock('../services/project-sync.js', () => ({
  createSyncService: vi.fn(() => mocks.syncService),
  getSyncService: vi.fn(() => mocks.syncService),
}));

vi.mock('../sandbox/manager.js', () => ({
  getSandboxManager: vi.fn(() => mocks.sandboxManager),
}));

type MockStreamEvent = Record<string, unknown>;

function createMockStream(events: MockStreamEvent[]) {
  return {
    close: vi.fn(),
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function createBlockingStream() {
  let resolveClosed: (() => void) | null = null;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  return {
    close: vi.fn(() => {
      resolveClosed?.();
    }),
    async *[Symbol.asyncIterator]() {
      await closed;
    },
  };
}

describe('/api/query', () => {
  let baseUrl: string;
  let closeServerFn: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.PORT = '0';
    process.env.STORAGE_TYPE = 'r2';
    process.env.AUTH_MODE = 'anonymous';
    process.env.AGENT_SANDBOX_ENABLED = 'true';
    process.env.R2_ACCOUNT_ID = 'test-account';
    process.env.R2_ACCESS_KEY_ID = 'test-access-key';
    process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
    process.env.R2_BUCKET_NAME = 'test-bucket';
    process.env.INTERNAL_AUTH_TOKEN = 'test-internal-token';

    const serverModule = await import('../index.js');
    if (!serverModule.server.listening) {
      await once(serverModule.server, 'listening');
    }
    const address = serverModule.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    closeServerFn = serverModule.closeServer;
  });

  afterAll(async () => {
    if (closeServerFn) {
      await closeServerFn();
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storage.projectExists.mockResolvedValue(true);
    mocks.syncService.hydrate.mockResolvedValue({
      filesDownloaded: 1,
      errors: [],
    });
    mocks.runSiteAgent.mockResolvedValue(
      createMockStream([
        { type: 'system', subtype: 'init', session_id: 'agent-session-1' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } },
      ])
    );
  });

  it('returns a 502 JSON error when project hydration fails before the stream starts', async () => {
    mocks.syncService.hydrate.mockResolvedValue({
      filesDownloaded: 0,
      errors: ['download failed'],
    });

    const response = await fetch(`${baseUrl}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Update the site',
        projectId: 'project-a',
        mode: 'plan',
      }),
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('Project files could not be loaded from storage'),
      code: 'PROJECT_HYDRATION_FAILED',
    });
    expect(mocks.runSiteAgent).not.toHaveBeenCalled();
  });

  it('forwards agent error events over SSE so sync failures surface to the client', async () => {
    mocks.runSiteAgent.mockResolvedValue(
      createMockStream([
        { type: 'system', subtype: 'init', session_id: 'agent-session-2' },
        {
          type: 'error',
          error: 'Project changes could not be synced back to storage: upload failed for index.html',
        },
      ])
    );

    const response = await fetch(`${baseUrl}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Update the site',
        projectId: 'project-a',
        mode: 'plan',
      }),
    });

    expect(response.ok).toBe(true);
    const body = await response.text();

    expect(body).toContain('"type":"error"');
    expect(body).toContain('Project changes could not be synced back to storage');
    expect(body).toContain('[DONE]');
  });

  it('cleans up pending tool interactions when the client disconnects mid-stream', async () => {
    const blockingStream = createBlockingStream();
    mocks.runSiteAgent.mockImplementation(
      async (
        _prompt: string,
        _projectPath: string,
        _sessionId: string | undefined,
        _mode: 'plan' | 'execute',
        _sandboxSession: unknown,
        _userId: string,
        _projectId: string,
        toolInteractionCallback?: (request: any) => void
      ) => {
        toolInteractionCallback?.({
          id: 'approval-1',
          kind: 'approval',
          toolName: 'Write',
          input: { file_path: 'index.html' },
          resolve: vi.fn(),
        });

        return blockingStream;
      }
    );

    const requestId = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        `${baseUrl}/api/query`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
        },
        (res) => {
          res.setEncoding('utf8');
          let body = '';

          res.on('data', (chunk) => {
            body += chunk;
            const match = body.match(/"request_id":"([^"]+)"/);
            if (match) {
              req.destroy();
              resolve(match[1]);
            }
          });

          res.on('error', reject);
        }
      );

      req.on('error', (error) => {
        if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') {
          return;
        }
        reject(error);
      });

      req.write(JSON.stringify({
        prompt: 'Update the site',
        projectId: 'project-a',
        mode: 'plan',
      }));
      req.end();
    });

    await delay(50);

    const approvalResponse = await fetch(`${baseUrl}/api/query/tool-approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId,
        approved: true,
      }),
    });

    expect(approvalResponse.status).toBe(404);
    await expect(approvalResponse.json()).resolves.toMatchObject({
      error: 'Approval request not found or expired',
    });
    expect(blockingStream.close).toHaveBeenCalledTimes(1);
  });
});
