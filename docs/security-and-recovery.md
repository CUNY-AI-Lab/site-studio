# Security and recovery boundaries

This document describes the checked-in runtime contract. It is not evidence of
live routes, bindings, secrets, lifecycle rules, backups, or deployed versions.

## Identity, ownership, and collaboration

Protected requests accept identity only from a verified
`X-CAIL-Identity-JWT`: RS256, required `kid`, configured public JWKS, exact
single deployment issuer, and scalar audience `cail:site-studio`. The
source-owned `CAIL_IDENTITY_PROFILE` maps production and staging to their exact
CAIL issuer constants; the issuer binding must equal that mapping and cannot
authorize a new trust root. Missing or malformed JWKS, profile, or issuer fails
closed; production and staging issuers are never combined. An invalid presented token
is terminal. With `CAIL_REQUIRE_IDENTITY=true`, an absent token is also rejected.

The durable owner key is the JWT subject preserved byte-for-byte. Email and
profile names are display data only. While identity is optional, anonymous sessions use a random
`user_...` owner. Projects, files, snapshots, handles, chat Durable Objects,
mutation coordination, and action-attempt records derive from this owner key.

There is no membership, sharing, invitation, or role model. Collaboration means
multiple tabs or agent connections for one owner. All adopted project/file
mutations and publish-state changes execute through one `MutationCoordinator`
Durable Object keyed by the owner, so those tabs serialize at the storage
boundary. Chat history remains in the project-named `SiteBuilderAgent` object
(`ownerId:projectId`).

## Request and serving defenses

Every unsafe `/api` request passes same-origin posture and the R2-backed
`X-CAIL-CSRF` check. WebSocket upgrades perform the same token and origin checks
before the Agents protocol is accepted. The script-readable CSRF cookie must be
configured as `/site-studio`; token issuance fails when `CSRF_COOKIE_PATH`
differs. Actual loopback development requests receive `Path=/` because the Vite
SPA and Worker proxy are mounted at the local origin root. Non-loopback requests
retain the configured `/site-studio` scope.

The HttpOnly `site-studio-session` cookie still uses `Path=/`. That is correct
for the direct Worker origin but must be resolved before mounting the app beside
other tools at `tools.ailab.gc.cuny.edu/site-studio`: either scope the session
cookie with a deployment-aware path or prove an isolated cookie origin. This is
an activation decision, not something the source can infer safely.

Preview and published user-authored responses use an opaque sandbox origin
(`Content-Security-Policy: sandbox allow-scripts` without
`allow-same-origin`), `nosniff`, and `no-referrer`. `.metadata.json` and
`.thumbnail.png` are excluded from preview and public serving in both Workers.
Preview tokens are random and expire after ten minutes. Each grant authorizes
only the normalized relative paths linked by one rendered HTML document. A
linked child HTML document may mint grants for its own links, but it inherits
the parent grant's absolute expiry. Authored JavaScript can observe a token
appended to its document URLs, so the grant deliberately cannot read arbitrary
unlinked project files. Protocol-relative, root-relative, and explicit-scheme
URLs never receive a bearer. CSS `url(...)` references are not rewritten.

The authenticated chat renderer strips image elements from assistant and
file-derived Markdown, preventing that content from initiating remote or
same-origin image requests. Links remain sanitized by DOMPurify. The application
shell uses local system font stacks and does not contact a third-party font CDN.

## Handles and account import

Handle claims use conditional R2 writes for both directions. A fresh reverse
record without its forward pair is treated as an in-flight claim for two
minutes, so another request cannot reap a live claim. Older orphans can be
reclaimed by conditionally replacing the exact stale R2 generation; there is no
delete window in which a concurrent repair can be erased. Owner-to-handle reads
are not accepted as ownership proof unless the forward record still points to
the same owner. Account import re-homes a handle only with an ETag condition
that proves the forward record still belongs to the anonymous owner; ownership
drift leaves the import pending.

Because the Workers R2 binding has no conditional delete, a repair or ordinary
claim that loses the forward-handle race does not unconditionally delete the
reverse key. It conditionally retires only the exact losing reverse generation
into an immediately repairable orphan marker. A newer healthy replacement
therefore survives the rollback.

Anonymous-to-subject import has a separate `MigrationCoordinator`, keyed by the
anonymous owner, as its claim-once authority. Data copies use conditional
destination writes. A lost condition is accepted only for byte-identical data;
different destination bytes stop before the delete phase, preserving both
namespaces for reconciliation. The temporary import cutoff and recovery steps
are in [legacy-account-import-removal.md](legacy-account-import-removal.md).
If an attempt writes `.migrated.json` and then fails during source deletion, a
retry merges the existing same-subject project and slug maps before rewriting
the pointer; a different-subject pointer aborts the retry.

The permanent `/sites/:owner/:slug/*` compatibility route follows
`.migrated.json` pointers. If migration remapped a colliding slug, its 301 uses
the effective mapped slug in the canonical `/u/:handle/:slug/*` target.

## Model identity and quota

Chat, image generation, and image screening use the CAIL gateway and stable app
slug `site-studio`; the repository has no provider keys. Billed POSTs are never
automatically retried after ambiguous outcomes. Chat, image, and classifier
configuration rejects any model id outside the Cloudflare Workers AI `@cf/...`
catalog namespace.

The browser reconnects before a new turn when its WebSocket is older than four
minutes. The model adapter checks the verified token expiry before every gateway
POST. A turn that outlives its token stops before the next model call, closes the
socket, and requires a retry on the newly authenticated connection.

`GET /api/quota` reads the gateway's typed `GET /quota` snapshot with the
verified JWT, removes the subject, and returns a private no-store response. The
chat panel displays the remaining percentage. Gateway `quota_exceeded` messages
remain user-visible and are not retried. Gateway accounting is authoritative;
Site Studio logs do not duplicate spend facts.

