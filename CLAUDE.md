# Site Studio - Claude Code Guide

## Auto-Invoke Skills

When working on this project, always invoke these skills:

- **frontend-design** - For any frontend UI work, use this skill to create distinctive, production-grade interfaces
- **svelte-5-runes** - This project uses Svelte 5 with runes (`$state`, `$derived`, `$effect`, `$props`). Always use modern Svelte 5 patterns

## What Is Site Studio?

Site Studio is an AI-powered web development tool for academics and researchers to build professional static websites through natural language conversation. Users describe what they want, the agent proposes changes with diffs, users approve/reject, and the agent executes.

**Key Innovation:** The plan/approve/execute workflow gives users transparency and control over AI actions. This is NOT a typical chatbot - it's a collaborative editing tool where the AI proposes and the human decides.

**Target Users:** Students, researchers, academics who want professional websites without coding (research portfolios, publication archives, lab websites, course pages).

## Architecture Overview

```
site-studio/
├── packages/
│   ├── backend/          # Express + Claude Agent SDK
│   │   ├── src/
│   │   │   ├── index.ts           # Express app, SSE endpoints
│   │   │   ├── agent.ts           # Agent init, sandbox config, hooks
│   │   │   ├── tools/             # MCP tools (file-tools, template-tools)
│   │   │   ├── storage/           # Storage abstraction (filesystem/R2)
│   │   │   ├── services/          # ProjectSyncService (R2 sync)
│   │   │   ├── config/            # Sandbox config, env validation
│   │   │   ├── sandbox/           # Session management
│   │   │   └── middleware/        # Auth, rate limiting, validation
│   │   └── prompts/               # Agent system prompts
│   │
│   └── frontend/         # SvelteKit 5 + Vite
│       └── src/
│           ├── routes/
│           │   ├── +page.svelte              # Dashboard
│           │   └── editor/[projectId]/       # Main editor
│           └── lib/
│               ├── components/               # UI components
│               │   ├── AgentChat.svelte      # Chat + SSE streaming
│               │   ├── PlanApprovalCard.svelte
│               │   ├── ToolExecutionCard.svelte
│               │   ├── CodeView.svelte       # CodeMirror 6
│               │   ├── Preview.svelte        # Live preview
│               │   └── ui/                   # shadcn-svelte
│               └── api/                      # API client
```

## Two Agent Modes: Standard Tools vs MCP Tools

The agent operates in one of two modes based on `AGENT_SANDBOX_ENABLED`:

### Mode 1: MCP Tools (Default - Sandbox Disabled)
When `AGENT_SANDBOX_ENABLED=false` (default):
- Uses custom MCP tools: `list_files`, `read_file`, `write_file`, `edit_file`, `delete_file`
- MCP tools operate directly on storage (R2 or filesystem)
- Standard tools (Edit, Write, Bash) are blocked

### Mode 2: Standard Tools + Sync (Sandbox Enabled)
When `AGENT_SANDBOX_ENABLED=true`:
- Uses standard Claude Code tools: `Edit`, `Write`, `Glob`, `Grep`
- Optionally enables `Bash` if `AGENT_SANDBOX_AUTO_ALLOW_BASH=true`
- MCP file tools are NOT registered (only template tools remain)
- **ProjectSyncService** handles R2 synchronization:
  - **Hydration**: Downloads R2 files to local projectPath before agent starts
  - **PostToolUse hooks**: Auto-sync local changes to R2 after Edit/Write/Bash

```
Data Flow (Sandbox Mode with R2):
┌─────────┐  hydrate   ┌─────────────┐  agent uses   ┌─────────────┐
│   R2    │ ─────────> │   Local     │ ────────────> │   Local     │
│ Storage │            │ projectPath │  Edit/Write   │   Changes   │
└─────────┘            └─────────────┘               └──────┬──────┘
     ^                                                      │
     │                    PostToolUse hook                  │
     └──────────────────── sync() ──────────────────────────┘
```

## The Plan/Approval Flow

This is what makes Site Studio unusual. The agent uses Claude Agent SDK's `canUseTool` callback:

