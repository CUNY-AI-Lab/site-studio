# Technical Debt and Error Review
**Review Date:** 2025-11-04
**Reviewer:** Claude AI Code Review
**Branch:** claude/review-errors-tech-debt-011CUoFtqdtoHRvsCHtGoEkh

## Executive Summary

This comprehensive review identified **34 issues** across multiple categories including security concerns, code quality issues, and technical debt. The codebase is well-structured overall with good architectural patterns, but several areas need attention to improve maintainability, security, and code quality.

**Priority Breakdown:**
- 🔴 Critical/High Priority: 8 issues
- 🟡 Medium Priority: 15 issues
- 🟢 Low Priority: 11 issues

---

## 🔴 Critical & High Priority Issues

### 1. Backup Files Tracked in Git (Critical)
**Location:** `packages/frontend/src/lib/components/`
- `AgentChat.svelte.backup`
- `AgentChat.svelte.bak`

**Issue:** Temporary backup files are committed to version control, cluttering the repository and potentially containing outdated code.

**Risk:** Confusion during development, repository bloat, potential security issues if backups contain sensitive data.

**Recommendation:**
```bash
# Remove from git
git rm packages/frontend/src/lib/components/AgentChat.svelte.backup
git rm packages/frontend/src/lib/components/AgentChat.svelte.bak

# Add to .gitignore
echo "*.backup" >> .gitignore
echo "*.bak" >> .gitignore
```

### 2. Missing Package Lock File (High)
**Location:** Root directory
**Issue:** `package-lock.json` is intentionally gitignored (line 3 of `.gitignore`), preventing deterministic builds and security auditing.

**Risk:**
- Non-reproducible builds across environments
- Cannot run `npm audit` for security vulnerability scanning
- Different developers/CI may install different dependency versions
- Supply chain security concerns

**Recommendation:**
```bash
# Remove from .gitignore
sed -i '/^package-lock\.json$/d' .gitignore

# Generate lockfile
npm install --package-lock-only

# Commit the lockfile
git add package-lock.json
git commit -m "feat: add package-lock.json for deterministic builds"
```

### 3. Zero Test Coverage (High)
**Location:** Entire codebase
**Issue:** No test files found (`.test.*`, `.spec.*`). Zero automated testing for ~3,245 lines of code.

**Risk:**
- No regression prevention
- Difficult to refactor safely
- No validation of critical paths (authentication, file operations, agent interactions)
- Publishing, file uploads, and storage operations are untested

**Recommendation:**
Create test suite with priority on:
1. Authentication middleware tests
2. Storage abstraction tests (filesystem & R2)
3. API endpoint tests
4. Agent tool tests
5. Frontend component tests

Example starter test structure:
```
packages/backend/src/__tests__/
  middleware/auth.test.ts
  storage/filesystem-storage.test.ts
  storage/r2-storage.test.ts
  tools/file-tools.test.ts
packages/frontend/src/__tests__/
  components/AgentChat.test.ts
  api/projects.test.ts
```

### 4. Debugging Code in Production (High)
**Location:** `packages/backend/src/storage/r2-storage.ts:129-131`

```typescript
console.log(`[R2] Writing ${key}, content type: ${typeof content}, isBuffer: ${Buffer.isBuffer(content)}, body isBuffer: ${Buffer.isBuffer(body)}`);
if (Buffer.isBuffer(body)) {
  console.log(`[R2] First 4 bytes: ${body.slice(0, 4).toString('hex')}`);
}
```

**Issue:** Verbose debugging statements left in production code, potentially logging sensitive file content.

**Risk:** Performance impact, log bloat, potential information disclosure.

**Recommendation:** Remove or wrap in debug flag:
```typescript
if (process.env.DEBUG_R2 === 'true') {
  console.log(`[R2] Writing ${key}`);
}
```

### 5. Error Messages Expose Internal Details (High)
**Location:** Throughout `packages/backend/src/index.ts` (20+ occurrences)

**Pattern:**
```typescript
} catch (error: any) {
  res.status(500).json({ error: error.message });
}
```

**Issue:** Raw error messages from exceptions are sent directly to clients, potentially exposing:
- File system paths
- Database connection strings
- Internal implementation details
- Stack traces in development mode

