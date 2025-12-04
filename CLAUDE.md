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
│   │   │   ├── index.ts      # Express app, SSE endpoints
│   │   │   ├── agent.ts      # Agent init, canUseTool callback
│   │   │   ├── tools/        # MCP tools (file-tools, template-tools)
│   │   │   ├── storage/      # Storage abstraction (filesystem/R2)
│   │   │   └── sandbox/      # Per-user sandboxing
│   │   └── prompts/          # Agent system prompts
│   │
│   └── frontend/         # SvelteKit 5 + Vite
│       └── src/
│           ├── routes/editor/[projectId]/  # Main editor
│           └── lib/components/
│               ├── AgentChat.svelte        # Chat + SSE streaming
│               ├── PlanApprovalCard.svelte # Approval UI with diffs
│               ├── ToolExecutionCard.svelte
│               ├── CodeView.svelte         # CodeMirror 6
│               └── Preview.svelte          # Live preview
```

## The Plan/Approval Flow (Core Architecture)

This is what makes Site Studio unusual. The agent uses Claude Agent SDK's `canUseTool` callback:

1. **User sends message** → Backend streams SSE events
2. **Agent wants to use write/edit/delete tool** → `canUseTool` callback fires
3. **Callback creates Promise** that blocks the agent, sends `tool_approval_request` event to frontend
4. **Frontend shows PlanApprovalCard** with file operation and diff preview
5. **User clicks Approve/Reject** → POST to `/api/query/tool-approve`
6. **Promise resolves** → Agent continues or skips the tool

```typescript
// In agent.ts - this is the key pattern
queryOptions.canUseTool = async (toolName, input) => {
  if (!toolsRequiringApproval.includes(toolName)) {
    return { behavior: 'allow', updatedInput: input };
  }

  return new Promise((resolve) => {
    // Send event to frontend, wait for user response
    toolApprovalCallback({
      id: requestId,
      toolName,
      input,
      resolve: (approved) => {
        resolve(approved
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'User declined' }
        );
      }
    });
  });
};
```

**Two Modes:**
- `mode: 'plan'` (default) - Uses canUseTool, requires approval for writes
- `mode: 'execute'` - Bypasses approval, executes immediately

## Key Technologies

**Backend:**
- Express.js 5 + TypeScript
- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
- Custom MCP tools for file operations
- Storage abstraction: filesystem (dev) or Cloudflare R2 (prod)
- Pino logging

**Frontend:**
- SvelteKit 5 with runes (NOT Svelte 4 - always use `$state`, `$derived`, etc.)
- Tailwind CSS v4
- CodeMirror 6 for code editing
- shadcn-svelte components (in `lib/components/ui/`)
- SSE streaming for real-time updates

## Important Patterns

### Svelte 5 Async State Updates

State updates inside async code (like SSE event handlers in `for await` loops) may not trigger re-renders for `{#if}` blocks. Use `{#key}` to force re-render:

```svelte
{#key pendingToolApproval}
  {#if pendingToolApproval}
    <PlanApprovalCard ... />
  {/if}
{/key}
```

### SSE Event Streaming

Frontend connects to `/api/query` which streams events:
- `tool_approval_request` - Agent needs approval
- `stream_event` - Text deltas for real-time typing
- `assistant` - Complete message blocks
- `user` - Tool results

### Storage Abstraction

All file operations go through `IStorage` interface. Tools don't know if using filesystem or R2:

```typescript
const storage = getStorage(); // Returns singleton
await storage.writeFile(userId, projectId, path, content);
```

### MCP Tools

Custom tools registered via `createSdkMcpServer`:
- `list_files`, `read_file`, `write_file`, `edit_file`, `delete_file`
- `scaffold_template`, `add_page`

Tools requiring approval: `write_file`, `edit_file`, `delete_file`, `scaffold_template`

## Development

```bash
./dev.sh          # Start both frontend and backend with proper cleanup
npm run build     # Build both packages
```

Backend: http://localhost:3001
Frontend: http://localhost:5173

## Security Model

The agent is restricted to only MCP site-studio tools. These are explicitly disallowed:
- Bash, WebSearch, WebFetch (no system/web access)
- Task, SlashCommand, Skill (no agent recursion)
- Edit, Write, Glob, Grep (use MCP tools instead)

Each user gets sandboxed to their own `sandboxes/{userId}/` directory.

## Common Gotchas

1. **Always use `credentials: 'include'`** in fetch calls that need auth
2. **Use `flex-shrink: 0`** on cards in flex containers to prevent squeezing
3. **Svelte 5 runes only** - no `let x = writable()` or `$:` reactive statements
4. **Preview refresh** - call `onUpdate()` after file changes to refresh iframe
5. **Tool IDs** - each tool execution has unique ID for tracking revert state