1. **User sends message** → Backend streams SSE events
2. **Agent wants to use write/edit/delete tool** → `canUseTool` callback fires
3. **Callback creates Promise** that blocks the agent, sends `tool_approval_request` event
4. **Frontend shows PlanApprovalCard** with file operation and diff preview
5. **User clicks Approve/Reject** → POST to `/api/query/tool-approve`
6. **Promise resolves** → Agent continues or skips the tool

**Tools requiring approval** (both MCP and standard):
- MCP: `write_file`, `edit_file`, `delete_file`, `scaffold_template`
- Standard: `Edit`, `Write`, `Bash`

**Two Execution Modes:**
- `mode: 'plan'` (default) - Uses canUseTool, requires approval for writes
- `mode: 'execute'` - Bypasses approval, executes immediately

## Key Technologies

**Backend:**
- Express.js 5 + TypeScript
- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
- Custom MCP tools OR standard tools (based on sandbox config)
- Storage abstraction: filesystem (dev) or Cloudflare R2 (prod)
- ProjectSyncService for R2↔filesystem synchronization
- Pino logging

**Frontend:**
- SvelteKit 5 with runes (NOT Svelte 4 - always use `$state`, `$derived`, etc.)
- Tailwind CSS v4
- CodeMirror 6 for code editing
- shadcn-svelte components (in `lib/components/ui/`)
- SSE streaming for real-time updates

## Environment Configuration

### Core Settings
```bash
PORT=3001
STORAGE_TYPE=r2              # 'filesystem' or 'r2'
AUTH_MODE=anonymous          # 'anonymous' or 'required'
```

### R2 Storage (when STORAGE_TYPE=r2)
```bash
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=site-studio
R2_PUBLIC_DOMAIN=https://...
```

### SDK Sandbox (enables standard tools + build tools)
```bash
AGENT_SANDBOX_ENABLED=true           # Enable OS-level sandbox (bubblewrap)
AGENT_SANDBOX_AUTO_ALLOW_BASH=true   # Allow Bash for Hugo, npm, etc.
AGENT_SANDBOX_ALLOW_LOCAL_BINDING=false
```

When sandbox is enabled:
- Agent can run Hugo, npm, and other build tools
- Files are synced between local filesystem and R2
- OS-level isolation via bubblewrap (Linux) or seatbelt (macOS)

## Important Patterns

### Svelte 5 Async State Updates

State updates inside async code (like SSE event handlers) may not trigger re-renders for `{#if}` blocks. Use `{#key}` to force re-render:

```svelte
{#key pendingToolApproval}
  {#if pendingToolApproval}
    <PlanApprovalCard ... />
  {/if}
{/key}
```

### SSE Event Streaming

Frontend connects to `/api/query` which streams events:
- `tool_approval_request` - Agent needs approval (blocking)
- `stream_event` - Text deltas for real-time typing
- `assistant` - Complete message blocks with tool_use
- `user` - Tool results
- `system` - Init with session_id

### Storage Abstraction

All file operations go through `IStorage` interface:

```typescript
const storage = getStorage(); // Returns singleton (R2 or Filesystem)
await storage.writeFile(userId, projectId, path, content);
await storage.listFiles(userId, projectId);
```

### ProjectSyncService (R2 mode with sandbox)

```typescript
// Hydrate: R2 → Local (before agent starts)
await syncService.hydrate(userId, projectId, projectPath);

// Sync: Local → R2 (after file-modifying tools)
await syncService.sync(userId, projectId, projectPath);
```

Sync detects changes by mtime comparison, uploads modified files, handles deletions.

### PostToolUse Hooks

When sandbox is enabled with R2 storage, hooks auto-sync after file operations:

```typescript
queryOptions.hooks = {
  PostToolUse: [{
    matcher: 'Edit|Write|Bash',
    hooks: [async (input, toolUseId, { signal }) => {
      await syncService.sync(userId, projectId, projectPath);
      return {};
    }],
  }],
};
```

## Security Model

### Tool Access Control

**Always Disallowed:**
- `WebSearch`, `WebFetch` - No web access
- `Task`, `SlashCommand`, `Skill` - No agent recursion
- `NotebookEdit`, `AskUserQuestion` - Not needed