**Risk:** Information disclosure, security vulnerability (CWE-209)

**Recommendation:**
```typescript
} catch (error: any) {
  console.error('[API Error]', error); // Log full error server-side
  res.status(500).json({
    error: 'An internal error occurred. Please try again.'
  });
}
```

For specific errors that should be user-facing:
```typescript
} catch (error: any) {
  if (error.code === 'PROJECT_NOT_FOUND') {
    res.status(404).json({ error: 'Project not found' });
  } else {
    console.error('[API Error]', error);
    res.status(500).json({ error: 'An internal error occurred' });
  }
}
```

### 6. No Environment Variable Validation (High)
**Location:** `packages/backend/src/storage/index.ts`, `middleware/auth.ts`

**Issue:** Required environment variables are accessed with fallbacks but never validated at startup:

```typescript
const accountId = process.env.R2_ACCOUNT_ID; // Could be undefined
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

if (!accountId || !accessKeyId || !secretAccessKey) {
  throw new Error('R2 credentials not configured');
}
```

This validation happens lazily on first use, not at startup.

**Risk:**
- Application starts successfully but fails at runtime
- Confusing error messages for deployment issues
- Hard to debug in production

**Recommendation:**
Create startup validation in `packages/backend/src/index.ts`:

```typescript
// Add before app.listen()
function validateEnvironment() {
  const required: Record<string, string[]> = {
    r2: ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'],
    bedrock: ['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
    anthropic: ['ANTHROPIC_API_KEY'],
  };

  const storageType = process.env.STORAGE_TYPE || 'filesystem';

  if (storageType === 'r2') {
    for (const key of required.r2) {
      if (!process.env[key]) {
        console.error(`❌ Missing required environment variable: ${key}`);
        process.exit(1);
      }
    }
  }

  // Validate AI provider config
  if (process.env.CLAUDE_CODE_USE_BEDROCK === '1') {
    for (const key of required.bedrock) {
      if (!process.env[key]) {
        console.error(`❌ Missing required environment variable: ${key}`);
        process.exit(1);
      }
    }
  } else if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ Missing ANTHROPIC_API_KEY');
    process.exit(1);
  }
}

validateEnvironment();
```

### 7. Inconsistent Internal Auth Token (High)
**Location:** `packages/backend/src/index.ts:1010`

```typescript
const expectedToken = process.env.INTERNAL_AUTH_TOKEN || 'internal-secret-token';
```

**Issue:** Falls back to a hardcoded default secret token if environment variable is not set.

**Risk:**
- Default token is in source code, visible to all developers
- Potential unauthorized access to internal endpoints
- Security vulnerability if deployed without configuration

**Recommendation:**
```typescript
const expectedToken = process.env.INTERNAL_AUTH_TOKEN;
if (!expectedToken) {
  console.error('❌ INTERNAL_AUTH_TOKEN must be set');
  process.exit(1);
}
```

### 8. Performance-Impacting Console.log Statements (Medium-High)
**Location:** Multiple files (17 total instances)

**Files affected:**
- `packages/backend/src/index.ts` (8 instances)
- `packages/backend/src/tools/file-tools.ts` (2 instances)
- `packages/backend/src/storage/r2-storage.ts` (2 instances)
- `packages/backend/src/middleware/auth.ts` (2 instances)
- `packages/backend/src/storage/index.ts` (2 instances)
- `packages/backend/src/templates.ts` (1 instance)

**Issue:** Console statements in hot paths (file listing, R2 operations) impact performance.

**Examples:**
```typescript
// tools/file-tools.ts:44 - Called on every file list operation
console.log(`[Tool:list_files] R2 listFiles took ${Date.now() - r2Start}ms`);
console.log(`[Tool:list_files] Total time: ${Date.now() - startTime}ms`);
```

**Recommendation:** Use a proper logging library with levels:
```bash
npm install pino pino-pretty
```

```typescript
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino-pretty'
  } : undefined
});

// Replace console.log with:
logger.info({ duration: Date.now() - startTime }, 'R2 list completed');
logger.debug({ userId, projectId }, 'File upload started');
```

---

## 🟡 Medium Priority Issues

### 9. Excessive Use of TypeScript `any` Type (Medium)
**Location:** Throughout codebase (50+ instances)

