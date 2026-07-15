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
- Anonymous session cookie continuity via `site-studio-session`

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

## Compatibility Requirements

This is a rewrite, not a migration, but two compatibility layers matter:

- Canonical published URLs are `/u/:handle/:slug/*` (user-chosen handle; the owner/subject id never appears in a public URL). Old published sites must still resolve permanently from the same R2 content and the legacy `/sites/:userId/:slug/*` shape, which 301s to the `/u/…` equivalent once the owner has a handle and otherwise serves directly. This is a permanent compatibility exception, not part of temporary account-import cleanup; retain `/sites` routes and `.migrated.json` forwarding-pointer behavior.
- During the configured account-import window only, returning anonymous users should see prior projects when their legacy `site-studio-session` cookie can be resolved from R2 session records. Remove this import path by `CAIL_ACCOUNT_IMPORT_UNTIL`, no later than 30 days after the switch.

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
- Keep the app static-file oriented; runtime build tools are out of scope
- Treat this as a greenfield app, not a migration
- Preserve same-origin assumptions for preview and thumbnail capture unless deliberately redesigned
- Use Svelte 5 runes patterns in frontend code
- Default to execute-plus-clarify, not approval-first UX
