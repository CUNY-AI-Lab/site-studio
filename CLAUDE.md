# Site Studio - Claude Code Guide

## Auto-Invoke Skills

When working on this project, always invoke these skills:

- **frontend-design** - For any frontend UI work, use this skill to create distinctive, production-grade interfaces
- **svelte-5-runes** - This project uses Svelte 5 with runes (`$state`, `$derived`, `$effect`, `$props`). Always use modern Svelte 5 patterns

## What Is Site Studio?

Site Studio is an AI-powered web development tool for academics and researchers to build professional static websites through natural language conversation. Users describe what they want, the AI agent executes changes via sandboxed Dynamic Workers, and users see results in a live preview.

**Key Innovation:** The agent writes JavaScript that runs in Cloudflare Dynamic Workers (Codemode), with typed project APIs for file operations. Snapshots provide recovery - users can restore to any previous state.

**Target Users:** Students, researchers, academics who want professional websites without coding (research portfolios, publication archives, lab websites, course pages).

## Architecture Overview

```
site-studio/
├── packages/
│   ├── app/              # Cloudflare Workers (Hono) backend
│   │   ├── src/
│   │   │   ├── index.ts           # Hono app, route mounting
│   │   │   ├── agents/
│   │   │   │   └── site-builder.ts  # SiteBuilderAgent Durable Object + project tools
│   │   │   ├── routes/            # API route handlers
│   │   │   │   ├── agents.ts      # WebSocket proxy to Durable Object
│   │   │   │   ├── projects.ts    # Project CRUD + snapshots
│   │   │   │   ├── files.ts       # File read/write/upload/delete
│   │   │   │   ├── publish.ts     # Publish/unpublish
│   │   │   │   ├── preview.ts     # Live preview serving
│   │   │   │   ├── templates.ts   # Template listing
│   │   │   │   └── health.ts      # Health check
│   │   │   ├── storage/
│   │   │   │   └── r2.ts          # R2ProjectStorage (all file + snapshot ops)
│   │   │   ├── lib/               # Session, path utils, constants, templates
│   │   │   └── prompts/
│   │   │       └── site-builder.ts  # Agent system prompt
│   │   └── wrangler.jsonc         # Cloudflare bindings config
│   │
│   └── frontend/         # SvelteKit 5 + Vite
│       └── src/
│           ├── routes/
│           │   ├── +page.svelte              # Dashboard
│           │   └── editor/[projectId]/       # Main editor
│           └── lib/
│               ├── agents/
│               │   └── chat.ts               # WebSocket message types + streaming state
│               ├── components/
│               │   ├── AgentChat.svelte       # Chat + WebSocket streaming
│               │   ├── ToolExecutionCard.svelte
│               │   ├── AskUserQuestionCard.svelte
│               │   ├── ProjectHistoryDialog.svelte  # Snapshot management
│               │   ├── CodeView.svelte        # CodeMirror 6
│               │   ├── Preview.svelte         # Live preview iframe
│               │   ├── ProjectDashboard.svelte
│               │   ├── NewProjectDialog.svelte
│               │   └── ui/                    # shadcn-svelte
│               ├── api/                       # API client
│               └── utils/
│                   ├── ws.ts                  # WebSocket URL resolution
│                   └── onboarding.ts          # Tour/onboarding (driver.js)
```

## Agent Architecture: Codemode + Dynamic Workers

The agent uses a single `codemode` tool backed by Cloudflare Dynamic Workers. Instead of individual MCP tools, the agent writes JavaScript that executes in a sandboxed worker with typed project APIs.

### How It Works

1. **User sends message** via WebSocket to SiteBuilderAgent Durable Object
2. **Agent generates JavaScript** using the `codemode` tool
3. **DynamicWorkerExecutor** runs the code in an isolated Dynamic Worker
4. **Project APIs** (`project.list_files()`, `project.read_file()`, etc.) are available in the sandbox
5. **Results flow back** to the agent, which can chain multiple executions
6. **Preview updates** in real-time after file-modifying operations

### Project APIs (available in sandbox)

All tools have typed `inputSchema` and `outputSchema` (Zod). The `outputSchema` is critical - it generates TypeScript types via `@cloudflare/codemode`'s `generateTypes()` so the LLM knows the return shapes.

```
project.list_files({ prefix? })     → { count, tree, paths }
project.read_file({ path })         → { ok, path, content, truncated } | { ok: false, message }
project.search_files({ query })     → { query, count, truncated, results[] }
project.write_file({ path, content })  → { ok, path, created, changed }
project.edit_file({ path, oldText, newText }) → { ok, path, replacements } | { ok: false, message }
project.rename_file({ oldPath, newPath })     → { ok, oldPath, newPath } | { ok: false, message }
project.delete_file({ path })       → { ok, path } | { ok: false, message }
project.scaffold_template({ templateId })     → { ok, templateId } | { ok: false, message }
project.add_page({ path, title })   → { ok, path, title } | { ok: false, message }
```