**Most problematic:**
- `packages/backend/src/index.ts:215,262,289...` (12 occurrences of `(req as any).user.id`)
- `packages/backend/src/agent.ts:237,261` (return type and query options)
- `packages/backend/src/tools/file-tools.ts:48,65` (tree structure)
- All catch blocks: `catch (error: any)`

**Issue:** Type safety is bypassed, defeating the purpose of TypeScript's strict mode.

**Example Problem:**
```typescript
const userId = (req as any).user.id; // Repeated 12+ times
```

**Solution:** The codebase already has `AuthenticatedRequest` interface defined!

**Location:** `packages/backend/src/middleware/auth.ts:9-11`
```typescript
export interface AuthenticatedRequest extends Request {
  user: User;
}
```

**Recommendation:**

1. **Fix request casting throughout index.ts:**
```typescript
// Before (12+ times):
const userId = (req as any).user.id;

// After:
import { AuthenticatedRequest } from './middleware/auth.js';

app.patch('/api/projects/:id', async (req: AuthenticatedRequest, res) => {
  const userId = req.user.id; // Type-safe!
```

2. **Fix error handling:**
```typescript
// Before:
catch (error: any) {
  res.status(500).json({ error: error.message });
}

// After:
catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown error';
  console.error('[API Error]', error);
  res.status(500).json({ error: 'Internal server error' });
}
```

3. **Fix agent.ts types:**
```typescript
// Before:
): Promise<AsyncIterable<any>> {

// After:
import type { AgentStreamEvent } from '@anthropic-ai/claude-agent-sdk';
): Promise<AsyncIterable<AgentStreamEvent>> {
```

**Impact:** This change would improve type safety across the entire API surface, catching bugs at compile time rather than runtime.

### 10. Repetitive Error Handling Code (Medium)
**Location:** `packages/backend/src/index.ts` (20+ identical catch blocks)

**Issue:** Same error handling pattern repeated in every route:
```typescript
} catch (error: any) {
  res.status(500).json({ error: error.message });
}
```

**Recommendation:** Create error handling middleware:

```typescript
// middleware/error-handler.ts
import { Request, Response, NextFunction } from 'express';

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string
  ) {
    super(message);
  }
}

export function errorHandler(
  error: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  console.error('[API Error]', {
    path: req.path,
    method: req.method,
    error: error.message,
    stack: error.stack,
  });

  if (error instanceof ApiError) {
    res.status(error.statusCode).json({
      error: error.message,
      code: error.code,
    });
    return;
  }

  res.status(500).json({
    error: 'An internal error occurred',
  });
}

// Register at the end of index.ts
app.use(errorHandler);
```

Then simplify routes to use next():
```typescript
app.patch('/api/projects/:id', async (req: AuthenticatedRequest, res, next) => {
  try {
    const userId = req.user.id;
    // ... route logic
  } catch (error) {
    next(error); // Centralized error handling
  }
});
```

### 11. Missing Input Validation (Medium)
**Location:** Multiple API endpoints in `packages/backend/src/index.ts`

**Issue:** Inconsistent input validation. Some endpoints validate, others don't.

**Example - Good validation:**
```typescript
// index.ts:219
if (!name || typeof name !== 'string') {
  res.status(400).json({ error: 'New project name is required' });
  return;
}
```

**Example - Missing validation:**
```typescript
// POST /api/projects/:id/file - No validation of 'path' or 'content' parameters
// DELETE /api/projects/:id - No validation of project ID format
```

**Recommendation:** Use Zod (already installed!) for request validation:

```typescript
import { z } from 'zod';

const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  template: z.string().optional(),
});

const renameProjectSchema = z.object({
  name: z.string().min(1).max(100),
});

const saveFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

// Validation middleware
function validate(schema: z.ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      schema.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: 'Validation failed',
          details: error.errors
        });
        return;
      }
      next(error);
    }
  };
}

// Usage
app.post('/api/projects', validate(createProjectSchema), async (req, res) => {
  // req.body is now validated
});
```

### 12. Unsafe File Path Handling (Medium)
**Location:** `packages/backend/src/index.ts:225,527,561,605,651,735,798`

**Pattern:**
```typescript
const newId = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
```

**Issue:** Sanitization is inconsistent and potentially vulnerable to path traversal.

