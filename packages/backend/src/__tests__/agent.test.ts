import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

const mockQuery = vi.fn();
const mockCreateSdkMcpServer = vi.fn(() => ({ name: 'mock-server' }));
const mockGetSandboxConfig = vi.fn();
const mockBuildSandboxSettings = vi.fn();
const mockGetSyncService = vi.fn();
const mockCreateFileTools = vi.fn(() => []);
const mockCreateTemplateTools = vi.fn(() => []);

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockQuery,
  createSdkMcpServer: mockCreateSdkMcpServer,
}));

vi.mock('../config/sandbox-config.js', () => ({
  getSandboxConfig: mockGetSandboxConfig,
  buildSandboxSettings: mockBuildSandboxSettings,
}));

vi.mock('../services/project-sync.js', () => ({
  getSyncService: mockGetSyncService,
}));

vi.mock('../tools/file-tools.js', () => ({
  createFileTools: mockCreateFileTools,
}));

vi.mock('../tools/template-tools.js', () => ({
  createTemplateTools: mockCreateTemplateTools,
}));

function createMockStream() {
  return {
    close: vi.fn(),
    async *[Symbol.asyncIterator]() {
      // No-op stream for configuration tests.
    },
  };
}

describe('runSiteAgent', () => {
  let runSiteAgent: typeof import('../agent.js').runSiteAgent;
  let originalStorageType: string | undefined;

  beforeEach(async () => {
    vi.resetModules();
    mockQuery.mockReset();
    mockCreateSdkMcpServer.mockClear();
    mockGetSandboxConfig.mockReset();
    mockBuildSandboxSettings.mockReset();
    mockGetSyncService.mockReset();
    mockCreateFileTools.mockClear();
    mockCreateTemplateTools.mockClear();

    originalStorageType = process.env.STORAGE_TYPE;
    process.env.STORAGE_TYPE = 'r2';

    mockGetSandboxConfig.mockReturnValue({
      enabled: true,
      autoAllowBash: true,
      network: { allowLocalBinding: false },
    });
    mockBuildSandboxSettings.mockReturnValue({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      network: { allowLocalBinding: false },
    });
    mockQuery.mockReturnValue(createMockStream());

    ({ runSiteAgent } = await import('../agent.js'));
  });

  afterEach(() => {
    if (originalStorageType === undefined) {
      delete process.env.STORAGE_TYPE;
    } else {
      process.env.STORAGE_TYPE = originalStorageType;
    }
  });

  it('syncs sandbox edits back to R2 through a PostToolUse hook', async () => {
    const sync = vi.fn().mockResolvedValue({
      filesUploaded: 1,
      filesDeleted: 0,
      errors: [],
    });
    mockGetSyncService.mockReturnValue({ sync });

    await runSiteAgent(
      'Update the homepage',
      '/tmp/project-a',
      undefined,
      'plan',
      undefined,
      'user-1',
      'project-a'
    );

    const options = mockQuery.mock.calls[0][0].options as Options;
    const postToolUseHook = options.hooks?.PostToolUse?.[0]?.hooks?.[0];

    expect(postToolUseHook).toBeTypeOf('function');

    const result = await postToolUseHook?.({ tool_name: 'Edit' }, 'tool-use-1');

    expect(sync).toHaveBeenCalledWith('user-1', 'project-a', '/tmp/project-a');
    expect(result).toEqual({});
  });

  it('returns structured stop output when the R2 sync hook reports errors', async () => {
    const sync = vi.fn().mockResolvedValue({
      filesUploaded: 0,
      filesDeleted: 0,
      errors: ['upload failed for index.html'],
    });
    mockGetSyncService.mockReturnValue({ sync });

    await runSiteAgent(
      'Update the homepage',
      '/tmp/project-a',
      undefined,
      'plan',
      undefined,
      'user-1',
      'project-a'
    );

    const options = mockQuery.mock.calls[0][0].options as Options;
    const postToolUseHook = options.hooks?.PostToolUse?.[0]?.hooks?.[0];
    const result = await postToolUseHook?.({ tool_name: 'Write' }, 'tool-use-2');

    expect(sync).toHaveBeenCalledWith('user-1', 'project-a', '/tmp/project-a');
    expect(result).toMatchObject({
      continue: false,
      stopReason: 'Project sync failed',
      systemMessage: expect.stringContaining('upload failed for index.html'),
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: expect.stringContaining('upload failed for index.html'),
      },
    });
  });
});
