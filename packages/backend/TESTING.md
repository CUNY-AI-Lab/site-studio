# Testing Documentation

## Current Test Coverage

### ✅ Implemented Tests (22 tests, 100% passing)

#### 1. Authentication Middleware (`src/middleware/__tests__/auth.test.ts`) - 3 tests
- Creates session for anonymous mode when no cookie exists
- Returns 401 in required auth mode when no session exists
- Accepts session ID from header

#### 2. Validation Middleware (`src/middleware/__tests__/validation.test.ts`) - 8 tests
- **createProjectSchema**: Validates project creation, rejects missing name, rejects names too long
- **saveFileSchema**: Validates file save data, allows empty content, rejects missing path
- **querySchema**: Validates agent queries, rejects invalid mode

#### 3. Filesystem Storage (`src/storage/__tests__/filesystem-storage.test.ts`) - 11 tests
- **Project Operations**: Create, list, delete, rename projects
- **File Operations**: Write/read text, write/read binary, check existence, delete, list files
- **Metadata Operations**: Set/get metadata, update existing metadata

---

## ❌ Missing Test Coverage

### Critical: Agent Integration Tests

**NO TESTS EXIST FOR THE CORE AGENT FUNCTIONALITY**

The application's primary feature is AI-assisted site building through agent interactions, but we have zero tests covering:

#### 1. Agent Query Endpoint (`POST /api/query`)

**Test File:** `src/__tests__/agent-query.test.ts` (NOT CREATED)

**Missing Test Scenarios:**

```typescript
describe('Agent Query Endpoint', () => {
  describe('Plan Mode', () => {
    it('should create new agent session and return init event');
    it('should stream assistant messages');
    it('should request permission for tool calls');
    it('should handle user rejection of plan');
    it('should preserve session state after plan request');
  });

  describe('Execute Mode', () => {
    it('should execute tools without requesting permission');
    it('should stream tool execution results');
    it('should handle tool execution errors gracefully');
  });

  describe('Session Management', () => {
    it('should resume existing session with valid sessionId');
    it('should reject invalid sessionId');
    it('should maintain conversation history across requests');
    it('should handle session timeout/expiry');
  });

  describe('File Uploads', () => {
    it('should handle PDF uploads and instruct agent to use Read tool');
    it('should handle image uploads');
    it('should reject unsupported file types');
    it('should validate file size limits');
  });

  describe('Error Handling', () => {
    it('should handle agent SDK errors gracefully');
    it('should handle tool execution failures');
    it('should return proper error events to client');
    it('should not leak internal error details');
  });
});
```

#### 2. Plan Approval Workflow (`POST /api/query/approve`)

**Test File:** `src/__tests__/plan-approval.test.ts` (NOT CREATED)

**Missing Test Scenarios:**

```typescript
describe('Plan Approval Endpoint', () => {
  it('should resume session with approval=true and execute plan');
  it('should resume session with approval=false and reject plan');
  it('should require valid projectId and sessionId');
  it('should return 400 if session does not exist');
  it('should stream execution results via SSE');
  it('should handle execution errors during approval');
  it('should maintain tool execution state');
});
```

#### 3. Agent Tool Integration Tests

**Test File:** `src/__tests__/agent-tools.test.ts` (NOT CREATED)

**Missing Test Scenarios:**

```typescript
describe('Agent Tool Execution', () => {
  describe('File Tools', () => {
    it('should write files via write_file tool');
    it('should read files via view_file tool');
    it('should edit files via edit_file tool');
    it('should delete files via delete_file tool');
    it('should rename files via rename_file tool');
    it('should list files via list_files tool');
    it('should search files via search_files tool');
    it('should handle permission errors');
  });

  describe('Template Tools', () => {
    it('should scaffold templates via scaffold_template tool');
    it('should add pages via add_page tool');
    it('should validate template IDs');
    it('should handle invalid template requests');
  });

  describe('Tool Security', () => {
    it('should block disallowed tools (Bash, WebSearch, Task, etc.)');
    it('should only allow MCP tools and Read tool');
    it('should prevent path traversal attacks');
    it('should validate tool input parameters');
  });
});
```

#### 4. Multi-Turn Conversation Tests

**Test File:** `src/__tests__/agent-conversations.test.ts` (NOT CREATED)

**Missing Test Scenarios:**

```typescript
describe('Agent Conversations', () => {
  it('should handle multi-turn conversation in plan mode');
  it('should maintain context across multiple queries');
  it('should handle user asking clarifying questions');
  it('should handle user changing requirements mid-conversation');
  it('should handle session resumption after long pause');
  it('should handle concurrent requests to same session');
});
```

#### 5. End-to-End Agent Workflows

**Test File:** `src/__tests__/agent-e2e.test.ts` (NOT CREATED)

**Missing Test Scenarios:**

```typescript
describe('End-to-End Agent Workflows', () => {
  it('should create a blank project from scratch');
  it('should create project from template');
  it('should edit existing project files');
  it('should add new pages to project');
  it('should handle image uploads and placement');
  it('should handle CSS styling requests');
  it('should complete full workflow: plan → approve → execute → verify');
});
```

---

## 🟡 Additional Missing Tests

### API Endpoint Tests

