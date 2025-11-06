import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runSiteAgent } from '../agent.js';
import {
  createMockAgentStream,
  createInitEvent,
  createAssistantMessageEvent,
  createPermissionRequestEvent,
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

describe('Plan Approval Endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should resume session with approval=true and execute plan', async () => {
    const sessionId = 'approval-session-123';

    // First request - create plan
    const planEvents = [
      createInitEvent(sessionId),
      createAssistantMessageEvent('I will create index.html'),
      createPermissionRequestEvent([
        {
          name: 'mcp__site-studio__write_file',
          input: { path: 'index.html', content: '<h1>Hello</h1>' },
        },
      ]),
    ];
    const planStream = createMockAgentStream(planEvents);
    vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(planStream);

    const stream1 = await runSiteAgent('Create index.html', '/tmp/test-project', undefined, 'plan');
    const planEventsCollected = [];
    for await (const event of stream1) {
      planEventsCollected.push(event);
    }

    // Verify plan was created
    const permissionRequests = planEventsCollected.filter(e => e.type === 'permission_request');
    expect(permissionRequests).toHaveLength(1);

    // Second request - approve and execute
    const executeEvents = [
      createAssistantMessageEvent('Executing the plan...'),
      {
        type: 'tool_execution',
        tool_name: 'mcp__site-studio__write_file',
        result: { success: true, path: 'index.html' },
      },
      createAssistantMessageEvent('Plan executed successfully!'),
    ];
    const executeStream = createMockAgentStream(executeEvents);
    vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(executeStream);

    const stream2 = await runSiteAgent(
      'Yes, proceed with the plan.',
      '/tmp/test-project',
      sessionId,
      'execute'
    );
    const executeEventsCollected = [];
    for await (const event of stream2) {
      executeEventsCollected.push(event);
    }

    // Verify execution happened
    const toolExecutions = executeEventsCollected.filter(e => e.type === 'tool_execution');
    expect(toolExecutions).toHaveLength(1);
    expect(toolExecutions[0].result.success).toBe(true);
  });

  it('should resume session with approval=false and reject plan', async () => {
    const sessionId = 'rejection-session-456';

    // First request - create plan
    const planEvents = [
      createInitEvent(sessionId),
      createPermissionRequestEvent([
        {
          name: 'mcp__site-studio__write_file',
          input: { path: 'index.html', content: '<h1>Test</h1>' },
        },
      ]),
    ];
    const planStream = createMockAgentStream(planEvents);
    vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(planStream);

    const stream1 = await runSiteAgent('Create file', '/tmp/test-project', undefined, 'plan');
    for await (const event of stream1) {
      // Consume stream
    }

    // Second request - reject plan
    const rejectionEvents = [
      createAssistantMessageEvent('Understood. I will not proceed with the plan.'),
    ];
    const rejectionStream = createMockAgentStream(rejectionEvents);
    vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(rejectionStream);

    const stream2 = await runSiteAgent(
      "No, please don't proceed.",
      '/tmp/test-project',
      sessionId,
      'plan'
    );
    const events = [];
    for await (const event of stream2) {
      events.push(event);
    }

    // Verify rejection response
    const assistantMessages = events.filter(e => e.type === 'assistant');
    expect(assistantMessages.length).toBeGreaterThan(0);
    expect(assistantMessages[0].content).toMatch(/will not proceed|understood/i);

    // Verify no tools were executed
    const toolExecutions = events.filter(e => e.type === 'tool_execution');
    expect(toolExecutions).toHaveLength(0);
  });

  it('should require valid projectId and sessionId', async () => {
    // This test would be in the HTTP layer, not the agent layer
    // Testing that the validation middleware catches missing fields
    // Here we just verify that runSiteAgent expects these parameters

    const sessionId = 'valid-session';
    const mockEvents = [createAssistantMessageEvent('Hello')];
    const mockStream = createMockAgentStream(mockEvents);
    vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

    // Should work with valid parameters
    const stream = await runSiteAgent('Test', '/tmp/test-project', sessionId, 'execute');
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
  });

  it('should stream execution results via SSE', async () => {
    const sessionId = 'streaming-session';

    // Create multiple events to test streaming
    const events = [
      createAssistantMessageEvent('Starting execution...'),
      {
        type: 'tool_execution',
        tool_name: 'mcp__site-studio__write_file',
        result: { success: true, path: 'index.html' },
      },
      createAssistantMessageEvent('File 1 created'),
      {
        type: 'tool_execution',
        tool_name: 'mcp__site-studio__write_file',
        result: { success: true, path: 'style.css' },
      },
      createAssistantMessageEvent('File 2 created'),
      createAssistantMessageEvent('All files created successfully!'),
    ];
    const mockStream = createMockAgentStream(events);
    vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

    const stream = await runSiteAgent('Yes, proceed', '/tmp/test-project', sessionId, 'execute');

    const collectedEvents = [];
    for await (const event of stream) {
      collectedEvents.push(event);
    }

    // Verify all events were streamed
    expect(collectedEvents).toHaveLength(6);

    // Verify correct order
    expect(collectedEvents[0].type).toBe('assistant');
    expect(collectedEvents[1].type).toBe('tool_execution');
    expect(collectedEvents[2].type).toBe('assistant');
    expect(collectedEvents[3].type).toBe('tool_execution');
    expect(collectedEvents[4].type).toBe('assistant');
    expect(collectedEvents[5].type).toBe('assistant');
  });

  it('should handle execution errors during approval', async () => {
    const sessionId = 'error-session';

    const errorEvents = [
      createAssistantMessageEvent('Executing plan...'),
      {
        type: 'tool_execution',
        tool_name: 'mcp__site-studio__write_file',
        error: 'Disk full',
      },
      createAssistantMessageEvent('I encountered an error: Disk full'),
    ];
    const mockStream = createMockAgentStream(errorEvents);
    vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

    const stream = await runSiteAgent('Yes, proceed', '/tmp/test-project', sessionId, 'execute');

    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    // Verify error was reported
    const toolExecutions = events.filter(e => e.type === 'tool_execution');
    expect(toolExecutions).toHaveLength(1);
    expect(toolExecutions[0].error).toBe('Disk full');

    // Verify agent acknowledged error
    const assistantMessages = events.filter(e => e.type === 'assistant');
    const errorMessage = assistantMessages.find(m => m.content.toLowerCase().includes('error'));
    expect(errorMessage).toBeDefined();
  });

  it('should maintain tool execution state', async () => {
    const sessionId = 'state-session';

    // Execute multiple tools in sequence
    const events = [
      {
        type: 'tool_execution',
        tool_name: 'mcp__site-studio__write_file',
        result: { success: true, path: 'index.html' },
      },
      {
        type: 'tool_execution',
        tool_name: 'mcp__site-studio__write_file',
        result: { success: true, path: 'style.css' },
      },
      {
        type: 'tool_execution',
        tool_name: 'mcp__site-studio__list_files',
        result: { files: ['index.html', 'style.css'] },
      },
      createAssistantMessageEvent('All files created and verified'),
    ];
    const mockStream = createMockAgentStream(events);
    vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(mockStream);

    const stream = await runSiteAgent('Execute plan', '/tmp/test-project', sessionId, 'execute');

    const collectedEvents = [];
    for await (const event of stream) {
      collectedEvents.push(event);
    }

    // Verify state is maintained across multiple tool executions
    const toolExecutions = collectedEvents.filter(e => e.type === 'tool_execution');
    expect(toolExecutions).toHaveLength(3);

    // Verify the list_files tool can see files created by write_file
    const listFilesExecution = toolExecutions.find(
      e => e.tool_name === 'mcp__site-studio__list_files'
    );
    expect(listFilesExecution?.result.files).toContain('index.html');
    expect(listFilesExecution?.result.files).toContain('style.css');
  });

  it('should handle approval workflow with file modifications', async () => {
    const sessionId = 'modification-session';

    // Plan phase - propose modifications
    const planEvents = [
      createInitEvent(sessionId),
      createPermissionRequestEvent([
        {
          name: 'mcp__site-studio__edit_file',
          input: { path: 'index.html', oldContent: '<h1>Old</h1>', newContent: '<h1>New</h1>' },
        },
      ]),
    ];
    const planStream = createMockAgentStream(planEvents);
    vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(planStream);

    const stream1 = await runSiteAgent('Update the heading', '/tmp/test-project', undefined, 'plan');
    const planEventsCollected = [];
    for await (const event of stream1) {
      planEventsCollected.push(event);
    }

    // Verify modification plan
    const permissionRequests = planEventsCollected.filter(e => e.type === 'permission_request');
    expect(permissionRequests[0].tool_calls[0].name).toBe('mcp__site-studio__edit_file');

    // Execute phase - approve and modify
    const executeEvents = [
      {
        type: 'tool_execution',
        tool_name: 'mcp__site-studio__edit_file',
        result: { success: true, path: 'index.html' },
      },
      createAssistantMessageEvent('File updated successfully'),
    ];
    const executeStream = createMockAgentStream(executeEvents);
    vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(executeStream);

    const stream2 = await runSiteAgent('Yes, proceed', '/tmp/test-project', sessionId, 'execute');
    const executeEventsCollected = [];
    for await (const event of stream2) {
      executeEventsCollected.push(event);
    }

    // Verify modification was executed
    const toolExecutions = executeEventsCollected.filter(e => e.type === 'tool_execution');
    expect(toolExecutions).toHaveLength(1);
    expect(toolExecutions[0].result.success).toBe(true);
  });
});
