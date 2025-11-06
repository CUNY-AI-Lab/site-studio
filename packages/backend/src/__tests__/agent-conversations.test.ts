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

describe('Agent Conversations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should handle multi-turn conversation in plan mode', async () => {
    const sessionId = 'multi-turn-session';

    // Turn 1: User asks to create a website
    const turn1Events = [
      createInitEvent(sessionId),
      createAssistantMessageEvent('What kind of website would you like to create?'),
    ];
    const turn1Stream = createMockAgentStream(turn1Events);
    vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(turn1Stream);

    const stream1 = await runSiteAgent('I want to create a website', '/tmp/test-project', undefined, 'plan');
    const events1 = [];
    for await (const event of stream1) {
      events1.push(event);
    }

    expect(events1.filter(e => e.type === 'assistant')).toHaveLength(1);

    // Turn 2: User clarifies it's a portfolio
    const turn2Events = [
      createAssistantMessageEvent('Great! I will create a portfolio website for you.'),
      createPermissionRequestEvent([
        {
          name: 'mcp__site-studio__scaffold_template',
          input: { templateId: 'portfolio' },
        },
      ]),
    ];
    const turn2Stream = createMockAgentStream(turn2Events);
    vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(turn2Stream);

    const stream2 = await runSiteAgent('A portfolio website', '/tmp/test-project', sessionId, 'plan');
    const events2 = [];
    for await (const event of stream2) {
      events2.push(event);
    }

    // Verify second turn used correct session
    const queryMock = vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query;
    expect(queryMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        prompt: 'A portfolio website',
        options: expect.objectContaining({
          resume: sessionId,
        }),
      })
    );

    // Verify agent proposed a plan based on clarification
    const permissionRequests = events2.filter(e => e.type === 'permission_request');
    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0].tool_calls[0].input.templateId).toBe('portfolio');
  });

  it('should maintain context across multiple queries', async () => {
    const sessionId = 'context-session';

    // Turn 1: Create index.html
    const turn1Events = [
      createInitEvent(sessionId),
      createAssistantMessageEvent('I created index.html with a heading'),
      {
        type: 'tool_execution',
        tool_name: 'mcp__site-studio__write_file',
        result: { success: true, path: 'index.html' },
      },
    ];
    const turn1Stream = createMockAgentStream(turn1Events);
    vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(turn1Stream);

    const stream1 = await runSiteAgent('Create index.html', '/tmp/test-project', undefined, 'execute');
    for await (const event of stream1) {
      // Consume stream
    }

    // Turn 2: Add styles (should reference existing index.html)
    const turn2Events = [
      createAssistantMessageEvent('I will add a style.css file and link it to the existing index.html'),
      {
        type: 'tool_execution',
        tool_name: 'mcp__site-studio__write_file',
        result: { success: true, path: 'style.css' },
      },
      {
        type: 'tool_execution',
        tool_name: 'mcp__site-studio__edit_file',
        result: { success: true, path: 'index.html' },
      },
    ];
    const turn2Stream = createMockAgentStream(turn2Events);
    vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(turn2Stream);

    const stream2 = await runSiteAgent('Add CSS styles', '/tmp/test-project', sessionId, 'execute');
    const events2 = [];
    for await (const event of stream2) {
      events2.push(event);
    }

    // Verify agent maintained context (referenced existing file)
    const assistantMessages = events2.filter(e => e.type === 'assistant');
    expect(assistantMessages[0].content).toMatch(/existing.*index\.html/i);

    // Verify both CSS creation and HTML edit happened
    const toolExecutions = events2.filter(e => e.type === 'tool_execution');
    expect(toolExecutions).toHaveLength(2);
  });

  it('should handle user asking clarifying questions', async () => {
    const sessionId = 'clarifying-session';

    // Turn 1: Agent proposes a plan
    const turn1Events = [
      createInitEvent(sessionId),
      createPermissionRequestEvent([
        {
          name: 'mcp__site-studio__write_file',
          input: { path: 'index.html', content: '<h1>My Site</h1>' },
        },
      ]),
    ];
    const turn1Stream = createMockAgentStream(turn1Events);
    vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(turn1Stream);

    const stream1 = await runSiteAgent('Create a simple site', '/tmp/test-project', undefined, 'plan');
    for await (const event of stream1) {
      // Consume stream
    }

    // Turn 2: User asks for clarification
    const turn2Events = [
      createAssistantMessageEvent('I will use "My Site" as the page title. It will appear in the browser tab.'),
    ];
    const turn2Stream = createMockAgentStream(turn2Events);
    vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(turn2Stream);

    const stream2 = await runSiteAgent('What will "My Site" be used for?', '/tmp/test-project', sessionId, 'plan');
    const events2 = [];
    for await (const event of stream2) {
      events2.push(event);
    }

    // Verify agent provided clarification
    const assistantMessages = events2.filter(e => e.type === 'assistant');
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].content).toContain('page title');
  });

  it('should handle user changing requirements mid-conversation', async () => {
    const sessionId = 'change-session';

    // Turn 1: User asks for a blog
    const turn1Events = [
      createInitEvent(sessionId),
      createAssistantMessageEvent('I will create a blog template'),
      createPermissionRequestEvent([
        {
          name: 'mcp__site-studio__scaffold_template',
          input: { templateId: 'blog' },
        },
      ]),
    ];
    const turn1Stream = createMockAgentStream(turn1Events);
    vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(turn1Stream);

    const stream1 = await runSiteAgent('Create a blog', '/tmp/test-project', undefined, 'plan');
    for await (const event of stream1) {
      // Consume stream
    }

    // Turn 2: User changes mind to portfolio
    const turn2Events = [
      createAssistantMessageEvent('Understood. I will create a portfolio instead of a blog.'),
      createPermissionRequestEvent([
        {
          name: 'mcp__site-studio__scaffold_template',
          input: { templateId: 'portfolio' },
        },
      ]),
    ];
    const turn2Stream = createMockAgentStream(turn2Events);
    vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(turn2Stream);

    const stream2 = await runSiteAgent(
      'Actually, make it a portfolio instead',
      '/tmp/test-project',
      sessionId,
      'plan'
    );
    const events2 = [];
    for await (const event of stream2) {
      events2.push(event);
    }

    // Verify agent adapted to changed requirements
    const permissionRequests = events2.filter(e => e.type === 'permission_request');
    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0].tool_calls[0].input.templateId).toBe('portfolio');

    const assistantMessages = events2.filter(e => e.type === 'assistant');
    expect(assistantMessages[0].content).toMatch(/portfolio.*instead/i);
  });

  it('should handle session resumption after long pause', async () => {
    const sessionId = 'pause-session';

    // Initial conversation
    const initialEvents = [
      createInitEvent(sessionId),
      createAssistantMessageEvent('I created a basic website for you'),
      {
        type: 'tool_execution',
        tool_name: 'mcp__site-studio__write_file',
        result: { success: true, path: 'index.html' },
      },
    ];
    const initialStream = createMockAgentStream(initialEvents);
    vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(initialStream);

    const stream1 = await runSiteAgent('Create a website', '/tmp/test-project', undefined, 'execute');
    for await (const event of stream1) {
      // Consume stream
    }

    // Simulate long pause (session still exists in SDK)
    // User returns and resumes
    const resumeEvents = [
      createAssistantMessageEvent('Welcome back! I remember you created a basic website. How can I help you improve it?'),
    ];
    const resumeStream = createMockAgentStream(resumeEvents);
    vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(resumeStream);

    const stream2 = await runSiteAgent('I am back', '/tmp/test-project', sessionId, 'plan');
    const events2 = [];
    for await (const event of stream2) {
      events2.push(event);
    }

    // Verify agent resumed session correctly
    const queryMock = vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query;
    expect(queryMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          resume: sessionId,
        }),
      })
    );

    // Verify agent acknowledged returning user
    const assistantMessages = events2.filter(e => e.type === 'assistant');
    expect(assistantMessages[0].content).toMatch(/welcome back|remember/i);
  });

  it('should handle concurrent requests to same session', async () => {
    const sessionId = 'concurrent-session';

    // Request 1
    const events1 = [
      createInitEvent(sessionId),
      createAssistantMessageEvent('Processing request 1'),
    ];
    const stream1Mock = createMockAgentStream(events1);

    // Request 2 (concurrent)
    const events2 = [
      createAssistantMessageEvent('Processing request 2'),
    ];
    const stream2Mock = createMockAgentStream(events2);

    const queryMock = vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query;
    queryMock
      .mockReturnValueOnce(stream1Mock)
      .mockReturnValueOnce(stream2Mock);

    // Both requests use same sessionId
    const stream1 = await runSiteAgent('Request 1', '/tmp/test-project', undefined, 'plan');
    const stream2 = await runSiteAgent('Request 2', '/tmp/test-project', sessionId, 'plan');

    // Consume both streams
    const events1Collected = [];
    for await (const event of stream1) {
      events1Collected.push(event);
    }

    const events2Collected = [];
    for await (const event of stream2) {
      events2Collected.push(event);
    }

    // Both should complete successfully
    expect(events1Collected.length).toBeGreaterThan(0);
    expect(events2Collected.length).toBeGreaterThan(0);

    // Second request should use resume
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        options: expect.objectContaining({
          resume: sessionId,
        }),
      })
    );
  });

  it('should handle complex multi-turn workflow', async () => {
    const sessionId = 'complex-workflow';

    // Turn 1: Create template
    const turn1Events = [
      createInitEvent(sessionId),
      createAssistantMessageEvent('Creating portfolio template'),
      {
        type: 'tool_execution',
        tool_name: 'mcp__site-studio__scaffold_template',
        result: { success: true, templateId: 'portfolio', filesCreated: ['index.html', 'style.css'] },
      },
    ];
    const turn1Stream = createMockAgentStream(turn1Events);
    vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(turn1Stream);

    const stream1 = await runSiteAgent('Create a portfolio', '/tmp/test-project', undefined, 'execute');
    for await (const event of stream1) {
      // Consume stream
    }

    // Turn 2: Add about page
    const turn2Events = [
      createAssistantMessageEvent('Adding about page'),
      {
        type: 'tool_execution',
        tool_name: 'mcp__site-studio__add_page',
        result: { success: true, filePath: 'about.html' },
      },
    ];
    const turn2Stream = createMockAgentStream(turn2Events);
    vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(turn2Stream);

    const stream2 = await runSiteAgent('Add an about page', '/tmp/test-project', sessionId, 'execute');
    for await (const event of stream2) {
      // Consume stream
    }

    // Turn 3: Customize styles
    const turn3Events = [
      createAssistantMessageEvent('Updating styles with blue theme'),
      {
        type: 'tool_execution',
        tool_name: 'mcp__site-studio__edit_file',
        result: { success: true, path: 'style.css' },
      },
    ];
    const turn3Stream = createMockAgentStream(turn3Events);
    vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(turn3Stream);

    const stream3 = await runSiteAgent('Make it blue themed', '/tmp/test-project', sessionId, 'execute');
    for await (const event of stream3) {
      // Consume stream
    }

    // Turn 4: List all files to verify
    const turn4Events = [
      createAssistantMessageEvent('Here are all the files'),
      {
        type: 'tool_execution',
        tool_name: 'mcp__site-studio__list_files',
        result: { success: true, files: ['index.html', 'about.html', 'style.css'] },
      },
    ];
    const turn4Stream = createMockAgentStream(turn4Events);
    vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query.mockReturnValue(turn4Stream);

    const stream4 = await runSiteAgent('Show me all files', '/tmp/test-project', sessionId, 'execute');
    const events4 = [];
    for await (const event of stream4) {
      events4.push(event);
    }

    // Verify final state includes all created files
    const toolExecutions = events4.filter(e => e.type === 'tool_execution');
    expect(toolExecutions[0].result.files).toContain('index.html');
    expect(toolExecutions[0].result.files).toContain('about.html');
    expect(toolExecutions[0].result.files).toContain('style.css');

    // Verify all turns used the same session
    const queryMock = vi.mocked(await import('@anthropic-ai/claude-agent-sdk')).query;
    expect(queryMock).toHaveBeenCalledTimes(4);

    // Verify turns 2-4 resumed the session
    for (let i = 1; i < 4; i++) {
      expect(queryMock).toHaveBeenNthCalledWith(
        i + 1,
        expect.objectContaining({
          options: expect.objectContaining({
            resume: sessionId,
          }),
        })
      );
    }
  });
});