**Conditionally Allowed (sandbox mode only):**
- `Edit`, `Write`, `Glob`, `Grep` - File operations
- `Bash`, `BashOutput`, `KillShell` - Build tools (if AGENT_SANDBOX_AUTO_ALLOW_BASH)

**Always Allowed:**
- `TodoWrite` - Helps users see agent planning
- `Read` - Safe read-only operation
- MCP template tools - `scaffold_template`, `add_page`

### Isolation Layers

| Layer | Mechanism |
|-------|-----------|
| Tool Access | `disallowedTools` array in agent.ts |
| Path Traversal | Input validation in storage layer |
| User Isolation | userId/projectId prefixes in storage keys |
| File Write Approval | `canUseTool` callback + frontend approval |
| OS Isolation | Bubblewrap sandbox (when enabled) |
| Session Limits | 30min inactivity timeout |

## Development

```bash
./dev.sh          # Start both frontend and backend
npm run build     # Build both packages
```

Backend: http://localhost:3001
Frontend: http://localhost:5173

### Testing Sandbox Mode

1. Set environment variables:
```bash
AGENT_SANDBOX_ENABLED=true
AGENT_SANDBOX_AUTO_ALLOW_BASH=true
```

2. Restart backend
3. Ask agent to run Hugo or npm commands
4. Verify files sync to R2

## API Endpoints

### Projects
- `GET /api/projects` - List user projects
- `POST /api/projects` - Create project (with optional template)
- `PATCH /api/projects/:id` - Rename
- `DELETE /api/projects/:id` - Delete
- `POST /api/projects/:id/publish` - Publish to public URL
- `POST /api/projects/:id/unpublish` - Unpublish

### Files
- `GET /api/projects/:id/files` - List files (tree structure)
- `GET /api/projects/:id/file?path=...` - Read file
- `POST /api/projects/:id/file` - Write file
- `DELETE /api/projects/:id/files?path=...` - Delete file
- `POST /api/projects/:id/upload` - Upload file (32MB limit)

### Agent
- `POST /api/query` - SSE stream for agent queries
- `POST /api/query/tool-approve` - Tool approval callback

### Preview
- `GET /preview/:id` - Live preview (authenticated)
- `GET /sites/:userId/:slug/*` - Published sites (public)

## Common Gotchas

1. **Always use `credentials: 'include'`** in fetch calls that need auth
2. **Use `flex-shrink: 0`** on cards in flex containers to prevent squeezing
3. **Svelte 5 runes only** - no `let x = writable()` or `$:` reactive statements
4. **Preview refresh** - call `onUpdate()` after file changes to refresh iframe
5. **Tool IDs** - each tool execution has unique ID for tracking revert state
6. **Session cookies** - Each browser session gets unique userId; curl without cookies creates new user
7. **Sandbox paths** - Standard tools need absolute paths (e.g., `/home/.../sandboxes/user/proj/file.html`)

## File Structure Reference

### Backend Key Files
- `src/index.ts` - Express app, all endpoints (~1600 lines)
- `src/agent.ts` - Agent configuration, hooks (~450 lines)
- `src/services/project-sync.ts` - R2 sync service (~320 lines)
- `src/config/sandbox-config.ts` - Sandbox env config
- `src/storage/r2-storage.ts` - R2 implementation
- `src/tools/file-tools.ts` - MCP file tools
- `src/tools/template-tools.ts` - MCP template tools

### Frontend Key Files
- `routes/editor/[projectId]/+page.svelte` - Main editor (~780 lines)
- `lib/components/AgentChat.svelte` - Chat UI (~1070 lines)
- `lib/components/PlanApprovalCard.svelte` - Approval UI (~530 lines)
- `lib/components/Preview.svelte` - Dual-iframe preview
- `lib/api/projects.ts` - API client

### Potentially Unused (candidates for removal)
- `lib/components/DiffPreview.svelte` - Replaced by DiffDisplay.svelte
- `lib/components/TemplateCard.svelte` - Unused in current UI