### SiteBuilderAgent Durable Object

Located in `packages/app/src/agents/site-builder.ts`:
- Extends `AIChatAgent<Env>` from `@cloudflare/ai-chat`
- Instantiated per project: `${userId}:${projectId}`
- Model calls go through the CAIL model proxy to Cloudflare Workers AI (`@cf/zai-org/glm-5.2` by default; CAIL policy is Cloudflare models only)
- Chat history persisted via AIChatAgent (SQLite in Durable Object)
- Automatic snapshot creation before file-modifying operations

## Key Technologies

**Backend (packages/app):**
- Cloudflare Workers + Hono framework
- `@cloudflare/ai-chat` - AIChatAgent base class
- `@cloudflare/codemode` - Dynamic Worker code execution
- `@cuny-ai-lab/cail-client` + `@ai-sdk/openai-compatible` - Model access via the CAIL gateway (Workers AI)
- Vercel AI SDK (`ai`) - `streamText`, `tool()` definitions
- Cloudflare R2 - File and snapshot storage
- Cloudflare KV - Session management
- Durable Objects - Persistent agent state

**Frontend (packages/frontend):**
- SvelteKit 5 with runes (NOT Svelte 4 - always use `$state`, `$derived`, etc.)
- Tailwind CSS v4
- CodeMirror 6 for code editing
- shadcn-svelte components (in `lib/components/ui/`)
- WebSocket streaming for real-time agent communication
- driver.js for onboarding tour

## Environment Configuration

### Wrangler Bindings (wrangler.jsonc)
```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "SITE_BUILDER_AGENT", "class_name": "SiteBuilderAgent" }]
  },
  "r2_buckets": [{ "binding": "SITE_STUDIO_BUCKET", "bucket_name": "site-studio" }],
  "kv_namespaces": [{ "binding": "SESSION_KV", "id": "..." }],
  "worker_loaders": [{ "binding": "LOADER" }],
  "vars": {
    "APP_PUBLIC_DOMAIN": "https://...",
    "CAIL_API_BASE": "https://...",        // CAIL model proxy base URL (set at launch)
    "CAIL_MODEL": "@cf/zai-org/glm-5.2",   // Workers AI id only (CAIL policy)
    "CAIL_REQUIRE_IDENTITY": "false"       // flip to "true" with gateway SSO enforce
  }
}
```

### Secrets
```bash
# Set via wrangler secret put (ops-managed)
CAIL_IDENTITY_JWKS=...         # public JWKS for RS256 X-CAIL-Identity-JWT
# Site Studio holds NO provider API keys — the CAIL model proxy attaches them.
```

## Important Patterns

### Svelte 5 Async State Updates

State updates inside async code (like WebSocket event handlers) may not trigger re-renders for `{#if}` blocks. Use `{#key}` to force re-render:

```svelte
{#key someReactiveValue}
  {#if someReactiveValue}
    <Component ... />
  {/if}
{/key}
```

### WebSocket Agent Communication

Frontend connects via WebSocket to `/api/agents/site-builder/{projectId}`:
- `CF_AGENT_USE_CHAT_REQUEST` - Send user message
- `CF_AGENT_USE_CHAT_RESPONSE` - Receive stream chunks
- `CF_AGENT_CHAT_MESSAGES` - Full message history
- `CF_AGENT_STREAM_RESUMING` - Handle stream continuation
- `CF_AGENT_REQUEST_CANCEL` - Stop request

Chat history loaded via GET `/api/agents/site-builder/{projectId}/get-messages`.

### R2 Storage Structure

```
R2 Key Structure:
├── projects/{userId}/{projectId}/.metadata.json
├── projects/{userId}/{projectId}/{filePath}
├── snapshots/{userId}/{projectId}/{snapshotId}.zip
├── snapshots/{userId}/{projectId}/{snapshotId}.json
└── uploads/{userId}/{fileName}
```

All file operations go through `R2ProjectStorage`:
```typescript
const storage = new R2ProjectStorage(env.SITE_STUDIO_BUCKET);
await storage.writeFile(userId, projectId, path, content);
await storage.listFiles(userId, projectId);
await storage.createSnapshot(userId, projectId, { trigger: "agent" });
await storage.restoreSnapshot(userId, projectId, snapshotId);
```

### Adding outputSchema to Codemode Tools

When defining project tools with the AI SDK `tool()` function, always include `outputSchema`. Without it, `@cloudflare/codemode`'s `generateTypes()` produces `Promise<unknown>` return types, causing the agent to guess (often wrongly) what tools return.

