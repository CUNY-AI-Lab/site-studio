# Site Studio

Site Studio is the smallest useful AI site builder for CUNY academics and
researchers: describe a site, let the agent edit static files, preview the
result, and publish it.

## Architecture

There are two product packages and one deployed Worker:

```text
packages/
├── app/       Cloudflare Worker, Hono API, SiteBuilderAgent, preview and publish serving
└── frontend/  SvelteKit 5 dashboard and editor, built into the app Worker assets
```

The app stores project files and metadata in R2, small coordination records in
KV, and chat/mutation state in Durable Objects. `SiteBuilderAgent` extends
Cloudflare's `AIChatAgent`; `@cloudflare/codemode` runs project operations in a
sandboxed Dynamic Worker. Preview and published content are served by the app
itself. There is no publisher service, release manifest, copied publish tree,
deployment matrix, or compatibility routing layer.

Publishing sets live project metadata to `published: true`. The single public
shape is `/u/:handle/:slug/*`, where the handle is chosen by the user. Internal
CAIL subjects never appear in public URLs. Editing a published project changes
its public bytes; snapshots, not publish artifacts, provide content recovery.

## Identity and model access

Every product request requires `X-CAIL-Identity-JWT`, verified as RS256 against
the configured JWKS with the exact issuer and scalar audience
`cail:site-studio`. The signed CAIL subject is preserved byte-for-byte as the
owner key. Email, display names, cookies, and caller-supplied identity headers
never select ownership.

When a browser session needs to sign in, Site Studio sends it to the protected
Site Studio page on the standalone CAIL Doorway at
`https://cail-doorway.ailab-452.workers.dev/site-studio/`; Doorway starts CUNY
sign-in and returns the browser to the current Site Studio page.

Model traffic goes directly from the app Worker to the CAIL Gateway through
`@cuny-ai-lab/cail-client` and `@ai-sdk/openai-compatible` at
`{CAIL_API_BASE}/v1`. The app forwards only the separately verified,
subject-bound gateway identity and stamps `X-CAIL-App: site-studio`. Site Studio
has no provider keys and does not impose an output-token or model-step cap.
Billed model POSTs use `maxRetries: 0` because an uncertain automatic retry can
duplicate a paid execution.

## One-time first-login import

Legacy data has one narrow import path. On a user's first successful verified
CAIL login, an old `site-studio-session` cookie may identify an unexpired R2
record at `sessions/:sessionId.json`. That server-owned record—not email or a
caller-supplied owner id—selects the anonymous `user_…` source namespace.

The import re-homes projects, files, snapshots, uploads, agent chat history,
published metadata, and any handle. A per-anonymous-owner Durable Object claim
prevents two subjects from absorbing the same namespace. Conditional writes,
stable imported-project stamps, and the owner mutation coordinator make retries
converge without duplicates. Only after the copy and source retirement finish
does the app write the empty subject-keyed completion object
`imports/:subject` and delete the legacy cookie. If the first login has no
resolvable legacy source, the same empty record closes the import without
guessing a mapping.

An error returns a private retryable 503 and does not write completion or
clear the legacy cookie. A later login retries. Verified identity remains the
sole authentication source; there is no subject session cookie or subject
session KV record. After completion, the new subject store is authoritative:
there is no dual-read, fallback, sync, migration window, bulk job, forwarding
pointer, or legacy public route.

This mechanism can import only a namespace whose legacy R2 session record is
still resolvable. Historical anonymous namespaces without that mapping cannot
be assigned safely; operators must not infer ownership from email, content, or
an arbitrary lookup table.

## Routes

- `GET /api/health`
- `GET|POST /api/projects` and project file/upload/snapshot routes
- `GET /preview/:projectId/*`
- `GET|POST /api/handle`
- `POST /api/projects/:projectId/publish`
- `POST /api/projects/:projectId/unpublish`
- `ALL /api/agents/site-builder/:projectId`
- `GET /u/:handle/:slug/*`

Publishing returns `409 handle_required` until the owner claims a handle.
Slashless public roots redirect to the trailing-slash form so relative assets
resolve beneath the site root. When public ingress mounts the Worker under the
path in `PUBLISHED_BASE_URL`, redirects and styled 404 home links retain that
path; loopback development remains rooted at `/`.

## Local development

Use Bun throughout:

```bash
bun install
bun run dev
```

- Frontend: <http://localhost:5173>
- Worker: <http://localhost:8792>

Useful checks:

```bash
bun run check
bun run --cwd packages/app deploy --dry-run
```

The test suite contains unit, component, and in-process route tests. It is not
labelled E2E. Acceptance of authoring or publishing requires a real browser and
real Worker/resource boundary.

`bun run e2e:live` exercises the standalone production Worker with short-lived
app and Gateway identity JWTs supplied through the environment. It requires an
admitted identity that already owns a public handle, creates one random project,
runs an uncapped paid authoring turn, verifies persisted chat, preview, publish,
and direct public serving (including linked CSS and JavaScript through both the
standalone Worker and configured Doorway), then deletes the project through the
product API and recreates it once to prove its chat history was cleared. It
neither manages Cloudflare storage directly nor changes the identity's handle.
This proves the signed-identity Worker-to-Gateway product path and the
configured public serving path; it is not a CUNY browser login test.

The required environment variables are `SITE_STUDIO_URL` (set to
`https://site-studio-app.ailab-452.workers.dev/site-studio/`),
`SITE_STUDIO_APP_IDENTITY_JWT`, and
`SITE_STUDIO_GATEWAY_IDENTITY_JWT`. The two short-lived JWTs must have the same
subject and their respective production audiences. Keep them in the invoking
process; do not put them in files or command arguments. They must remain valid
through the cleanup requests; a cleanup failure prints the random proof-project
name so the same identity can remove it after obtaining fresh tokens.

`packages/app/.dev.vars` is gitignored. Required deployment configuration is
declared in `packages/app/wrangler.jsonc`, including:

- `CAIL_IDENTITY_JWKS` (secret) and the canonical `CAIL_IDENTITY_ISSUER`
- `CAIL_API_BASE`, `CAIL_MODEL`, `CAIL_IMAGE_MODEL`, and
  `CAIL_IMAGE_CLASSIFIER`
- `PUBLISHED_BASE_URL`
- `CSRF_COOKIE_PATH=/site-studio`
- explicit upload byte/rate policy values
- R2, KV, Worker Loader, and Durable Object bindings

The production frontend build uses `PUBLIC_BASE_PATH=/site-studio`, and the
configured public base is `https://cail-doorway.ailab-452.workers.dev/site-studio`.

## CI and production deploy

Merges to `main` release after the repository checks and a live health check.
Site Studio has no separate checked-in staging Worker; local checks are not a
production preview.

See [docs/security-and-recovery.md](docs/security-and-recovery.md) for the
remaining trust and recovery boundaries.

## License

MIT