## Upload admission

- Image files: 10 MiB; JPEG, PNG, GIF, and WebP magic bytes must match the
  extension.
- Other accepted files: 32 MiB; PDF, DOCX, text, CSV, Markdown, JSON, HTML,
  CSS, and JavaScript extensions are accepted.
- Multipart bodies declared above 33 MiB are rejected before parsing. Every
  body is then streamed into a capped buffer, so an absent, invalid, or
  understated `Content-Length` cannot bypass the same absolute ceiling.
- Thumbnail PNGs are limited to 2 MiB and dimensions from 1 to 4096 pixels.
- Generated images are rejected before persistence when the gateway declares or
  returns more than 10 MiB of decoded image data. The JSON response is streamed
  into a cap sized for that base64 payload before parsing, including when
  `Content-Length` is absent. Moderation accepts only a recognized image
  signature within that bound and labels the data URI from the detected format.
- Uploads require positive integer values for
  `SITE_STUDIO_MAX_PROJECT_BYTES`, `SITE_STUDIO_MAX_OWNER_BYTES`, and
  `SITE_STUDIO_UPLOADS_PER_MINUTE`. Missing policy fails with 503. Byte usage
  and the rolling one-minute admission count are checked in the same serialized
  coordinator operation as the conditional file write. The durable rate
  admission is recorded before R2 mutation, so a storage failure cannot leave a
  committed upload uncounted; an ambiguous external failure may conservatively
  consume one attempt. Collision-suffix retries reuse one admission id and count
  as one user-visible upload rather than one attempt per candidate filename.

PDF extraction still reads the project object and parses it in the agent Worker.
There is no page-count/parser-work quota beyond upload and platform limits.
Text-editor request bodies use the platform request ceiling.

## Mutation consistency and recovery

`MutationCoordinator` is a SQLite Durable Object added by Wrangler migration
`v3`. Every route and agent operation that creates, renames, deletes, writes,
uploads, snapshots, restores, replaces project files, publishes, or unpublishes calls it by
`idFromName("owner:" + ownerId)`. A missing binding fails closed.

The object admits operations through a per-instance promise queue. It does not
hold `blockConcurrencyWhile()` across external R2, KV, or Durable Object RPC
work, avoiding that initialization gate's reset timeout while preserving
owner-local admission order. Create and rename compensation becomes eligible
only after a conditional destination claim proves that operation owns the
namespace; other destructive transitions record intent before deletion or
replacement. The recovery journal covers:

- project creation records intent before its conditional metadata claim, marks
  the claimed generation with the journal operation id, and remains hidden
  until every initial file lands; recovery deletes only the matching partial
  generation;
- project and file rename records distinguish copy/preparation from committed
  source deletion; published project rename copies into an unpublished target,
  durably enters activation after the copy completes, transfers its slug
  reservation, hides the source, and rolls activation forward on recovery;
- delete is repeatable; published metadata is hidden before file deletion and
  project metadata is deleted last;
- restore and template replacement require a safety snapshot and restore it
  after an interrupted or failed transition.

The journal is recovered before the next owner mutation. Conditional R2 writes
still protect individual metadata, file, slug, handle, and migration claims.
This creates an atomic application boundary for adopted mutations, not an R2
multi-object transaction and not protection against out-of-band bucket writes.

Snapshots retain the newest 50 entries and skip creation above 50 MiB. Manual
snapshot requests report the skip. A destructive restore or whole-template
replacement fails closed when its safety snapshot cannot be created. Ordinary
agent text mutations may still proceed when their optional turn snapshot is too
large; the skip is logged and no automatic restore point exists for that edit.

Chat-history move/clear after project rename/delete remains best-effort and is
not part of the R2 mutation journal. Operators should inspect the project agent
history if a storage operation succeeds while that diagnostic event reports a
history failure.

## Autosave and local recovery

Editor saves carry the loaded ETag. A conflict remains a failed queued save and
does not replace the local buffer with remote content. Every queued edit is also
AES-GCM encrypted under the path-scoped, per-owner CSRF token before entering
origin-wide browser storage. The ciphertext carries its base ETag and prevents
a later signed-in owner without the prior token from reading the draft. It is
not a security boundary against XSS or a hostile same-origin sibling, which can
operate the Site Studio origin directly. Only an acknowledged save of the same content clears the draft;
newer queued content is rebased to the acknowledged ETag. Reopening a file
restores an unsaved draft without silently adopting a newer server ETag.

The `beforeunload` keepalive remains best effort. Local draft persistence is the
recovery boundary when the browser cannot acknowledge that request. The editor
does not yet offer an automatic three-way merge; users must reconcile a
conflicted draft deliberately.

## Publishing and rollback

Publishing reserves a per-owner slug and sets project metadata to
`published: true`. Public reads resolve the current project objects. There is no
immutable release generation, copied publish directory, atomic manifest, or
publish-specific rollback. Edits and restores change a published site's bytes
without another publish action.

Unpublish keeps the slug in metadata but removes public visibility. Its
reservation can be reclaimed by another project under the same owner after the
one-minute in-flight-claim window; project deletion has the same reuse behavior.
A project rename transfers a live reservation to the new project id.
Slashless canonical and directly served legacy roots redirect permanently to
their trailing-slash form before HTML is served, preserving relative asset
resolution.

All published HTML and assets return `public, max-age=0, must-revalidate` plus
ETag and Last-Modified validators. Same-path replacements therefore revalidate;
unpublish still cannot revoke a response a browser already downloaded.

Snapshots are the only repository-provided content rollback. External R2
backup/versioning, disaster-recovery exercises, and deployment rollback remain
operator activation work; this repository neither configures nor proves them.
