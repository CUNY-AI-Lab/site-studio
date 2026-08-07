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
- Anonymous-session continuity while identity is optional
- Bounded anonymous-to-CAIL account import when the import window is configured
- Live preview at `/preview/:projectId/*`
- Public published sites at `/u/:handle/:slug/*` (legacy `/sites/:userId/:slug/*` serves or 301s)
- Cloudflare Agents chat transport with persisted messages
- Dynamic Worker sandbox execution for multi-step project edits
- Clarification questions when a request is materially ambiguous

This checkout is a source candidate, not evidence of the active deployment.
`wrangler.jsonc` records intended bindings and routes; it does not prove the
dashboard-managed app route, R2 lifecycle rules, Analytics Engine binding,
gateway/SSO cutover, or currently deployed Worker versions. No deployment is
authorized by this repository documentation.

## Local Development

```bash
bun install
bun run dev
```

This starts:

- App: [http://localhost:8792](http://localhost:8792)
- Frontend: [http://localhost:5173](http://localhost:5173)

All packages share one Bun workspace and lockfile. To use different local ports, run the package commands directly and pass Vite/Wrangler `--port` flags.

The repository also includes owner-session debugging utilities:

```bash
bun run chat:debug -- --prompt "Create a landing page"
bun run trace -- --project <project-id>
```

Both default to `http://127.0.0.1:8792`, accept `--help`, and persist their local
debug session cookie in the gitignored `.site-studio-debug-session.json` file
with owner-only permissions. They obtain the same CSRF cookie used by the
frontend before project writes or WebSocket upgrades.

The checked-in CI workflow installs from the frozen Bun lockfile, runs the
repository invariant/link/secret scan and the full check suite, then bundles
both Workers with Wrangler in dry-run mode. Its third-party Actions are pinned
to full commit SHAs and checkout does not persist credentials. The locked CAIL
packages resolve from GitHub Packages and return 401 without authentication, so
hosted CI supplies `CAIL_PACKAGES_TOKEN` as `NODE_AUTH_TOKEN` only on the
dependency-install step; tests and builds do not inherit it. Run the same source
gates locally:

```bash
bun run verify:repository
bun run check
```

## Environment

Local Worker secrets live in the gitignored `packages/app/.dev.vars` file.

Local identity verification material is ops-managed (see cail-gateway
docs/INTEGRATION.md):

```bash
CAIL_IDENTITY_JWKS={"keys":[...]}
CAIL_IDENTITY_PROFILE=production
CAIL_IDENTITY_ISSUER=https://tools.ailab.gc.cuny.edu/cail-sso
```

Site Studio accepts identity only in `X-CAIL-Identity-JWT` and verifies it as
RS256 against `CAIL_IDENTITY_JWKS`, with the scalar audience
`cail:site-studio` and exactly one source-owned identity profile. `production`
requires the canonical production issuer; `staging` requires the canonical
staging issuer. `CAIL_IDENTITY_ISSUER` is retained as an exact compatibility
assertion and cannot select a new trust root. Production and staging issuers
cannot share a verifier configuration. A presented token rejects when any
setting is missing or mismatched or verification fails. The signed `sub` is preserved byte-for-byte
as the durable owner key. `CAIL_REQUIRE_IDENTITY=true`
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
- `CAIL_IMAGE_MODEL`
- `CAIL_IMAGE_CLASSIFIER`
- `CAIL_REQUIRE_IDENTITY`
- `CAIL_IDENTITY_PROFILE` (`production` or `staging`; selects a source-owned issuer)
- `CAIL_IDENTITY_ISSUER` (deployment assertion matching the selected profile)
- `CAIL_SSO_SWITCHED_AT`
- `CAIL_ACCOUNT_IMPORT_UNTIL`
- `CSRF_COOKIE_PATH` (must be `/site-studio` on the shared production origin)
- `SITE_STUDIO_MAX_PROJECT_BYTES` (required positive integer for uploads)
- `SITE_STUDIO_MAX_OWNER_BYTES` (required positive integer for uploads)
- `SITE_STUDIO_UPLOADS_PER_MINUTE` (required positive integer)
- `CAIL_LOG_ENV`

The three upload-policy values have no source default. Uploads fail with 503
until operators choose and configure them. The application also requires the
`MUTATION_COORDINATOR` Durable Object binding and Wrangler SQLite migration
`v3`; deploy the migration before routing traffic to source that calls it.

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
- `GET /api/quota` (authenticated CAIL quota snapshot; subject removed)
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

Slashless published roots redirect permanently to the corresponding trailing-
slash URL so authored relative assets resolve beneath the site root.

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

The portable log envelope is cail-log schema 2. Platform loggers use subject
version `v1`; the durable unversioned CAIL owner key is not rewritten in
storage, while its logging projection is `cail-v1-<32 lowercase hex>`. Custom
diagnostic catalogs use the library-owned `Service event recorded.` body, and
all Workers/Analytics Engine adapters accept only same-instance events produced
by `createCailLogger`.

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

See [`docs/cail-log-alignment.md`](docs/cail-log-alignment.md) for the event map,
denominator rules, operating defaults, and remaining external inputs.

The package manifests pin the reviewed CAIL primitives to one published
instance each: `cail-identity` `5.1.0`, `cail-log` `0.6.0`, and `cail-client`
`3.0.0`. Review lockfile changes as dependency changes rather than treating
the package versions as immutable source pins. Site Studio does not directly
depend on `cail-sandbox-client`; Sandbox accounting remains an external
authority rather than an application transport boundary.

## Security, ownership, and recovery boundaries

- Verified requests are owned by the stable CAIL subject from the RS256 JWT;
  anonymous requests use a random `user_...` namespace only while identity is
  optional. Email and display names are never storage keys.
- A `SiteBuilderAgent` Durable Object is keyed by `ownerId:projectId`. There is
  no sharing, membership, role, invitation, or cross-user collaborative-editing
  model. An owner-scoped `MutationCoordinator` serializes adopted project/file
  mutations and publish-state changes from concurrent tabs and agent connections
  through a rejection-safe operation queue.
- Editor and agent text writes use ETag compare-and-set when they have a base
  version. Upload and rename destinations use put-if-absent. Multi-object
  create, rename, delete, restore, and template replacement record recoverable
  coordinator journals. Project creation claims carry a journal operation id
  and remain hidden until every template file lands. Published deletes hide
  metadata before deleting files; published renames copy into a hidden target
  and durably activate it only after every file, thumbnail, and snapshot has
  copied.
- Publishing is a live metadata visibility flag over the current project files,
  not an immutable release artifact. Editing or restoring a published project
  changes the public bytes without another publish action. Published URLs use
  `public, max-age=0, must-revalidate` with validators. Unpublish cannot revoke
  bytes already downloaded by a client.
- Agent snapshots keep the newest 50 restore points and skip projects above 50
  MiB. A destructive restore or whole-template replacement requires a safety
  snapshot; ordinary agent text edits may proceed when their optional snapshot
  is skipped.
- Autosave retains conflicts as pending local drafts. Drafts are AES-GCM
  encrypted under the path-scoped, per-owner CSRF token before they enter
  origin-wide browser storage, carry their base ETag, and clear only the exact
  content acknowledged by R2. The unload keepalive remains best effort.
- WebSocket upgrades require the per-owner CSRF token and an accepted origin.
  The frontend reconnects before a new turn when a socket is older than four
  minutes and rejects stale history, socket initialization, and frames after a
  project switch. Every gateway POST checks the captured JWT expiry; an expired
  long-running turn stops and reconnects before retry.
- Preview bearer grants expire after ten minutes, inherit their parent grant's
  absolute deadline, and authorize only the relative resources linked by the
  rendered document. Chat Markdown cannot render images or initiate remote
  image requests from the authenticated application origin.
- The chat displays the typed gateway quota percentage. Uploads require explicit
  project/owner byte limits and a rolling per-owner rate configured by operators.

See [`docs/security-and-recovery.md`](docs/security-and-recovery.md) for the
trust-boundary inventory, admission rules, journals, and rollback limitations.

## Notes

- The new app is a static-file site builder. Runtime build tools are out of scope.
- The normal chat path is execute-first, not approve-first.
- The built-in gallery includes blank, CV, course, portfolio, publication, event, photo, resource, timeline, and data-visualization templates.
- Canonical published URLs are `/u/:handle/:slug/`, keyed by a user-chosen handle so new URLs do not expose the owner id. `/sites/:userId/:slug/*`, direct serving, mapped-slug redirects, and `.migrated.json` forwarding-pointer resolution are a permanent compatibility contract and must survive temporary account-import cleanup.

See [`docs/legacy-account-import-removal.md`](docs/legacy-account-import-removal.md)
for the temporary import telemetry and deletion follow-up.

## License

MIT
