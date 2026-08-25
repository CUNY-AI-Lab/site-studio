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
- Preview and public-site bytes served by the app Worker; authored documents
  execute in an opaque-origin sandbox and cannot rely on app-origin authority
- Verified CAIL identity on every product route
- One-time first-login import from a resolvable legacy R2 session

### Agent Layer

- `SiteBuilderAgent` extends `AIChatAgent`
- Model execution via the CAIL model proxy (Cloudflare Workers AI models only)
- Project-scoped instance identity: `userId:projectId`
- `codemode` wraps project operations so the model can write JavaScript that orchestrates multi-step work in a Dynamic Worker sandbox
- `ask_user_question` remains available for structured clarification
- The active default model is the Workers AI catalog id
  `@cf/zai-org/glm-5.2`; any `CAIL_MODEL` override must remain a `@cf/...` id

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
Canonical published URLs are `/u/:handle/:slug/*`; the handle and slug are the
durable public identity while `PUBLISHED_BASE_URL` is the deployment mount.
API links derive that current base at read time, so moving the mount does not
rewrite or republish projects. There is no `/sites` route, forwarding pointer,
migration window, dual-read, or compatibility API. Any DNS or redirect work
for an old mount belongs to deployment configuration, not project storage.

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

### Test value

Tests should prove actions a person can take and the boundaries those actions
depend on. Keep unit tests for pure helpers, process tests for the Hono route
and storage contract, Worker tests for Cloudflare binding behavior, and browser
acceptance for visible navigation, project creation, editing, preview execution,
chat/tool streaming, stop/recovery, persisted chat commit, version recovery,
downloads, archive contents, reload, and cleanup. Browser tests use accessible
controls and assert executed preview outcomes; they do not inspect CSS classes,
component internals, or exact model prose. Use deterministic model or service
fakes at the smallest boundary needed for a repeatable run, and inject failures
only when a deliberate recovery path is being tested. The local browser harness
uses a deterministic `SITE_BUILDER_AGENT` service-binding fake to cross the
production Hono/WebSocket boundary; it must not claim native Durable Object or
provider coverage. Model prose and response quality are advisory; a green test
must not be presented as evidence of either.

- Prefer editing the Worker app, not inventing parallel backend code
- Keep preview, publishing, and public serving in that same Worker
- Keep the app static-file oriented; runtime build tools are out of scope
- Do not add compatibility layers beyond the first-login import above
- Preserve the exact two-leg CAIL identity and direct CAIL Gateway model path
- Do not impose arbitrary model token, step, timeout, or message caps
- Call tests E2E only when they cross real process and resource boundaries
- Use `bun run e2e:live` for the direct signed-identity production product
  path; it owns only its random project and is not evidence of a CUNY/Doorway
  browser login
- Production release is CI-only: `.github/workflows/ci.yml` verifies PRs and
  main, then serializes the main build/deploy. Exact-SHA readback and health,
  root, and unauthenticated no-store-401 probes are release gates. There is no
  checked-in staging Worker/storage topology, so there is no PR production
  preview.
- Preserve the opaque-origin preview boundary. Authored documents never receive
  `allow-same-origin`; linked preview resources use short-lived,
  project-and-path-scoped capabilities, and successful authored JavaScript and
  font responses use uncredentialed wildcard CORS so they can load from that
  opaque origin.
- Use Svelte 5 runes patterns in frontend code
- Default to execute-plus-clarify, not approval-first UX