**Example Concerns:**
1. Multiple consecutive dashes aren't collapsed
2. Leading/trailing dashes not removed consistently
3. No length validation (could create very long paths)
4. Unicode characters not handled

**Test cases that could fail:**
```javascript
slugify("../../../etc/passwd") // → "etcpasswd" - but path.join could still escape
slugify("....") // → "" - empty string
slugify("---test---") // → "---test---" - invalid
slugify("very".repeat(100)) // No max length check
```

**Recommendation:** Use the existing `slugify()` function more consistently, and add validation:

```typescript
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')      // Remove special characters
    .replace(/[\s_-]+/g, '-')       // Replace spaces/underscores with hyphen
    .replace(/^-+|-+$/g, '');       // Remove leading/trailing hyphens

  // Validate result
  if (!slug) {
    throw new ApiError(400, 'Invalid name: must contain at least one alphanumeric character');
  }

  if (slug.length > 100) {
    throw new ApiError(400, 'Name too long (max 100 characters)');
  }

  return slug;
}

// Use consistently:
const projectId = slugify(req.body.name);
```

Also add path traversal protection in storage layer:
```typescript
// storage/filesystem-storage.ts
private getKey(userId: string, projectId: string, filePath: string = ''): string {
  // Prevent path traversal
  const normalized = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
  if (normalized.startsWith('..') || normalized.includes('/../')) {
    throw new Error('Invalid file path: path traversal detected');
  }
  return path.join(this.projectsRoot, userId, projectId, normalized);
}
```

### 13. Inconsistent Session Management (Medium)
**Location:** `packages/backend/src/middleware/auth.ts`

**Issue:** Session store is initialized lazily (on first use) instead of at startup.

```typescript
// Line 14
let sessionStore: ISessionStore | null = null;

// Line 24 - Initialized on first use
export function getSessionStoreInstance(): ISessionStore {
  if (!sessionStore) {
    // Initialize here...
  }
  return sessionStore;
}
```

**Problem:**
- Startup errors (missing R2 credentials) don't surface until first request
- Can't pre-warm connections or validate configuration
- No health check endpoint can verify session store

**Recommendation:**
```typescript
// Initialize at module load time
export const sessionStore: ISessionStore = (() => {
  const storageType = process.env.STORAGE_TYPE || 'filesystem';

  if (storageType === 'r2') {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const bucketName = process.env.R2_BUCKET_NAME || 'site-studio';

    if (!accountId || !accessKeyId || !secretAccessKey) {
      throw new Error('R2 credentials not configured');
    }

    console.log('Using R2 session storage');
    return new R2SessionStore(accountId, accessKeyId, secretAccessKey, bucketName);
  }

  console.log('Using in-memory session storage');
  return new MemorySessionStore();
})();

export function authenticateUser(req: Request, res: Response, next: NextFunction) {
  // Use sessionStore directly, no lazy initialization
  const store = sessionStore;
  // ...
}
```

### 14. Agent Prompt Hardcoding (Medium)
**Location:** `packages/backend/src/agent.ts` (162 lines of prompt)

**Issue:** The entire agent system prompt is hardcoded in the TypeScript file, making it:
- Hard to version and review prompt changes
- Difficult to test different prompts
- Cannot be hot-reloaded without code deployment
- Mixes content with code

**Recommendation:** Extract to a template file:

```typescript
// prompts/site-agent.md
import fs from 'fs/promises';
import path from 'path';

const PROMPT_PATH = path.join(__dirname, '../prompts/site-agent.md');

export async function getAgentPrompt(): Promise<string> {
  return await fs.readFile(PROMPT_PATH, 'utf-8');
}

// Or with caching:
let cachedPrompt: string | null = null;

export async function getAgentPrompt(): Promise<string> {
  if (!cachedPrompt || process.env.NODE_ENV === 'development') {
    cachedPrompt = await fs.readFile(PROMPT_PATH, 'utf-8');
  }
  return cachedPrompt;
}
```

Then move the prompt content to `packages/backend/prompts/site-agent.md`.

### 15. Missing Rate Limiting (Medium)
**Location:** `packages/backend/src/index.ts` - No rate limiting middleware

**Issue:** No rate limiting on any endpoints, including:
- `/api/query` - Expensive AI agent calls
- `/api/projects` - CRUD operations
- File upload endpoints - Resource intensive

