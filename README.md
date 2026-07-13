# Site Studio

Site Studio is a Cloudflare-native AI website builder for academics and researchers. Users describe a site or change in natural language, the agent works directly in a sandboxed Dynamic Worker, and the app updates preview and published output from R2-backed project storage.

## Current Stack

- **Frontend:** SvelteKit 5, Tailwind CSS v4, CodeMirror 6
- **App runtime:** Cloudflare Workers + Hono
- **Agent runtime:** Cloudflare Agents SDK + `@cloudflare/ai-chat`
- **Sandbox execution:** Dynamic Worker Loader + `@cloudflare/codemode`
- **Model access:** CAIL model proxy → Cloudflare Workers AI (`@cf/zai-org/glm-5.2` default)
- **Storage:** Cloudflare R2 + KV + Durable Objects

## Repo Layout

```text
site-studio/
├── packages/
│   ├── app/                # Cloudflare Worker app + AI chat agent
│   │   ├── src/
│   │   │   ├── agents/     # SiteBuilderAgent
│   │   │   ├── routes/     # Projects, files, preview, publish, agents
│   │   │   ├── storage/    # R2-backed project storage
│   │   │   └── lib/        # Auth, paths, templates, HTTP helpers
│   │   └── wrangler.jsonc
│   ├── frontend/           # SvelteKit dashboard/editor
│   ├── serving-core/       # Shared published/preview HTTP behavior
│   └── worker/             # Legacy-domain published-site Worker
```

## What Works

- Project CRUD against existing R2 data
- Legacy anonymous-session recovery for returning users
- Live preview at `/preview/:projectId/*`
- Public published sites at `/u/:handle/:slug/*` (legacy `/sites/:userId/:slug/*` serves or 301s)
- Cloudflare Agents chat transport with persisted messages
- Dynamic Worker sandbox execution for multi-step project edits
- Clarification questions when a request is materially ambiguous

## Local Development

```bash
bun install
bun run dev
```

This starts:

- App: [http://localhost:8792](http://localhost:8792)
- Frontend: [http://localhost:5173](http://localhost:5173)

All packages share one Bun workspace and lockfile. To use different local ports, run the package commands directly and pass Vite/Wrangler `--port` flags.

## Environment

Local Worker secrets live in:

- [`packages/app/.dev.vars`](/Users/stephenzweibel/Apps/site-studio/packages/app/.dev.vars)

Local identity verification secrets are ops-managed (see cail-gateway
docs/INTEGRATION.md). Configure either or both during the additive V2 rollout:

```bash
CAIL_IDENTITY_JWT_SECRET=...
CAIL_IDENTITY_JWKS={"keys":[...]}
```

`X-CAIL-Identity-JWT-V2` is authoritative when present. Site Studio verifies
it as RS256 with audience `cail:site-studio` and the canonical/staging issuer
allowlist. Missing or malformed JWKS and invalid V2 tokens reject without V1
fallback. With no V2 header, the existing HS256 `X-CAIL-Identity-JWT` path is
unchanged. `CAIL_REQUIRE_IDENTITY=true` fails closed whether V1, V2, or both are
configured.

Site Studio holds no provider API keys — model calls go through the CAIL
model proxy, which attaches credentials itself.

The Worker also reads these vars from [`packages/app/wrangler.jsonc`](/Users/stephenzweibel/Apps/site-studio/packages/app/wrangler.jsonc):

- `APP_PUBLIC_DOMAIN`
- `PUBLISHED_BASE_URL`
- `CAIL_API_BASE`
- `CAIL_MODEL` (Workers AI `@cf/...` id only — CAIL policy is Cloudflare models only)
- `CAIL_REQUIRE_IDENTITY`

For production, configure secrets with Wrangler / Cloudflare, not by committing env files.

The app stores CSRF tokens under the `csrf/` prefix in the existing private R2
bucket. Match their 30-day session lifetime with a bucket lifecycle rule:

```bash
bunx wrangler r2 bucket lifecycle add site-studio delete-expired-csrf csrf/ --expire-days 30 --force
```

## Main Routes

- `GET /api/health`
- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/:id/files`
- `POST /api/projects/:id/file`
- `POST /api/projects/:id/upload`
- `GET /preview/:id/*`
- `POST /api/projects/:id/publish` (409 `handle_required` until the user claims a handle)
- `POST /api/projects/:id/unpublish`
- `GET /api/handle`, `GET /api/handle/check?handle=…`, `POST /api/handle`
- `ALL /api/agents/site-builder/:projectId`
- `GET /u/:handle/:slug/*` (canonical published sites)
- `GET /sites/:userId/:slug/*` (legacy: 301s to `/u/…` when the owner has a handle, else serves)

## Notes

- The new app is a static-file site builder. Runtime build tools are out of scope.
- The normal chat path is execute-first, not approve-first.
- The built-in gallery includes blank, CV, course, portfolio, publication, event, photo, resource, timeline, and data-visualization templates.
- Canonical published URLs are `/u/:handle/:slug/`, keyed by a user-chosen handle so the owner id never appears in a public URL. Old published sites remain readable from the same R2 bucket via the legacy `/sites/:userId/:slug/*` shape, which 301s to the `/u/…` equivalent once the owner has a handle and otherwise serves content directly.

## License

MIT
