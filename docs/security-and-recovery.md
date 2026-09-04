# Security and recovery boundaries

This document describes checked-in behavior, not proof of live routes,
bindings, secrets, backups, or deployed versions.

## Identity and ownership

Product routes accept only a verified `X-CAIL-Identity-JWT`: RS256, required
`kid`, configured public JWKS, one exact deployment issuer, and scalar audience
`cail:site-studio`. Missing or invalid identity returns the exact nested CAIL
`authentication_required` envelope (`code`, `message`, and the fixed
`/launch/site-studio` path). The JWT subject is the durable owner key;
email and profile names are display data only. The legacy session cookie is an
import source only, never authentication or ownership proof. The app does not
issue or consult a subject session cookie or subject session KV record.
The browser handles that envelope by sending the user to the fixed Doorway
launch at `https://tools.ailab.gc.cuny.edu/launch/site-studio`; it never turns a
response-provided URL or current-page query into a redirect target.

The CAIL Gateway credential is a separate verified JWT with gateway audience,
bound to the same subject. The Worker removes caller authority and routing
headers before forwarding the verified gateway identity and `X-CAIL-App: site-studio`. The
repository contains no model-provider keys. Before each new or continued model
turn, the CSRF-protected refresh route verifies the app and Gateway legs and
replaces the existing owner/project socket's connection-local credential. It
returns an empty `Cache-Control: no-store` response; the browser never receives
the Gateway JWT.

There is no membership, invitation, role, or cross-owner collaboration model.
A `SiteBuilderAgent` is keyed by `ownerId:projectId`. An owner-keyed
`MutationCoordinator` serializes project/file mutations from that owner's tabs
and agent connections.

`read_url` uses the host Worker's public fetch without app cookies, Gateway
credentials, or a private-network binding. Each redirect is validated before
following it; Cloudflare's network proxy supplies the public/internal
destination boundary. Extracted text and links are untrusted source material.
The Code Mode sandbox still has no outbound network access. `inspect_image`
reads only the authenticated project's storage, checks image bytes and size,
and sends them through the existing Gateway vision-model path.

## One-time legacy import

The only compatibility behavior is a lazy import during a user's first
verified login. The presented old cookie must resolve to an unexpired R2 legacy
session record whose server-stored user id has the anonymous `user_…` shape.
Caller input and email cannot name an import source.

A `MigrationCoordinator` keyed by the anonymous owner grants that namespace to
at most one subject. Before claiming it, the subject's mutation coordinator
durably reserves the selected cookie before resolving its R2 session.
Concurrent first-login requests and
retries cannot replace that reservation with another cookie or close it with
no cookie. The copy runs on the distinct anonymous-owner coordinator, avoiding
re-entry into the subject queue. Already-completed imports read their immutable
R2 marker without a coordinator round trip.
The owner mutation coordinator copies project files and
metadata, snapshots, uploads, chat history, published state, and handle
relationships. Destination writes are conditional; imported metadata stamps a
stable source owner and original project id so interrupted sweeps reuse the same
destination instead of creating another suffix. Source deletion happens only
after copying and chat transfer have succeeded.

Chat transfer uses persistence-only SDK storage and broadcasts; it does not
start an AI response. The subject's pending mutation journal is recovered
before first-login import writes into that namespace.

Resumable legacy metadata migration drops any obsolete stored `publishedUrl`;
public links are derived from the configured `PUBLISHED_BASE_URL`.

The app records the empty marker `imports/:subject` only after a successful
import, or after the first verified login establishes that no resolvable source
exists. A failure returns a
private 503, leaves completion absent, and preserves a source cookie or pending
resume marker for the next login. Successful import retires the legacy session
and clears its cookie; the subject store then becomes the sole read and write
authority. Verified identity is the sole authentication source. There is no
time window, dual-read, forwarding pointer, compatibility API, background job,
or legacy `/sites` route.

R2 cannot reveal which verified subject owns an anonymous namespace when its
legacy session mapping is gone. Such data must remain untouched unless an
independent authoritative identity mapping is recovered.

## Browser and serving defenses

Unsafe API requests require same-origin posture plus the R2-backed
`X-CSRF-Token` value. WebSocket upgrades pass the same token and origin checks.
The script-readable CSRF cookie is scoped to `/site-studio` outside loopback;
the HttpOnly legacy import cookie is Secure and SameSite=Strict until the app
deletes it after import closes. No subject continuity cookie is minted.