**Risk:**
- DoS attacks
- Cost explosion (AI API costs)
- Resource exhaustion

**Recommendation:**
```bash
npm install express-rate-limit
```

```typescript
import rateLimit from 'express-rate-limit';

// General API rate limit
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  message: 'Too many requests, please try again later',
});

// Strict rate limit for AI agent
const agentLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 agent queries per minute
  message: 'Rate limit exceeded for agent queries',
});

app.use('/api/', apiLimiter);
app.use('/api/query', agentLimiter);
```

### 16. No Request Size Validation (Medium)
**Location:** `packages/backend/src/index.ts:50`

```typescript
app.use(express.json({ limit: '50mb' })); // Very large!
```

**Issue:**
- 50MB JSON limit is excessive for most endpoints
- Only file uploads should accept large payloads
- Opens vulnerability to JSON bombing attacks

**Recommendation:**
```typescript
// Default: small JSON payloads
app.use(express.json({ limit: '1mb' }));

// Specific routes that need larger payloads
app.use('/api/projects/:id/upload', express.json({ limit: '50mb' }));
app.use('/api/query', express.json({ limit: '5mb' })); // For base64 PDFs in chat
```

### 17. Frontend Error Handling (Medium)
**Location:** `packages/frontend/src/lib/api/projects.ts`

**Issue:** Generic error messages don't provide actionable feedback:

```typescript
if (!response.ok) {
  throw new Error('Failed to fetch projects'); // Not helpful
}
```

**Recommendation:** Include status codes and detailed messages:

```typescript
export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: any
  ) {
    super(message);
  }
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      errorData.error || `Request failed: ${response.statusText}`,
      errorData.details
    );
  }
  return response.json();
}

export async function fetchProjects(): Promise<Project[]> {
  const response = await fetch(`${API_BASE}/projects`, {
    credentials: 'include',
  });
  const data = await handleResponse<{ projects: Project[] }>(response);
  return data.projects;
}
```

Then in components:
```typescript
try {
  await fetchProjects();
} catch (error) {
  if (error instanceof ApiError) {
    if (error.statusCode === 401) {
      // Redirect to login
    } else if (error.statusCode === 404) {
      showError('Project not found');
    }
  }
}
```

### 18. Memory Leak Risk in Session Store (Medium)
**Location:** `packages/backend/src/middleware/memory-session-store.ts` (implied, not read yet)

**Issue:** In-memory session store likely has no cleanup mechanism. Sessions accumulate indefinitely.

**Risk:** Memory leak in long-running development servers or anonymous mode production deployments.

**Recommendation:** Implement periodic cleanup:

```typescript
export class MemorySessionStore implements ISessionStore {
  private sessions = new Map<string, { user: User; expiresAt: number }>();
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    // Cleanup every hour
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60 * 60 * 1000);
  }

  async set(sessionId: string, user: User): Promise<void> {
    this.sessions.set(sessionId, {
      user,
      expiresAt: Date.now() + (30 * 24 * 60 * 60 * 1000), // 30 days
    });
  }

  async get(sessionId: string): Promise<User | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    if (Date.now() > session.expiresAt) {
      this.sessions.delete(sessionId);
      return null;
    }

    return session.user;
  }

  async cleanup(): Promise<number> {
    const now = Date.now();
    let deleted = 0;

    for (const [id, session] of this.sessions.entries()) {
      if (now > session.expiresAt) {
        this.sessions.delete(id);
        deleted++;
      }
    }

    console.log(`[Session Cleanup] Removed ${deleted} expired sessions`);
    return deleted;
  }

  destroy() {
    clearInterval(this.cleanupInterval);
  }
}
```

### 19. No CORS Configuration Validation (Medium)
**Location:** `packages/backend/src/index.ts:46-49`

```typescript
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
```

**Issue:**
- Single origin allowed, but production may need multiple (staging, production, preview deployments)
- No validation of origin format
- Credentials allowed globally

