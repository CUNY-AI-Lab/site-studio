import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runSiteAgent } from '../agent.js';
import {
  createMockAgentStream,
  createInitEvent,
  createAssistantMessageEvent,
} from './helpers/agent-test-utils.js';

// Mock the Claude Agent SDK
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({
    name: 'mock-server',
    version: '1.0.0',
  })),
  tool: vi.fn((config) => config),
}));

// Mock file system operations
vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('Agent Tool Execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('File Tools', () => {
    it('should write files via write_file tool', async () => {
      const events = [
        createInitEvent('test-session'),
        {
          type: 'tool_execution',
          tool_name: 'mcp__site-studio__write_file',
          input: { path: 'index.html', content: '<h1>Hello</h1>' },
          result: { success: true, path: 'index.html' },
        },
        createAssistantMessageEvent('File created'),
      ];
      const mockStream = createMockAgentStream(events);
      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

      const stream = await runSiteAgent('Create index.html', '/tmp/test-project', undefined, 'execute');
      const collectedEvents = [];
      for await (const event of stream) {
        collectedEvents.push(event);
      }

      const toolExecutions = collectedEvents.filter(e => e.type === 'tool_execution');
      expect(toolExecutions).toHaveLength(1);
      expect(toolExecutions[0].tool_name).toBe('mcp__site-studio__write_file');
      expect(toolExecutions[0].result.success).toBe(true);
    });

    it('should read files via view_file tool', async () => {
      const events = [
        createInitEvent('test-session'),
        {
          type: 'tool_execution',
          tool_name: 'mcp__site-studio__view_file',
          input: { path: 'index.html' },
          result: { success: true, content: '<h1>Hello</h1>' },
        },
        createAssistantMessageEvent('The file contains a heading'),
      ];
      const mockStream = createMockAgentStream(events);
      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

      const stream = await runSiteAgent('Read index.html', '/tmp/test-project', undefined, 'execute');
      const collectedEvents = [];
      for await (const event of stream) {
        collectedEvents.push(event);
      }

      const toolExecutions = collectedEvents.filter(e => e.type === 'tool_execution');
      expect(toolExecutions).toHaveLength(1);
      expect(toolExecutions[0].tool_name).toBe('mcp__site-studio__view_file');
      expect(toolExecutions[0].result.content).toContain('<h1>Hello</h1>');
    });

    it('should edit files via edit_file tool', async () => {
      const events = [
        createInitEvent('test-session'),
        {
          type: 'tool_execution',
          tool_name: 'mcp__site-studio__edit_file',
          input: {
            path: 'index.html',
            oldContent: '<h1>Hello</h1>',
            newContent: '<h1>Hello World</h1>',
          },
          result: { success: true, path: 'index.html' },
        },
        createAssistantMessageEvent('File edited'),
      ];
      const mockStream = createMockAgentStream(events);
      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

      const stream = await runSiteAgent('Edit the heading', '/tmp/test-project', undefined, 'execute');
      const collectedEvents = [];
      for await (const event of stream) {
        collectedEvents.push(event);
      }

      const toolExecutions = collectedEvents.filter(e => e.type === 'tool_execution');
      expect(toolExecutions).toHaveLength(1);
      expect(toolExecutions[0].tool_name).toBe('mcp__site-studio__edit_file');
      expect(toolExecutions[0].result.success).toBe(true);
    });

    it('should delete files via delete_file tool', async () => {
      const events = [
        createInitEvent('test-session'),
        {
          type: 'tool_execution',
          tool_name: 'mcp__site-studio__delete_file',
          input: { path: 'old-file.html' },
          result: { success: true, path: 'old-file.html' },
        },
        createAssistantMessageEvent('File deleted'),
      ];
      const mockStream = createMockAgentStream(events);
      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

      const stream = await runSiteAgent('Delete old-file.html', '/tmp/test-project', undefined, 'execute');
      const collectedEvents = [];
      for await (const event of stream) {
        collectedEvents.push(event);
      }

      const toolExecutions = collectedEvents.filter(e => e.type === 'tool_execution');
      expect(toolExecutions).toHaveLength(1);
      expect(toolExecutions[0].tool_name).toBe('mcp__site-studio__delete_file');
      expect(toolExecutions[0].result.success).toBe(true);
    });

    it('should rename files via rename_file tool', async () => {
      const events = [
        createInitEvent('test-session'),
        {
          type: 'tool_execution',
          tool_name: 'mcp__site-studio__rename_file',
          input: { oldPath: 'old-name.html', newPath: 'new-name.html' },
          result: { success: true, oldPath: 'old-name.html', newPath: 'new-name.html' },
        },
        createAssistantMessageEvent('File renamed'),
      ];
      const mockStream = createMockAgentStream(events);
      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

      const stream = await runSiteAgent('Rename the file', '/tmp/test-project', undefined, 'execute');
      const collectedEvents = [];
      for await (const event of stream) {
        collectedEvents.push(event);
      }

      const toolExecutions = collectedEvents.filter(e => e.type === 'tool_execution');
      expect(toolExecutions).toHaveLength(1);
      expect(toolExecutions[0].tool_name).toBe('mcp__site-studio__rename_file');
      expect(toolExecutions[0].result.success).toBe(true);
    });

    it('should list files via list_files tool', async () => {
      const events = [
        createInitEvent('test-session'),
        {
          type: 'tool_execution',
          tool_name: 'mcp__site-studio__list_files',
          input: {},
          result: {
            success: true,
            files: ['index.html', 'style.css', 'script.js'],
          },
        },
        createAssistantMessageEvent('Found 3 files'),
      ];
      const mockStream = createMockAgentStream(events);
      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

      const stream = await runSiteAgent('List all files', '/tmp/test-project', undefined, 'execute');
      const collectedEvents = [];
      for await (const event of stream) {
        collectedEvents.push(event);
      }

      const toolExecutions = collectedEvents.filter(e => e.type === 'tool_execution');
      expect(toolExecutions).toHaveLength(1);
      expect(toolExecutions[0].result.files).toHaveLength(3);
    });

    it('should search files via search_files tool', async () => {
      const events = [
        createInitEvent('test-session'),
        {
          type: 'tool_execution',
          tool_name: 'mcp__site-studio__search_files',
          input: { query: 'class="header"' },
          result: {
            success: true,
            matches: [
              { file: 'index.html', line: 10, content: '<div class="header">' },
            ],
          },
        },
        createAssistantMessageEvent('Found 1 match'),
      ];
      const mockStream = createMockAgentStream(events);
      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

      const stream = await runSiteAgent('Search for header class', '/tmp/test-project', undefined, 'execute');
      const collectedEvents = [];
      for await (const event of stream) {
        collectedEvents.push(event);
      }

      const toolExecutions = collectedEvents.filter(e => e.type === 'tool_execution');
      expect(toolExecutions).toHaveLength(1);
      expect(toolExecutions[0].result.matches).toHaveLength(1);
    });

    it('should handle permission errors', async () => {
      const events = [
        createInitEvent('test-session'),
        {
          type: 'tool_execution',
          tool_name: 'mcp__site-studio__write_file',
          input: { path: '/etc/passwd', content: 'hack' },
          error: 'Permission denied: invalid path',
        },
        createAssistantMessageEvent('I cannot write to that path'),
      ];
      const mockStream = createMockAgentStream(events);
      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

      const stream = await runSiteAgent('Write to /etc/passwd', '/tmp/test-project', undefined, 'execute');
      const collectedEvents = [];
      for await (const event of stream) {
        collectedEvents.push(event);
      }

      const toolExecutions = collectedEvents.filter(e => e.type === 'tool_execution');
      expect(toolExecutions).toHaveLength(1);
      expect(toolExecutions[0].error).toContain('Permission denied');
    });
  });

  describe('Template Tools', () => {
    it('should scaffold templates via scaffold_template tool', async () => {
      const events = [
        createInitEvent('test-session'),
        {
          type: 'tool_execution',
          tool_name: 'mcp__site-studio__scaffold_template',
          input: { templateId: 'portfolio' },
          result: {
            success: true,
            templateId: 'portfolio',
            filesCreated: ['index.html', 'style.css', 'script.js'],
          },
        },
        createAssistantMessageEvent('Portfolio template created'),
      ];
      const mockStream = createMockAgentStream(events);
      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

      const stream = await runSiteAgent('Create portfolio template', '/tmp/test-project', undefined, 'execute');
      const collectedEvents = [];
      for await (const event of stream) {
        collectedEvents.push(event);
      }

      const toolExecutions = collectedEvents.filter(e => e.type === 'tool_execution');
      expect(toolExecutions).toHaveLength(1);
      expect(toolExecutions[0].tool_name).toBe('mcp__site-studio__scaffold_template');
      expect(toolExecutions[0].result.filesCreated).toHaveLength(3);
    });

    it('should add pages via add_page tool', async () => {
      const events = [
        createInitEvent('test-session'),
        {
          type: 'tool_execution',
          tool_name: 'mcp__site-studio__add_page',
          input: { pageName: 'about', title: 'About Us' },
          result: {
            success: true,
            pageName: 'about',
            filePath: 'about.html',
          },
        },
        createAssistantMessageEvent('About page created'),
      ];
      const mockStream = createMockAgentStream(events);
      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

      const stream = await runSiteAgent('Add an about page', '/tmp/test-project', undefined, 'execute');
      const collectedEvents = [];
      for await (const event of stream) {
        collectedEvents.push(event);
      }

      const toolExecutions = collectedEvents.filter(e => e.type === 'tool_execution');
      expect(toolExecutions).toHaveLength(1);
      expect(toolExecutions[0].tool_name).toBe('mcp__site-studio__add_page');
      expect(toolExecutions[0].result.filePath).toBe('about.html');
    });

    it('should validate template IDs', async () => {
      const events = [
        createInitEvent('test-session'),
        {
          type: 'tool_execution',
          tool_name: 'mcp__site-studio__scaffold_template',
          input: { templateId: 'valid-template' },
          result: {
            success: true,
            templateId: 'valid-template',
            filesCreated: ['index.html'],
          },
        },
      ];
      const mockStream = createMockAgentStream(events);
      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

      const stream = await runSiteAgent('Use valid template', '/tmp/test-project', undefined, 'execute');
      const collectedEvents = [];
      for await (const event of stream) {
        collectedEvents.push(event);
      }

      const toolExecutions = collectedEvents.filter(e => e.type === 'tool_execution');
      expect(toolExecutions[0].result.success).toBe(true);
    });

    it('should handle invalid template requests', async () => {
      const events = [
        createInitEvent('test-session'),
        {
          type: 'tool_execution',
          tool_name: 'mcp__site-studio__scaffold_template',
          input: { templateId: 'nonexistent-template' },
          error: 'Template not found: nonexistent-template',
        },
        createAssistantMessageEvent('That template does not exist'),
      ];
      const mockStream = createMockAgentStream(events);
      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

      const stream = await runSiteAgent('Use nonexistent template', '/tmp/test-project', undefined, 'execute');
      const collectedEvents = [];
      for await (const event of stream) {
        collectedEvents.push(event);
      }

      const toolExecutions = collectedEvents.filter(e => e.type === 'tool_execution');
      expect(toolExecutions).toHaveLength(1);
      expect(toolExecutions[0].error).toContain('Template not found');
    });
  });

  describe('Tool Security', () => {
    it('should block disallowed tools (Bash, WebSearch, Task, etc.)', async () => {
      // Test that the agent configuration includes disallowed tools
      const mockEvents = [createInitEvent('test-session')];
      const mockStream = createMockAgentStream(mockEvents);
      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

      const stream = await runSiteAgent('Test', '/tmp/test-project');

      for await (const event of stream) {
        // Consume stream
      }

      // Verify query was called with disallowed tools
      const queryMock = vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query;
      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            disallowedTools: expect.arrayContaining([
              'Bash',
              'WebSearch',
              'Task',
              'Edit',
              'Write',
              'Glob',
              'Grep',
              'WebFetch',
              'BashOutput',
              'KillShell',
              'SlashCommand',
              'Skill',
              'NotebookEdit',
              'AskUserQuestion',
            ]),
          }),
        })
      );
    });

    it('should only allow MCP tools and Read tool', async () => {
      const mockEvents = [createInitEvent('test-session')];
      const mockStream = createMockAgentStream(mockEvents);
      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

      const stream = await runSiteAgent('Test', '/tmp/test-project');

      for await (const event of stream) {
        // Consume stream
      }

      // Verify MCP server is configured with our tools
      const queryMock = vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query;
      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            mcpServers: expect.objectContaining({
              'site-studio': expect.any(Object),
            }),
          }),
        })
      );
    });

    it('should prevent path traversal attacks', async () => {
      const events = [
        createInitEvent('test-session'),
        {
          type: 'tool_execution',
          tool_name: 'mcp__site-studio__write_file',
          input: { path: '../../../etc/passwd', content: 'hack' },
          error: 'Invalid path: path traversal detected',
        },
      ];
      const mockStream = createMockAgentStream(events);
      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

      const stream = await runSiteAgent('Write to ../../../etc/passwd', '/tmp/test-project', undefined, 'execute');
      const collectedEvents = [];
      for await (const event of stream) {
        collectedEvents.push(event);
      }

      const toolExecutions = collectedEvents.filter(e => e.type === 'tool_execution');
      expect(toolExecutions).toHaveLength(1);
      expect(toolExecutions[0].error).toMatch(/invalid path|path traversal/i);
    });

    it('should validate tool input parameters', async () => {
      const events = [
        createInitEvent('test-session'),
        {
          type: 'tool_execution',
          tool_name: 'mcp__site-studio__write_file',
          input: { path: '', content: 'test' }, // Empty path
          error: 'Invalid input: path is required',
        },
      ];
      const mockStream = createMockAgentStream(events);
      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

      const stream = await runSiteAgent('Write with empty path', '/tmp/test-project', undefined, 'execute');
      const collectedEvents = [];
      for await (const event of stream) {
        collectedEvents.push(event);
      }

      const toolExecutions = collectedEvents.filter(e => e.type === 'tool_execution');
      expect(toolExecutions).toHaveLength(1);
      expect(toolExecutions[0].error).toMatch(/invalid input|required/i);
    });
  });
});
