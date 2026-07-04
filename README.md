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
│   └── frontend/           # SvelteKit dashboard/editor
└── dynamic-workers-plan.md # Rewrite / cutover plan
```

## What Works

- Project CRUD against existing R2 data
- Legacy anonymous-session recovery for returning users
- Live preview at `/preview/:projectId/*`
- Public published sites at `/sites/:userId/:slug/*`
- Cloudflare Agents chat transport with persisted messages
- Dynamic Worker sandbox execution for multi-step project edits
- Clarification questions when a request is materially ambiguous

## Local Development

```bash
npm install
./dev.sh
```

This starts:

- App: [http://localhost:8792](http://localhost:8792)
- Frontend: [http://localhost:5173](http://localhost:5173)

The root `postinstall` installs frontend dependencies and the standalone Worker app dependencies.

## Environment

Local Worker secrets live in:

- [`packages/app/.dev.vars`](/Users/stephenzweibel/Apps/site-studio/packages/app/.dev.vars)

Required local secret (ops-managed; see cail-gateway docs/INTEGRATION.md):

```bash
CAIL_IDENTITY_JWT_SECRET=...
```

Site Studio holds no provider API keys — model calls go through the CAIL
model proxy, which attaches credentials itself.

The Worker also reads these vars from [`packages/app/wrangler.jsonc`](/Users/stephenzweibel/Apps/site-studio/packages/app/wrangler.jsonc):

- `APP_PUBLIC_DOMAIN`
- `LEGACY_PUBLIC_DOMAIN`
- `CAIL_API_BASE`
- `CAIL_MODEL` (Workers AI `@cf/...` id only — CAIL policy is Cloudflare models only)
- `CAIL_REQUIRE_IDENTITY`

For production, configure secrets with Wrangler / Cloudflare, not by committing env files.

## Main Routes

- `GET /api/health`
- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/:id/files`
- `POST /api/projects/:id/file`
- `POST /api/projects/:id/upload`
- `GET /preview/:id/*`
- `POST /api/projects/:id/publish`
- `POST /api/projects/:id/unpublish`
- `ALL /api/agents/site-builder/:projectId`
- `GET /sites/:userId/:slug/*`

## Notes

- The new app is a static-file site builder. Runtime build tools are out of scope.
- The normal chat path is execute-first, not approve-first.
- The blank template is the only built-in template currently wired in the Worker app.
- Old published sites remain readable from the same R2 bucket and legacy `/sites/:userId/:slug/*` shape.

## License

MIT