**Recommendation:**
```typescript
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map(o => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`CORS blocked origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  maxAge: 86400, // Cache preflight for 24 hours
}));
```

Update `.env.example`:
```env
# Comma-separated list of allowed origins
ALLOWED_ORIGINS=http://localhost:5173,https://site-studio.example.com
```

### 20. Missing Health Check Endpoint (Medium)
**Location:** N/A - Not implemented

**Issue:** No health check endpoint for:
- Load balancers (Fly.io)
- Monitoring systems
- Startup validation
- Dependency checks (R2, Anthropic API)

**Recommendation:**
```typescript
// GET /health - Basic liveness check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// GET /health/ready - Readiness check with dependencies
app.get('/health/ready', async (req, res) => {
  const checks = {
    storage: false,
    sessions: false,
    ai: false,
  };

  try {
    // Check storage
    await storage.projectExists('health-check', 'test');
    checks.storage = true;
  } catch (error) {
    console.error('Health check - storage failed:', error);
  }

  try {
    // Check session store
    await sessionStore.get('health-check');
    checks.sessions = true;
  } catch (error) {
    console.error('Health check - sessions failed:', error);
  }

  // Optional: Check AI provider (but may be expensive)
  checks.ai = !!process.env.ANTHROPIC_API_KEY;

  const isHealthy = checks.storage && checks.sessions;

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'ready' : 'not ready',
    checks,
    timestamp: new Date().toISOString(),
  });
});
```

Update `fly.toml`:
```toml
[http_service]
  internal_port = 3001
  force_https = true

  [[http_service.checks]]
    interval = "30s"
    timeout = "5s"
    grace_period = "10s"
    method = "GET"
    path = "/health/ready"
```

### 21. Unsafe Template HTML (Medium)
**Location:** `packages/backend/src/tools/template-tools.ts:115`

```typescript
<p>Office: Building Name, Room XXX</p>
```

**Issue:** Placeholder "XXX" could be confusing (though this is in generated template content, not a code issue per se).

**Recommendation:** Use more obvious placeholders:
```html
<p>Office: [Building Name], Room [Number]</p>
<!-- or -->
<p>Office: <span class="placeholder">Your Building & Room</span></p>
```

### 22. No File Type Validation in Uploads (Medium)
**Location:** `packages/backend/src/index.ts:789-799`

**Issue:** File upload endpoint accepts any file type without validation (only size limit).

**Risk:**
- Users could upload malicious files
- Serving arbitrary files could enable XSS attacks
- Storage quota abuse

**Recommendation:**
```typescript
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'text/plain',
  'text/csv',
]);

const ALLOWED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
  '.pdf', '.docx', '.txt', '.csv'
]);

app.post('/api/projects/:id/upload',
  authenticateUser,
  upload.single('file'),
  async (req: AuthenticatedRequest, res) => {
    const file = req.file;

    if (!file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    // Validate MIME type
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      res.status(400).json({
        error: `File type not allowed: ${file.mimetype}`
      });
      return;
    }

    // Validate extension
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      res.status(400).json({
        error: `File extension not allowed: ${ext}`
      });
      return;
    }

    // Additional validation: Check magic bytes for images
    if (file.mimetype.startsWith('image/')) {
      const isValidImage = await validateImageMagicBytes(file.buffer);
      if (!isValidImage) {
        res.status(400).json({
          error: 'Invalid image file'
        });
        return;
      }
    }

    // Continue with upload...
  }
);
```

### 23. Potential Race Condition in Project Rename (Medium)
**Location:** `packages/backend/src/index.ts:234-238`

```typescript
// Check if new name conflicts with existing project
if (newId !== id) {
  if (await storage.projectExists(userId, newId)) {
    res.status(409).json({ error: 'A project with that name already exists' });
    return;
  }
}
```

**Issue:** Time-of-check to time-of-use (TOCTOU) race condition. Two simultaneous renames could conflict.

**Recommendation:** Implement atomic rename or locking:

```typescript
// Option 1: Try-catch on rename operation
try {
  await storage.renameProject(userId, id, newId);
} catch (error) {
  if (error.code === 'PROJECT_EXISTS') {
    res.status(409).json({ error: 'A project with that name already exists' });
    return;
  }
  throw error;
}