```typescript
read_file: tool({
  description: "Read a text file from the project.",
  inputSchema: z.object({ path: z.string() }),
  outputSchema: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), path: z.string(), content: z.string(), truncated: z.boolean() }),
    z.object({ ok: z.literal(false), path: z.string(), message: z.string() })
  ]),
  execute: async ({ path }) => { ... }
})
```

## Security Model

### Isolation Layers

| Layer | Mechanism |
|-------|-----------|
| Code Execution | Dynamic Workers - isolated V8 sandboxes, no network access |
| Path Traversal | `sanitizeFilePath()` in storage layer |
| User Isolation | userId/projectId prefixes in R2 keys |
| Session Management | KV-backed session cookies with TTL |
| Protected Files | `PROTECTED_FILE_NAMES` set prevents deletion of system files |
| Snapshots | Auto-created before destructive operations for recovery |

### Agent Tool Access

The agent only has access to the `codemode` tool (for file operations) and `ask_user_question` (for clarifications). No web access, no shell, no direct file system access.

## Development

```bash
./dev.sh          # Start both app (Wrangler) and frontend (Vite)
bun run build     # Build both packages
```

App (Wrangler): http://localhost:8792
Frontend (Vite): http://localhost:5173

The Vite dev server proxies `/api/*` requests to the Wrangler dev server.

## API Endpoints

### Projects
- `GET /api/projects` - List user projects
- `POST /api/projects` - Create project (with optional template)
- `PATCH /api/projects/:id` - Rename
- `DELETE /api/projects/:id` - Delete
- `POST /api/projects/:id/publish` - Publish to public URL
- `POST /api/projects/:id/unpublish` - Unpublish
- `GET /api/projects/:id/snapshots` - List snapshots
- `POST /api/projects/:id/snapshots` - Create snapshot
- `POST /api/projects/:id/snapshots/:snapshotId/restore` - Restore snapshot

### Files
- `GET /api/projects/:id/files` - List files (tree structure)
- `GET /api/projects/:id/file?path=...` - Read file
- `POST /api/projects/:id/file` - Write file
- `DELETE /api/projects/:id/file?path=...` - Delete file
- `POST /api/projects/:id/upload` - Upload file

### Agent
- `GET/POST/WebSocket /api/agents/site-builder/:projectId` - Agent Durable Object gateway
- `GET /api/agents/site-builder/:projectId/get-messages` - Chat history

### Templates
- `GET /api/templates` - List available templates

### Handles
- `GET /api/handle` - Current user's public handle (or null)
- `GET /api/handle/check?handle=x` - Validate + availability check
- `POST /api/handle` - Claim a handle (claim-once, immutable)

### Preview
- `GET /preview/:id/*` - Live preview (authenticated)
- `GET /u/:handle/:slug/*` - Published sites, canonical (public; keyed by user-chosen handle so the owner/subject id never appears in the URL)
- `GET /sites/:userId/:slug/*` - Published sites, legacy (301s to `/u/…` when the owner has a handle, else serves content directly). Publishing returns 409 `handle_required` until the user claims a handle.

## Common Gotchas

1. **Always use `credentials: 'include'`** in fetch calls that need auth
2. **Svelte 5 runes only** - no `let x = writable()` or `$:` reactive statements
3. **Preview refresh** - call `onUpdate()` after file changes to refresh iframe
4. **Session cookies** - Each browser session gets unique userId; curl without cookies creates new user
5. **outputSchema required** - Always add `outputSchema` to codemode tools or the agent gets `Promise<unknown>` return types
6. **$effect infinite loops** - Be careful with `$effect` that calls async functions updating reactive state - use guard variables to prevent re-triggering
7. **WebSocket not SSE** - Agent communication uses WebSocket, not Server-Sent Events

## Key Files

### App (packages/app)
- `src/agents/site-builder.ts` - Agent Durable Object, all project tools with schemas
- `src/index.ts` - Hono app, route mounting, exports
- `src/routes/projects.ts` - Project CRUD + snapshot endpoints
- `src/routes/files.ts` - File operations
- `src/routes/agents.ts` - WebSocket proxy to Durable Object
- `src/storage/r2.ts` - R2ProjectStorage implementation
- `src/prompts/site-builder.ts` - Agent system prompt
- `wrangler.jsonc` - Cloudflare bindings and config

### Frontend (packages/frontend)
- `routes/editor/[projectId]/+page.svelte` - Main editor page
- `lib/components/AgentChat.svelte` - Chat UI + WebSocket streaming
- `lib/components/ToolExecutionCard.svelte` - Tool execution display
- `lib/components/ProjectHistoryDialog.svelte` - Snapshot management
- `lib/components/Preview.svelte` - Live preview iframe
- `lib/agents/chat.ts` - WebSocket message types and streaming state
- `lib/api/projects.ts` - API client
- `lib/utils/ws.ts` - WebSocket URL resolution
