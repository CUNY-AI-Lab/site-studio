# Site Studio - Codex Guide

## Auto-Invoke Skills

When working on this project, always invoke these skills:

- **frontend-design** - For frontend UI work, preserve a deliberate, production-grade interface
- **svelte-5-runes** - This project uses Svelte 5 runes (`$state`, `$derived`, `$effect`, `$props`)

## What Site Studio Is

Site Studio is a Cloudflare-native AI site builder for academics and researchers. Users describe a site or change in natural language, the agent executes multi-step work inside a sandboxed Dynamic Worker, and the app updates preview and published output from R2-backed storage.

This is not a generic chatbot. The product is centered on direct execution, visible tool activity, and clarification when the request is genuinely ambiguous.

Use [`README.md`](README.md) as the canonical architecture, configuration,
route, compatibility, and local-development reference. Read
[`docs/security-and-recovery.md`](docs/security-and-recovery.md) before changing
or documenting identity, ownership, storage, migration, collaboration,
publishing, caching, uploads, quotas, or rollback behavior.

## Architecture Overview

```text
site-studio/
├── packages/
│   ├── app/                # Cloudflare Worker app + SiteBuilderAgent
│   │   ├── src/
│   │   │   ├── agents/     # AIChatAgent implementation
│   │   │   ├── routes/     # Projects, files, preview, publish, agent route
│   │   │   ├── storage/    # R2-backed project storage
│   │   │   └── lib/        # Auth, path safety, templates, HTTP helpers
│   │   └── wrangler.jsonc
│   └── frontend/           # SvelteKit 5 editor/dashboard
│       └── src/
│           ├── routes/
│           └── lib/
│               ├── agents/     # Cloudflare chat protocol helpers
│               ├── components/ # AgentChat, Preview, tool cards, etc.
│               └── api/
```

## Runtime Model

### App Layer

- Cloudflare Worker + Hono
- Native R2, KV, and Durable Object bindings
- Same-origin preview and public-site serving
- Verified CAIL identity on every product route
- One-time first-login import from a resolvable legacy R2 session

### Agent Layer

- `SiteBuilderAgent` extends `AIChatAgent`
- Model execution via the CAIL model proxy (Cloudflare Workers AI models only)
- Project-scoped instance identity: `userId:projectId`
- `codemode` wraps project operations so the model can write JavaScript that orchestrates multi-step work in a Dynamic Worker sandbox
- `ask_user_question` remains available for structured clarification

## Frontend Transport

- Chat transport is the Cloudflare Agents WebSocket protocol
- Agent route: `/api/agents/site-builder/:projectId`
- Persisted messages route: `/api/agents/site-builder/:projectId/get-messages`
- Before every new or continued model turn, the client POSTs
  `/api/agents/site-builder/:projectId/refresh-credential`; the authenticated
  route replaces the existing socket's connection-local Gateway credential and
  returns an empty, `no-store` response.
- Client tool results / clarification answers: `cf_agent_tool_result`

## Key Technologies

**App / backend surface:**
- Cloudflare Workers
- Hono
- `agents`
- `@cloudflare/ai-chat`
- `@cloudflare/codemode`
- `ai`
- `@cuny-ai-lab/cail-client` + `@ai-sdk/openai-compatible` (CAIL gateway model access)
- Cloudflare R2 / KV / Durable Objects
- Worker Loader

**Frontend:**
- SvelteKit 5
- Tailwind CSS v4
- CodeMirror 6

## Compatibility Position

This is a greenfield product with one narrow data-preservation exception.
Canonical published URLs are `/u/:handle/:slug/*`; there is no `/sites` route,
forwarding pointer, migration window, dual-read, or compatibility API.

On a user's first verified CAIL login only, an old `site-studio-session` cookie
may resolve an unexpired R2 legacy session. Its server-stored anonymous owner is
imported into the exact verified subject. The import must remain idempotent,
must preserve projects/files/snapshots/uploads/chat/published state/handles,
and must write its minimal subject completion record only after success. A
failure returns a private retryable error without replacing the old cookie.
After success, only the subject store is authoritative. Never infer a mapping
from email, content, or a caller-provided identifier.

Do not infer R2 multi-object atomicity from a successful operation. Adopted
project/file writes use the owner-scoped mutation coordinator and recovery
journal; account import and handle mapping use their own conditional contracts.
Keep the README and security/recovery document accurate when those flows change.

## Development

```bash
bun install
bun run dev
```

Local ports:

- App: `http://localhost:8792`
- Frontend: `http://localhost:5173`

## Important Constraints

- Prefer editing the Worker app, not inventing parallel backend code
- Keep preview, publishing, and public serving in that same Worker
- Keep the app static-file oriented; runtime build tools are out of scope
- Do not add compatibility layers beyond the first-login import above
- Preserve the exact two-leg CAIL identity and direct CAIL Gateway model path
- Do not impose arbitrary model token, step, timeout, or message caps
- Call tests E2E only when they cross real process and resource boundaries
- Preserve same-origin assumptions for preview and thumbnail capture unless deliberately redesigned
- Use Svelte 5 runes patterns in frontend code
- Default to execute-plus-clarify, not approval-first UX