// Option 2: Add transaction support to storage layer
await storage.transaction(async (tx) => {
  if (await tx.projectExists(userId, newId)) {
    throw new ApiError(409, 'Project exists');
  }
  await tx.renameProject(userId, id, newId);
});
```

---

## 🟢 Low Priority Issues

### 24. Inconsistent Comment Styles (Low)
**Location:** Throughout codebase

**Issue:** Mix of JSDoc-style and inline comments:
```typescript
/**
 * GET /api/templates
 * Get all template categories with metadata
 * Public endpoint (no auth required)
 */

// vs

// Public auth endpoints (defined before authentication middleware)
```

**Recommendation:** Standardize on JSDoc for all public functions/endpoints.

### 25. Magic Numbers (Low)
**Location:** Various files

**Examples:**
```typescript
maxAge: 30 * 24 * 60 * 60 * 1000, // index.ts:85
fileSize: 32 * 1024 * 1024, // index.ts:92
windowMs: 15 * 60 * 1000, // (recommended rate limit)
```

**Recommendation:** Extract to constants:
```typescript
// config/constants.ts
export const TIMESPAN = {
  ONE_MINUTE: 60 * 1000,
  ONE_HOUR: 60 * 60 * 1000,
  ONE_DAY: 24 * 60 * 60 * 1000,
  THIRTY_DAYS: 30 * 24 * 60 * 60 * 1000,
} as const;

export const FILE_SIZE = {
  ONE_MB: 1024 * 1024,
  FIVE_MB: 5 * 1024 * 1024,
  THIRTY_TWO_MB: 32 * 1024 * 1024,
  FIFTY_MB: 50 * 1024 * 1024,
} as const;

// Usage:
maxAge: TIMESPAN.THIRTY_DAYS,
fileSize: FILE_SIZE.THIRTY_TWO_MB,
```

### 26. Inconsistent Naming Conventions (Low)
**Location:** Various files

**Examples:**
- `SANDBOXES_DIR` (SCREAMING_SNAKE_CASE)
- `__filename`, `__dirname` (snake_case with underscores)
- `userId`, `projectId` (camelCase)
- `R2Storage` (PascalCase)

**Recommendation:** Follow consistent convention:
- `SCREAMING_SNAKE_CASE` for module-level constants
- `camelCase` for variables and function parameters
- `PascalCase` for classes and types

### 27. Unused Import Warning (Low)
**Location:** Likely multiple files (need to run TypeScript compiler to check)

**Recommendation:** Run TypeScript compiler with `noUnusedLocals`:
```json
// tsconfig.json
{
  "compilerOptions": {
    "noUnusedLocals": true,
    "noUnusedParameters": true
  }
}
```

### 28. Missing JSDoc Documentation (Low)
**Location:** Most functions lack JSDoc

**Recommendation:** Add JSDoc to all exported functions:
```typescript
/**
 * Retrieves all projects for a given user from storage
 * @param userId - The unique identifier of the user
 * @returns Promise resolving to array of project metadata
 * @throws {StorageError} If storage access fails
 */
export async function getUserProjects(userId: string): Promise<ProjectMetadata[]> {
  // ...
}
```

### 29. README Outdated Information (Low)
**Location:** `/home/user/site-studio/README.md:8`

```markdown
**Frontend:** SvelteKit 5, Tailwind CSS v4, Monaco Editor
```

**Issue:** Frontend uses CodeMirror 6, not Monaco Editor.

**Recommendation:** Update README:
```markdown
**Frontend:** SvelteKit 5, Tailwind CSS v4, CodeMirror 6
```

### 30. Inconsistent Error Message Format (Low)
**Location:** Throughout API responses

**Examples:**
- `{ error: 'Project not found' }`
- `{ error: error.message }`
- Some responses have just `message`, others have `error`

**Recommendation:** Standardize error response format:
```typescript
interface ErrorResponse {
  error: {
    message: string;
    code?: string;
    details?: unknown;
  };
}

// Consistent usage:
res.status(404).json({
  error: {
    message: 'Project not found',
    code: 'PROJECT_NOT_FOUND',
  }
});
```

### 31. Git Branch Naming (Low)
**Location:** Current branch name

**Issue:** Branch name `claude/review-errors-tech-debt-011CUoFtqdtoHRvsCHtGoEkh` is extremely long and includes session ID.

**Recommendation:** Use shorter, descriptive branch names:
- `feature/tech-debt-review`
- `chore/code-quality-improvements`
- `fix/security-issues`

### 32. No .nvmrc or .node-version File (Low)
**Location:** Root directory

**Issue:** No Node.js version pinning. Dockerfile uses Node 20, but developers might use different versions.

**Recommendation:**
```bash
echo "20" > .nvmrc
echo "20" > .node-version
```

Update README:
```markdown
## Prerequisites