Preview and published responses use an opaque sandbox origin
(`Content-Security-Policy: sandbox allow-scripts` without
`allow-same-origin`), `nosniff`, and `no-referrer`. System objects are never
served. Successfully resolved authored JavaScript and font responses allow
wildcard, uncredentialed CORS so module graphs and fonts can load from that
opaque origin; missing responses and other authored resource types do not
receive that header. Preview grants remain the read boundary: they are random,
short-lived, project-bound, and limited to normalized resources linked by the
rendered document. Resolved preview HTML reports its navigation token after the
child load completes, so a browser-generated error document cannot clear the
preview failure state. Chat Markdown strips images and sanitizes links.

The frontend keeps one preview iframe and accepts readiness only from the
active child with the matching navigation token. It turns failed or stalled
navigations into the same retryable state. Browser downloads use a temporary
Blob URL whose revocation is deliberately delayed until after the download
navigation can commit.

Stop resets the whole agent turn, not only the current response id. The client
and agent retain cancellation identity long enough to reject late stream frames
and successor continuations. Project switches retire the old client chat
instance. Fetch/model operations receive the active abort signal, and tools
check it before starting further mutations. A mutation already dispatched to
the owner coordinator can complete; cancellation does not undo stored data.
Unexpected socket loss reconnects with bounded
backoff while the project is mounted; a reconnect refreshes the CSRF token once
per cycle and may resume only the same subject's owned request. Successful
persisted turns emit a targeted commit frame. That frame or an authenticated
history read repairs the visible transcript, while project epochs and request
generations prevent stale reads and frames from overwriting newer work. A
history load failure is shown as a retryable loading problem rather than an
empty conversation.

## Storage admission and mutation recovery

Uploads validate the file name, supported format, image signature, and
application per-file size limit before writing. Request-body bounds protect
Worker memory before form parsing. The existing owner coordinator serializes
uploads with other project mutations, and conditional R2 writes prevent
filename collisions from overwriting content. File bodies cross its RPC
boundary as native streams; a 32 MiB file is not packed into a 32 MiB-limited
serialized RPC envelope. Thumbnail uploads also check
PNG dimensions. None of these checks invokes a model.

There is no account/project storage quota or upload-rate ledger. The retired
upload-only policy did not account for other ways to grow project storage.
Existing unused admission records can remain untouched; removing that policy
requires no data migration or deletion. Gateway model quotas are unchanged.

Multi-object R2 operations are not transactions. The mutation coordinator
records recovery intent for create, rename, delete, restore, and template
replacement. Conditional claims identify the generation an operation owns.
Rename intent is durable before the destination claim; an incomplete target
carries its operation marker until activation. Recovery never deletes a target
based only on its existence or matching bytes.
Recovery runs before the next owner mutation and either finishes a committed
transition or removes only that operation's partial destination. Out-of-band R2
writes remain outside this contract.

Snapshot archives are written before their metadata so incomplete snapshots
are not listed as restorable. Serialized retention also removes orphan archives
only when their paired metadata object is absent; malformed but present
metadata is preserved with its archive for recovery.

Editor writes carry the loaded ETag. Conflicts preserve the local draft instead
of overwriting remote content. Drafts are encrypted with the per-owner CSRF
token before origin-wide browser storage and clear only after the exact content
is acknowledged. This protects against another later owner reading a leftover
draft, not against XSS.

Generic file writes, including owner-coordinated CAS writes and model edits,
reject protected system filenames. A current metadata ETag does not authorize
rewriting metadata through a file tool; dedicated metadata operations own those
changes.

Project downloads compress R2 body streams as the response is consumed. They
retain the current input chunk and ZIP directory information rather than all
project bytes. Cancelling the response cancels the active R2 reader and stops
opening further files. Snapshot creation remains separately size-bounded.

The version-history dialog owns create and restore as single-flight operations.
It takes ownership before awaiting an editor-save flush, blocks another history
mutation until the first settles, and ignores snapshot-list responses that no
longer belong to the active load.

## Publishing and rollback

Publishing reserves an owner-local slug and makes current project objects
public at `/u/:handle/:slug/*`. The durable public identity is the verified
handle mapping plus project slug; project metadata does not treat a full host
URL as authoritative. API links are derived from the current
`PUBLISHED_BASE_URL`, so
moving the public mount does not require rewriting or republishing records.
DNS and redirects from an old mount are deployment responsibilities. There is
no release generation, copied publish directory, manifest, publisher Worker,
or publish-specific rollback. Edits and restores immediately change a
published site's bytes.

Published responses revalidate mutable paths with ETag and Last-Modified.
Unpublish removes visibility but cannot revoke bytes already downloaded.
Project snapshots are the product's content rollback. R2 backup/versioning,
disaster recovery, and deployment rollback are operator responsibilities.
