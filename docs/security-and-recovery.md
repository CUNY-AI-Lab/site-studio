# Security and recovery boundaries

This document describes checked-in behavior, not proof of live routes,
bindings, secrets, backups, or deployed versions.

## Identity and ownership

Product routes accept only a verified `X-CAIL-Identity-JWT`: RS256, required
`kid`, configured public JWKS, one exact deployment issuer, and scalar audience
`cail:site-studio`. Missing or invalid identity returns the CAIL
`authentication_required` envelope. The JWT subject is the durable owner key;
email and profile names are display data only. A session cookie is a browser
continuity affordance, never authentication or ownership proof.

The CAIL Gateway credential is a separate verified JWT with gateway audience,
bound to the same subject. The Worker removes caller authority and routing
headers before forwarding that bearer and `X-CAIL-App: site-studio`. The
repository contains no model-provider keys.

There is no membership, invitation, role, or cross-owner collaboration model.
A `SiteBuilderAgent` is keyed by `ownerId:projectId`. An owner-keyed
`MutationCoordinator` serializes project/file mutations from that owner's tabs
and agent connections.

## One-time legacy import

The only compatibility behavior is a lazy import during a user's first
verified login. The presented old cookie must resolve to an unexpired R2 legacy
session record whose server-stored user id has the anonymous `user_…` shape.
Caller input and email cannot name an import source.

A `MigrationCoordinator` keyed by the anonymous owner grants that namespace to
at most one subject. The owner mutation coordinator copies project files and
metadata, snapshots, uploads, chat history, published state, and handle
relationships. Destination writes are conditional; imported metadata stamps a
stable source owner and original project id so interrupted sweeps reuse the same
destination instead of creating another suffix. Source deletion happens only
after copying and chat transfer have succeeded.

The app records the empty marker `imports/:subject` only after a successful
import, or after the first verified login establishes that no resolvable source
exists. A failure returns a
private 503, leaves completion absent, and preserves a source cookie or pending
resume marker for the next login. Successful import retires the legacy session;
the subject store then becomes the sole read and write authority. There is no
time window, dual-read, forwarding pointer, compatibility API, background job,
or legacy `/sites` route.

R2 cannot reveal which verified subject owns an anonymous namespace when its
legacy session mapping is gone. Such data must remain untouched unless an
independent authoritative identity mapping is recovered.

## Browser and serving defenses

Unsafe API requests require same-origin posture plus the R2-backed
`X-CAIL-CSRF` value. WebSocket upgrades pass the same token and origin checks.
The script-readable CSRF cookie is scoped to `/site-studio` outside loopback;
the HttpOnly identity-continuity cookie is Secure and SameSite=Strict.

Preview and published responses use an opaque sandbox origin
(`Content-Security-Policy: sandbox allow-scripts` without
`allow-same-origin`), `nosniff`, and `no-referrer`. System objects are never
served. Preview grants are random, short-lived, project-bound, and limited to
normalized resources linked by the rendered document. Chat Markdown strips
images and sanitizes links.

## Storage admission and mutation recovery

Uploads enforce content signatures, per-file platform limits, and configured
owner/project byte and rate policy inside the owner coordinator. Missing policy
fails closed. These are storage and safety boundaries, not model-output caps.

Multi-object R2 operations are not transactions. The mutation coordinator
records recovery intent for create, rename, delete, restore, and template
replacement. Conditional claims identify the generation an operation owns.
Recovery runs before the next owner mutation and either finishes a committed
transition or removes only that operation's partial destination. Out-of-band R2
writes remain outside this contract.

Editor writes carry the loaded ETag. Conflicts preserve the local draft instead
of overwriting remote content. Drafts are encrypted with the per-owner CSRF
token before origin-wide browser storage and clear only after the exact content
is acknowledged. This protects against another later owner reading a leftover
draft, not against XSS.

## Publishing and rollback

Publishing reserves an owner-local slug and makes current project objects
public at `/u/:handle/:slug/*`. There is no release generation, copied publish
directory, manifest, publisher Worker, or publish-specific rollback. Edits and
restores immediately change a published site's bytes.

Published responses revalidate mutable paths with ETag and Last-Modified.
Unpublish removes visibility but cannot revoke bytes already downloaded.
Project snapshots are the product's content rollback. R2 backup/versioning,
disaster recovery, and deployment rollback are operator responsibilities.
