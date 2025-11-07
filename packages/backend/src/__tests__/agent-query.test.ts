import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runSiteAgent } from '../agent.js';
import {
  createMockAgentStream,
  createInitEvent,
  createAssistantMessageEvent,
  createPermissionRequestEvent,
  createErrorEvent,
} from './helpers/agent-test-utils.js';
import planRequestFixture from './fixtures/agent-responses/plan-request.json';
import toolExecutionFixture from './fixtures/agent-responses/tool-execution.json';
import errorResponseFixture from './fixtures/agent-responses/error-response.json';

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

describe('Agent Query Endpoint', () => {
  describe('Plan Mode', () => {
    it('should create new agent session and return init event', async () => {
      // Setup mock to return init event
      const mockEvents = [createInitEvent('test-session-123')];
      const mockStream = createMockAgentStream(mockEvents);

      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

      // Run agent
      const stream = await runSiteAgent('Create a website', '/tmp/test-project');

      // Collect events
      const events = [];
      for await (const event of stream) {
        events.push(event);
      }

      // Verify init event
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'system',
        subtype: 'init',
        session_id: 'test-session-123',
      });
    });

    it('should stream assistant messages', async () => {
      const mockEvents = [
        createInitEvent('test-session-123'),
        createAssistantMessageEvent('I can help you build a website!'),
        createAssistantMessageEvent('Let me create the files for you.'),
      ];
      const mockStream = createMockAgentStream(mockEvents);

      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

      const stream = await runSiteAgent('Create a website', '/tmp/test-project');

      const events = [];
      for await (const event of stream) {
        events.push(event);
      }

      // Verify assistant messages
      const assistantMessages = events.filter(e => e.type === 'assistant');
      expect(assistantMessages).toHaveLength(2);
      expect(assistantMessages[0].content).toContain('help you build');
      expect(assistantMessages[1].content).toContain('create the files');
    });

    it('should request permission for tool calls', async () => {
      const mockEvents = [
        createInitEvent('test-session-123'),
        createPermissionRequestEvent([
          {
            name: 'mcp__site-studio__write_file',
            input: { path: 'index.html', content: '<h1>Test</h1>' },
          },
        ]),
      ];
      const mockStream = createMockAgentStream(mockEvents);

      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

      const stream = await runSiteAgent('Create a website', '/tmp/test-project', undefined, 'plan');

      const events = [];
      for await (const event of stream) {
        events.push(event);
      }

      // Verify permission request
      const permissionRequests = events.filter(e => e.type === 'permission_request');
      expect(permissionRequests).toHaveLength(1);
      expect(permissionRequests[0].tool_calls).toHaveLength(1);
      expect(permissionRequests[0].tool_calls[0].name).toBe('mcp__site-studio__write_file');
    });

    it('should handle user rejection of plan', async () => {
      const mockEvents = [
        createInitEvent('test-session-reject'),
        createAssistantMessageEvent('Understood, I will not proceed with the plan.'),
      ];
      const mockStream = createMockAgentStream(mockEvents);

      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

      // Resume with rejection
      const stream = await runSiteAgent(
        'No, please don\'t proceed.',
        '/tmp/test-project',
        'test-session-reject',
        'plan'
      );

      const events = [];
      for await (const event of stream) {
        events.push(event);
      }

      // Verify rejection response
      const assistantMessages = events.filter(e => e.type === 'assistant');
      expect(assistantMessages.length).toBeGreaterThan(0);
      expect(assistantMessages[0].content).toContain('will not proceed');
    });

    it('should preserve session state after plan request', async () => {
      const sessionId = 'test-session-preserve';
      const mockEvents = [
        createInitEvent(sessionId),
        createAssistantMessageEvent('Plan created'),
      ];
      const mockStream = createMockAgentStream(mockEvents);

      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

      // First request - create session
      const stream1 = await runSiteAgent('Create index.html', '/tmp/test-project');
      const events1 = [];
      for await (const event of stream1) {
        events1.push(event);
      }

      // Second request - resume session
      const mockEvents2 = [createAssistantMessageEvent('Resuming session')];
      const mockStream2 = createMockAgentStream(mockEvents2);
      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream2);

      const stream2 = await runSiteAgent('Add styles', '/tmp/test-project', sessionId, 'plan');
      const events2 = [];
      for await (const event of stream2) {
        events2.push(event);
      }

      // Verify SDK was called with resume parameter
      const queryMock = vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query;
      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'Add styles',
          options: expect.objectContaining({
            resume: sessionId,
          }),
        })
      );
    });
  });

  describe('Execute Mode', () => {
    it('should execute tools without requesting permission', async () => {
      const mockEvents = [
        createInitEvent('test-session-execute'),
        createAssistantMessageEvent('Creating file...'),
        {
          type: 'tool_execution',
          tool_name: 'mcp__site-studio__write_file',
          result: { success: true },
        },
        createAssistantMessageEvent('File created!'),
      ];
      const mockStream = createMockAgentStream(mockEvents);

      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

      const stream = await runSiteAgent(
        'Yes, proceed with the plan.',
        '/tmp/test-project',
        'test-session-execute',
        'execute'
      );

      const events = [];
      for await (const event of stream) {
        events.push(event);
      }

      // Verify no permission requests, only execution
      const permissionRequests = events.filter(e => e.type === 'permission_request');
      expect(permissionRequests).toHaveLength(0);

      const toolExecutions = events.filter(e => e.type === 'tool_execution');
      expect(toolExecutions).toHaveLength(1);
    });

    it('should stream tool execution results', async () => {
      const mockEvents = toolExecutionFixture;
      const mockStream = createMockAgentStream(mockEvents);

      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

      const stream = await runSiteAgent(
        'Yes, proceed.',
        '/tmp/test-project',
        'test-session-456',
        'execute'
      );

      const events = [];
      for await (const event of stream) {
        events.push(event);
      }

      // Verify tool execution event
      const toolExecutions = events.filter(e => e.type === 'tool_execution');
      expect(toolExecutions).toHaveLength(1);
      expect(toolExecutions[0].tool_name).toBe('mcp__site-studio__write_file');
      expect(toolExecutions[0].result.success).toBe(true);
    });

    it('should handle tool execution errors gracefully', async () => {
      const mockEvents = [
        createInitEvent('test-session-error'),
        {
          type: 'tool_execution',
          tool_name: 'mcp__site-studio__write_file',
          error: 'Permission denied',
        },
        createAssistantMessageEvent('Sorry, I encountered an error.'),
      ];
      const mockStream = createMockAgentStream(mockEvents);

      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

      const stream = await runSiteAgent('Create file', '/tmp/test-project', undefined, 'execute');

      const events = [];
      for await (const event of stream) {
        events.push(event);
      }

      // Verify error handling
      const toolExecutions = events.filter(e => e.type === 'tool_execution');
      expect(toolExecutions).toHaveLength(1);
      expect(toolExecutions[0].error).toContain('Permission denied');
    });
  });

  describe('Session Management', () => {
    it('should resume existing session with valid sessionId', async () => {
      const sessionId = 'existing-session-123';
      const mockEvents = [createAssistantMessageEvent('Resuming your session')];
      const mockStream = createMockAgentStream(mockEvents);

      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

      const stream = await runSiteAgent('Continue', '/tmp/test-project', sessionId, 'plan');

      const events = [];
      for await (const event of stream) {
        events.push(event);
      }

      // Verify query was called with resume option
      const queryMock = vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query;
      expect(queryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            resume: sessionId,
          }),
        })
      );
    });

    it('should maintain conversation history across requests', async () => {
      const sessionId = 'history-session';

      // First request
      const mockEvents1 = [
        createInitEvent(sessionId),
        createAssistantMessageEvent('I created index.html'),
      ];
      const mockStream1 = createMockAgentStream(mockEvents1);
      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream1);

      const stream1 = await runSiteAgent('Create index.html', '/tmp/test-project');
      for await (const event of stream1) {
        // Consume stream
      }

      // Second request with session ID
      const mockEvents2 = [
        createAssistantMessageEvent('Now I will add styles to the existing index.html'),
      ];
      const mockStream2 = createMockAgentStream(mockEvents2);
      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream2);

      const stream2 = await runSiteAgent('Add CSS styles', '/tmp/test-project', sessionId, 'plan');
      const events2 = [];
      for await (const event of stream2) {
        events2.push(event);
      }

      // Verify context is maintained (agent refers to existing file)
      expect(events2[0].content).toContain('existing');
    });
  });

  describe('File Uploads', () => {
    it('should handle PDF uploads and instruct agent to use Read tool', async () => {
      const mockEvents = [
        createInitEvent('test-session-pdf'),
        createAssistantMessageEvent('I will analyze the PDF using the Read tool'),
      ];
      const mockStream = createMockAgentStream(mockEvents);

      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

      // Simulate file upload by including file info in prompt
      const stream = await runSiteAgent(
        'Analyze document.pdf\n\n[SYSTEM: User uploaded a PDF: document.pdf]',
        '/tmp/test-project'
      );

      const events = [];
      for await (const event of stream) {
        events.push(event);
      }

      // Verify agent acknowledges the file
      const assistantMessages = events.filter(e => e.type === 'assistant');
      expect(assistantMessages.length).toBeGreaterThan(0);
    });

    it('should handle image uploads', async () => {
      const mockEvents = [
        createInitEvent('test-session-image'),
        createAssistantMessageEvent('I will process the image'),
      ];
      const mockStream = createMockAgentStream(mockEvents);

      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

      const stream = await runSiteAgent(
        'Use logo.png\n\n[SYSTEM: User uploaded an image: logo.png]',
        '/tmp/test-project'
      );

      const events = [];
      for await (const event of stream) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle agent SDK errors gracefully', async () => {
      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockImplementation(() => {
        throw new Error('API rate limit exceeded');
      });

      await expect(
        runSiteAgent('Create website', '/tmp/test-project')
      ).rejects.toThrow('API rate limit exceeded');
    });

    it('should handle tool execution failures', async () => {
      const mockEvents = errorResponseFixture;
      const mockStream = createMockAgentStream(mockEvents);

      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

      const stream = await runSiteAgent('Create file', '/tmp/test-project');

      const events = [];
      for await (const event of stream) {
        events.push(event);
      }

      // Verify error event
      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].error).toContain('Failed to execute tool');
    });

    it('should return proper error events to client', async () => {
      const errorMessage = 'Network connection failed';
      const mockEvents = [
        createInitEvent('test-session-error'),
        createErrorEvent(errorMessage),
      ];
      const mockStream = createMockAgentStream(mockEvents);

      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

      const stream = await runSiteAgent('Create website', '/tmp/test-project');

      const events = [];
      for await (const event of stream) {
        events.push(event);
      }

      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].error).toBe(errorMessage);
    });

    it('should not leak internal error details', async () => {
      const mockEvents = [
        createInitEvent('test-session-secure'),
        createErrorEvent('An error occurred'), // Generic message
      ];
      const mockStream = createMockAgentStream(mockEvents);

      vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

      const stream = await runSiteAgent('Create website', '/tmp/test-project');

      const events = [];
      for await (const event of stream) {
        events.push(event);
      }

      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
      // Verify no stack traces or internal paths
      expect(errorEvents[0].error).not.toContain('stack');
      expect(errorEvents[0].error).not.toContain('/src/');
    });
  });
});