**Test Files Needed:**
- `src/__tests__/projects-api.test.ts` - Project CRUD operations
- `src/__tests__/files-api.test.ts` - File operations endpoints
- `src/__tests__/publish-api.test.ts` - Publishing workflow

### Integration Tests

**Test Files Needed:**
- `src/__tests__/r2-storage-integration.test.ts` - R2 storage with real/mocked S3
- `src/__tests__/session-management.test.ts` - Session creation, cleanup, expiry
- `src/__tests__/rate-limiting.test.ts` - Rate limiter behavior

### Security Tests

**Test Files Needed:**
- `src/__tests__/auth-security.test.ts` - Auth bypass attempts, CSRF, session fixation
- `src/__tests__/input-validation-security.test.ts` - XSS, SQL injection, path traversal
- `src/__tests__/file-upload-security.test.ts` - Malicious file uploads, magic byte validation

---

## Implementation Recommendations

### 1. Agent Testing Strategy

**Challenge:** Testing agent interactions requires:
- Mocking or using real Claude API calls (cost/speed concerns)
- Handling SSE streaming responses
- Managing async agent state

**Recommended Approach:**

#### Option A: Mock Claude Agent SDK (Fast, No API Costs)
```typescript
import { vi } from 'vitest';
import * as agentSdk from '@anthropic-ai/claude-agent-sdk';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'test-session' };
    yield { type: 'assistant', content: 'I can help you build a website!' };
    yield {
      type: 'permission_request',
      tool_calls: [{ name: 'write_file', input: { path: 'index.html', content: '...' } }]
    };
  }),
  createSdkMcpServer: vi.fn(() => mockMcpServer),
}));
```

**Pros:** Fast, deterministic, no API costs
**Cons:** Doesn't test real agent behavior

#### Option B: Use Real Agent with Test Account (Slow, Costly, Real)
```typescript
// Use real Claude API but with careful test design
// Only run in CI with proper API key
// Use fixtures to minimize token usage
```

**Pros:** Tests real behavior
**Cons:** Slow, costs money, non-deterministic

#### Option C: Hybrid Approach (Recommended)
- Unit tests: Mock SDK for speed
- Integration tests: Real API (run manually or in CI only)
- E2E tests: Real API with minimal test cases

### 2. Testing SSE Streams

```typescript
import { EventEmitter } from 'events';
import request from 'supertest';

describe('SSE Stream Testing', () => {
  it('should handle SSE events', async () => {
    const response = await request(app)
      .post('/api/query')
      .send({ prompt: 'Create a website', projectId: 'test' })
      .set('Accept', 'text/event-stream');

    const events: any[] = [];

    response.on('data', (chunk) => {
      const lines = chunk.toString().split('\n\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data !== '[DONE]') {
            events.push(JSON.parse(data));
          }
        }
      }
    });

    await new Promise(resolve => response.on('end', resolve));

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'system', subtype: 'init' })
    );
  });
});
```

### 3. Test Data Management

Create test fixtures:
```
packages/backend/src/__tests__/fixtures/
  ├── agent-responses/
  │   ├── plan-request.json
  │   ├── tool-execution.json
  │   └── error-response.json
  ├── projects/
  │   ├── blank-project/
  │   └── with-content/
  └── uploads/
      ├── test.pdf
      └── test.jpg
```

### 4. Test Utilities

Create helper utilities:
```typescript
// packages/backend/src/__tests__/helpers/agent-test-utils.ts

export async function* createMockAgentStream(events: any[]) {
  for (const event of events) {
    yield event;
  }
}

export async function waitForEvent(
  stream: AsyncIterable<any>,
  predicate: (event: any) => boolean
) {
  for await (const event of stream) {
    if (predicate(event)) return event;
  }
  throw new Error('Event not found in stream');
}

export async function collectStreamEvents(
  stream: AsyncIterable<any>
): Promise<any[]> {
  const events = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}
```

---

## Priority Order for Implementation

1. **High Priority - Core Agent Tests**
   - [ ] Basic agent query with mocked responses
   - [ ] Plan/approve workflow
   - [ ] Session management
   - [ ] Tool execution (write_file, view_file)

2. **Medium Priority - Security & Error Handling**
   - [ ] Tool blocking/security
   - [ ] Error handling in agent flow
   - [ ] Input validation in agent requests

3. **Low Priority - Advanced Features**
   - [ ] Multi-turn conversations
   - [ ] File upload handling
   - [ ] Concurrent session handling
   - [ ] Full E2E workflows

---

## Test Coverage Goals

**Current Coverage:**
- Infrastructure: ~70% (auth, validation, storage)
- Core Features: 0% (agent interactions)
- **Overall: ~25%**

**Target Coverage:**
- Infrastructure: 80%+
- Core Features: 70%+
- **Overall: 75%+**

---

## Running Tests

```bash
# Run all tests
npm test

# Run specific test suite
npm test -- auth.test.ts

# Run with coverage
npm test -- --coverage

# Run in watch mode
npm test -- --watch

# Run in UI mode
npm test -- --ui
```

---

## Notes

- The agent tests are the most critical gap in coverage
- Without agent tests, we can't verify the core product functionality
- Current tests only validate infrastructure/plumbing
- Consider starting with mocked agent tests for speed, then add integration tests later
- Agent testing is complex due to streaming, async state, and AI non-determinism
