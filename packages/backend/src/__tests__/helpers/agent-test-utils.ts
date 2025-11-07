/**
 * Test utilities for agent testing
 * Provides mock streams, event collectors, and helper functions
 */

/**
 * Create a mock agent stream from a list of events
 */
export async function* createMockAgentStream(events: any[]) {
  for (const event of events) {
    yield event;
  }
}

/**
 * Wait for a specific event in a stream that matches a predicate
 */
export async function waitForEvent(
  stream: AsyncIterable<any>,
  predicate: (event: any) => boolean
): Promise<any> {
  for await (const event of stream) {
    if (predicate(event)) return event;
  }
  throw new Error('Event not found in stream');
}

/**
 * Collect all events from a stream into an array
 */
export async function collectStreamEvents(
  stream: AsyncIterable<any>
): Promise<any[]> {
  const events = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

/**
 * Parse SSE data chunks into events
 */
export function parseSSEChunk(chunk: string): any[] {
  const events: any[] = [];
  const lines = chunk.split('\n\n');

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const data = line.slice(6);
      if (data !== '[DONE]') {
        try {
          events.push(JSON.parse(data));
        } catch (e) {
          // Ignore parse errors
        }
      }
    }
  }

  return events;
}

/**
 * Create a mock permission request event
 */
export function createPermissionRequestEvent(toolCalls: any[]) {
  return {
    type: 'permission_request',
    tool_calls: toolCalls,
  };
}

/**
 * Create a mock system init event
 */
export function createInitEvent(sessionId: string) {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
  };
}

/**
 * Create a mock assistant message event
 */
export function createAssistantMessageEvent(content: string) {
  return {
    type: 'assistant',
    content,
  };
}

/**
 * Create a mock tool execution event
 */
export function createToolExecutionEvent(toolName: string, result: any) {
  return {
    type: 'tool_execution',
    tool_name: toolName,
    result,
  };
}

/**
 * Create a mock error event
 */
export function createErrorEvent(error: string) {
  return {
    type: 'error',
    error,
  };
}
