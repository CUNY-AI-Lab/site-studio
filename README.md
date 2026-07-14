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

Local identity verification material is ops-managed (see cail-gateway
docs/INTEGRATION.md):

```bash
CAIL_IDENTITY_JWKS={"keys":[...]}
```

Site Studio accepts identity only in `X-CAIL-Identity-JWT` and verifies it as
RS256 against `CAIL_IDENTITY_JWKS`, with audience `cail:site-studio` and the
canonical/staging issuer allowlist. A presented token rejects when the JWKS is
missing or malformed or verification fails. `CAIL_REQUIRE_IDENTITY=true`
rejects requests that do not carry a verified identity.

Identity enforcement also requires a bounded legacy-account import window:

```bash
CAIL_SSO_SWITCHED_AT=2026-07-13T14:00:00Z
CAIL_ACCOUNT_IMPORT_UNTIL=2026-07-27T14:00:00Z
```

Both values must be ISO 8601 instants with an explicit UTC offset. The import
window is half-open (`CAIL_SSO_SWITCHED_AT <= now < CAIL_ACCOUNT_IMPORT_UNTIL`),
the end must not precede the start, and the duration cannot exceed 30 days.
When `CAIL_REQUIRE_IDENTITY=true`, missing or invalid values fail protected
requests with `500 invalid_account_import_configuration`. While identity is
optional, bad or absent window configuration disables legacy import.

Site Studio holds no provider API keys — model calls go through the CAIL
model proxy, which attaches credentials itself.

The Worker also reads these vars from [`packages/app/wrangler.jsonc`](/Users/stephenzweibel/Apps/site-studio/packages/app/wrangler.jsonc):

- `APP_PUBLIC_DOMAIN`
- `PUBLISHED_BASE_URL`
- `CAIL_API_BASE`
- `CAIL_MODEL` (Workers AI `@cf/...` id only — CAIL policy is Cloudflare models only)
- `CAIL_REQUIRE_IDENTITY`
- `CAIL_SSO_SWITCHED_AT`
- `CAIL_ACCOUNT_IMPORT_UNTIL`

For production, configure secrets with Wrangler / Cloudflare, not by committing env files.

The app stores CSRF tokens under the `csrf/` prefix in the existing private R2
bucket. Match their 30-day session lifetime with a bucket lifecycle rule:

```bash
bunx wrangler r2 bucket lifecycle add site-studio delete-expired-csrf csrf/ --expire-days 30 --force
```

## Main Routes

- `GET /api/health`
- `GET /healthz` on the published-site Worker
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

## Observability contract

Both Workers persist structured custom events and explicitly disable Cloudflare
invocation logs so user-controlled URL segments are not stored as raw invocation
messages. Build and publish events use fixed route templates from
[`packages/observability-core/src/contract.ts`](packages/observability-core/src/contract.ts),
which also defines dashboard groupings, lifecycle-pair quality checks, and the
versioned liveness responses. The same source contract fixes the initial
one-minute Eastern North America synthetic profile, rolling 24-hour SLO and
alert thresholds, month-to-date gateway-ledger spend bands, Kale-admin-only
access, full custom-log sampling, and no v1 external exporter.

When an operator supplies the optional `CAIL_FLEET_EVENTS` binding, each trusted
Worker boundary also projects accepted events through cail-log's versioned
`cail_fleet_events_v1` Analytics Engine schema. Those weighted cohort aggregates
are diagnostic only. Exact build/publish success and coverage come from the
project-scoped durable action-attempt records exposed by the existing
authenticated observability read; model and Sandbox costs remain in their
respective accounting systems.

`GET /api/health` and the publisher's `GET /healthz` return static
`cail.health.v1` liveness markers with `Cache-Control: no-store`. They prove that
the relevant Worker loaded and dispatched the request; they deliberately do not
claim readiness for R2, KV, Durable Objects, or the model gateway.

See [`docs/cail-log-alignment.md`](docs/cail-log-alignment.md) for the event map
and [`docs/observability-design-gate.md`](docs/observability-design-gate.md) for
the exact denominator rules, operating defaults, and remaining external inputs.

## Notes

- The new app is a static-file site builder. Runtime build tools are out of scope.
- The normal chat path is execute-first, not approve-first.
- The built-in gallery includes blank, CV, course, portfolio, publication, event, photo, resource, timeline, and data-visualization templates.
- Canonical published URLs are `/u/:handle/:slug/`, keyed by a user-chosen handle so the owner id never appears in a public URL. Old published sites remain readable permanently from the same R2 bucket via the legacy `/sites/:userId/:slug/*` shape, which 301s to the `/u/…` equivalent once the owner has a handle and otherwise serves content directly. This is a permanent compatibility exception: temporary account-import cleanup must retain `/sites` routing, direct serving, redirects, and `.migrated.json` forwarding-pointer resolution.

See [`docs/legacy-account-import-removal.md`](docs/legacy-account-import-removal.md)
for the temporary import telemetry and deletion follow-up.

## License

MIT