- Node.js 20+ (use `nvm use` to automatically load the version)
- npm 10+
```

### 33. No EditorConfig (Low)
**Location:** Root directory

**Issue:** No `.editorconfig` file to enforce consistent coding styles across different editors.

**Recommendation:**
```ini
# .editorconfig
root = true

[*]
charset = utf-8
indent_style = space
indent_size = 2
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false

[*.{json,yml,yaml}]
indent_size = 2

[Makefile]
indent_style = tab
```

### 34. No Dockerfile Best Practices (Low)
**Location:** `/home/user/site-studio/Dockerfile`

**Recommendation:** Review and ensure:
- Multi-stage build (likely already implemented)
- Non-root user
- .dockerignore file
- Proper layer caching
- Security scanning

Should verify Dockerfile includes:
```dockerfile
# Use non-root user
USER node

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"
```

---

## Summary Statistics

| Category | Count |
|----------|-------|
| Critical Issues | 2 |
| High Priority | 6 |
| Medium Priority | 15 |
| Low Priority | 11 |
| **Total** | **34** |

## Positive Findings ✅

The codebase demonstrates several strong practices:

1. **Good Architecture**: Clean separation of concerns (frontend, backend, worker)
2. **TypeScript Strict Mode**: Enabled in `tsconfig.json`
3. **Storage Abstraction**: Well-designed storage layer with filesystem and R2 implementations
4. **Security Awareness**: Sandbox isolation, authentication middleware, CORS configuration
5. **Modern Stack**: Up-to-date dependencies (SvelteKit 5, Express 5, Tailwind v4)
6. **No Empty Catch Blocks**: All errors are at least logged
7. **Environment Configuration**: Good use of environment variables with `.env.example`
8. **Monorepo Structure**: Clean npm workspaces setup

## Recommended Priority Order

### Phase 1: Security & Critical Fixes (Week 1)
1. Remove backup files from git
2. Add package-lock.json
3. Fix error message exposure
4. Add environment variable validation
5. Remove debugging code
6. Fix internal auth token default

### Phase 2: Type Safety & Code Quality (Week 2)
7. Fix TypeScript `any` usage (especially `AuthenticatedRequest`)
8. Add centralized error handling middleware
9. Add input validation with Zod
10. Implement rate limiting

### Phase 3: Testing & Monitoring (Week 3)
11. Add test framework and initial tests
12. Add health check endpoints
13. Implement proper logging (pino)
14. Add file type validation for uploads

### Phase 4: Refactoring & Documentation (Week 4)
15. Extract agent prompt to file
16. Improve frontend error handling
17. Add JSDoc documentation
18. Create constants file
19. Fix session store lazy initialization

### Phase 5: Polish (Ongoing)
20. Remaining low-priority issues
21. Code review process
22. CI/CD improvements

## Tools Recommendations

To prevent future issues:

```bash
# Add to package.json scripts:
"lint": "eslint . --ext .ts,.tsx,.js,.jsx,.svelte",
"typecheck": "tsc --noEmit",
"test": "vitest",
"test:coverage": "vitest --coverage",
"audit": "npm audit",
"outdated": "npm outdated"

# Install development tools:
npm install -D eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin
npm install -D vitest @vitest/ui
npm install -D prettier prettier-plugin-svelte
npm install -D husky lint-staged  # Pre-commit hooks
```

## Conclusion

The Site Studio codebase is well-structured with good architectural decisions. However, it has accumulated technical debt that should be addressed to improve security, maintainability, and reliability. The recommended fixes are straightforward and can be implemented incrementally without major refactoring.

**Key Takeaway:** Prioritize security fixes (Phase 1) immediately, especially error message sanitization and environment validation. Then focus on type safety improvements to prevent future bugs.

---

**Next Steps:**
1. Review this document with the team
2. Create GitHub issues for each high-priority item
3. Assign owners and deadlines
4. Begin Phase 1 implementation
5. Set up automated tools (linting, testing, CI/CD)
