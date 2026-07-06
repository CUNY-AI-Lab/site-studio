/**
 * First-login migration of anonymous-session data into the CAIL-subject
 * namespace.
 *
 * Scenario: a user worked anonymously (pre-SSO window) under a `user_…` id —
 * projects, snapshots, uploads, and `${userId}:${projectId}` agent instances
 * all key off that id. When SSO turns on and they authenticate, ownership
 * moves to the CAIL subject. This module re-homes the data by COPY (the
 * subject becomes the durable owner key, keeping the backbone invariant
 * "key workspaces by X-CAIL-Subject"), rather than keeping a permanent
 * anonymous-id alias in every owner-key derivation.
 *
 * Guarantees:
 * - **One-time / idempotent**: a durable KV claim record (`migration:<anonId>`)
 *   marks pending/complete. Every step is individually idempotent
 *   (copy-if-absent, deterministic renames), so concurrent or resumed runs
 *   converge on the same end state.
 * - **Claim-once**: the first verified subject to claim an anonymous
 *   namespace wins, recorded durably; other subjects are refused.
 * - **Non-destructive merge**: nothing the subject already owns is
 *   overwritten. On project-id collision the incoming project is renamed
 *   deterministically (`<id>-imported`, `<id>-imported-2`, …); migrated
 *   metadata is stamped `importedFrom`/`importedOriginalId` so retries and
 *   concurrent runs recognize our own copies instead of re-suffixing.
 * - **Published-site continuity**: published sites serve live from
 *   `projects/{userId}/…` and the public URL embeds the anonymous id. After
 *   copying, a permanent forwarding pointer (`projects/<anonId>/.migrated.json`)
 *   is written BEFORE originals are deleted; both published-site servers
 *   (app worker `/sites/*` route and the publisher worker) fall back to it,
 *   so old URLs keep serving — the originals during the copy window, the
 *   subject's live copy afterwards.
 * - **No identity, no change**: this only runs from the verified-identity
 *   branch of the auth middleware. The pure anonymous flow is untouched.
 */

import type { ProjectMetadata, ProjectSnapshot } from "../types";
import { getUserHandle, migrateHandle } from "./handles";

export interface MigrationClaim {
  subject: string;
  status: "pending" | "complete";
  startedAt: string;
  completedAt?: string;
}

/**
 * Permanent forwarding pointer left in the anonymous namespace so published
 * URLs that embed the anonymous id keep resolving after the data moves.
 */
export interface MigrationPointer {
  version: 1;
  subject: string;
  migratedAt: string;
  /** old anonymous projectId -> projectId in the subject namespace */
  projects: Record<string, string>;
  /** old published slug (or slug-less projectId) -> slug in the subject namespace */
  slugs: Record<string, string>;
}

/** Ports Durable Object chat history between agent instances (best-effort). */
export interface ChatHistoryPorter {
  port(
    fromOwner: string,
    fromProjectId: string,
    toOwner: string,
    toProjectId: string
  ): Promise<void>;
}

export type MigrationStatus =
  | "migrated"
  | "already-complete"
  | "refused"
  | "nothing-to-migrate";

export interface MigrationResult {
  status: MigrationStatus;
  /** old projectId -> new projectId (empty unless status === "migrated") */
  projects: Record<string, string>;
}

export function migrationClaimKey(anonUserId: string): string {
  return `migration:${anonUserId}`;
}

/**
 * Subject-keyed resume marker. Written at claim time and cleared on
 * completion, so a later authenticated request can resume a partial migration
 * even after the anonymous cookie has been replaced by the subject cookie.
 */
export function migrationPendingKey(subject: string): string {
  return `migration-pending:${subject}`;
}

export function migrationPointerKey(anonUserId: string): string {
  return `projects/${anonUserId}/.migrated.json`;
}

function projectPrefix(userId: string): string {
  return `projects/${userId}/`;
}

function snapshotUserPrefix(userId: string): string {
  return `snapshots/${userId}/`;
}

function uploadsPrefix(userId: string): string {
  return `uploads/${userId}/`;
}

function isAnonymousUserId(id: string): boolean {
  return id.startsWith("user_");
}

/**
 * Rewrite a stored published URL to the canonical /u/{handle}/{slug}/ form,
 * preserving the origin. Handles both the legacy /sites/{owner}/{slug}/ shape
 * and an already-/u/ shape, so this is safe to run on any stored URL.
 */
function rewritePublishedUrl(publishedUrl: string, handle: string, slug: string): string {
  return publishedUrl.replace(/\/(?:sites|u)\/[^/]+\/[^/]+/, `/u/${handle}/${slug}`);
}

async function listKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    for (const object of listed.objects) {
      keys.push(object.key);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return keys;
}

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  try {
    return JSON.parse(await object.text()) as T;
  } catch {
    return null;
  }
}

async function putJson(bucket: R2Bucket, key: string, value: unknown): Promise<void> {
  await bucket.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json" }
  });
}

/** Copy a single object without ever overwriting an existing destination. */
async function copyIfAbsent(bucket: R2Bucket, fromKey: string, toKey: string): Promise<void> {
  if (await bucket.head(toKey)) return; // non-destructive: never overwrite
  const object = await bucket.get(fromKey);
  if (!object) return; // source vanished (concurrent run finished it) — fine
  await bucket.put(toKey, await object.arrayBuffer(), {
    httpMetadata: object.httpMetadata
  });
}

/** Distinct project ids under a user namespace (dotfiles like the pointer excluded). */
async function listProjectIds(bucket: R2Bucket, userId: string): Promise<string[]> {
  const prefix = projectPrefix(userId);
  const ids = new Set<string>();
  for (const key of await listKeys(bucket, prefix)) {
    const [id] = key.slice(prefix.length).split("/");
    if (id && !id.startsWith(".")) {
      ids.add(id);
    }
  }
  return [...ids].sort();
}

async function getMetadata(
  bucket: R2Bucket,
  userId: string,
  projectId: string
): Promise<ProjectMetadata | null> {
  return readJson<ProjectMetadata>(bucket, `${projectPrefix(userId)}${projectId}/.metadata.json`);
}

async function subjectProjectOccupied(
  bucket: R2Bucket,
  subject: string,
  projectId: string
): Promise<boolean> {
  const listed = await bucket.list({
    prefix: `${projectPrefix(subject)}${projectId}/`,
    limit: 1
  });
  return listed.objects.length > 0;
}

/**
 * Decide the destination project id for an incoming anonymous project.
 * Deterministic and retry/concurrency-safe: a subject project stamped as our
 * own copy (importedFrom === anonUserId, importedOriginalId === originalId)
 * maps back to itself instead of being treated as a collision.
 */
async function resolveTargetProjectId(
  bucket: R2Bucket,
  subject: string,
  anonUserId: string,
  originalId: string,
  taken: Set<string>
): Promise<string> {
  const candidates = [originalId, `${originalId}-imported`];
  for (let n = 2; candidates.length < 50; n++) {
    candidates.push(`${originalId}-imported-${n}`);
  }

  for (const candidate of candidates) {
    if (taken.has(candidate)) continue;
    if (!(await subjectProjectOccupied(bucket, subject, candidate))) {
      return candidate;
    }
    const meta = await getMetadata(bucket, subject, candidate);
    if (meta?.importedFrom === anonUserId && meta.importedOriginalId === originalId) {
      return candidate; // our own copy from a previous/concurrent run
    }
    // Occupied by something that isn't our copy — collision, try next suffix.
  }
  throw new Error(`Could not find a free project id for ${originalId}`);
}

/**
 * Published slugs already used in the subject namespace, excluding our own
 * copies of this anonymous project (so retries do not re-suffix).
 */
async function usedSubjectSlugs(
  bucket: R2Bucket,
  subject: string,
  anonUserId: string,
  originalId: string
): Promise<Set<string>> {
  const slugs = new Set<string>();
  for (const projectId of await listProjectIds(bucket, subject)) {
    const meta = await getMetadata(bucket, subject, projectId);
    if (!meta?.published) continue;
    if (meta.importedFrom === anonUserId && meta.importedOriginalId === originalId) continue;
    slugs.add(meta.slug || projectId);
  }
  return slugs;
}

function suffixSlug(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Migrate one anonymous user's data into the subject namespace. Safe to call
 * repeatedly and concurrently; see the module doc for the guarantees.
 */
export async function migrateAnonymousData(options: {
  bucket: R2Bucket;
  kv: KVNamespace;
  anonUserId: string;
  subject: string;
  /** The anonymous KV session id (cookie value), deleted on completion. */
  anonSessionId?: string;
  /** Best-effort Durable Object chat-history porter; failures never abort. */
  porter?: ChatHistoryPorter;
  now?: () => string;
}): Promise<MigrationResult> {
  const { bucket, kv, anonUserId, subject, anonSessionId, porter } = options;
  const now = options.now ?? (() => new Date().toISOString());

  if (!isAnonymousUserId(anonUserId) || anonUserId === subject) {
    return { status: "refused", projects: {} };
  }

  // ---- Claim (one anonymous namespace belongs to exactly one subject) ----
  const claimKey = migrationClaimKey(anonUserId);
  // FAIL LOUD (rule 5): this read is the security-critical claim-once gate. A
  // swallowed KV outage here would read as "no existing claim" and let a SECOND
  // subject migrate into an anonymous namespace already owned by another — the
  // exact cross-subject takeover the claim guards against. So a KV failure must
  // abort the migration (the caller's auth flow decides), never be treated as
  // an absent claim. (Contrast the best-effort cleanup deletes below, which are
  // safe to swallow.)
  const existingClaim = await kv.get<MigrationClaim>(claimKey, "json");
  if (existingClaim && existingClaim.subject !== subject) {
    // First verified claim wins; never migrate into a second subject.
    return { status: "refused", projects: {} };
  }
  if (existingClaim?.status === "complete") {
    // Safe to swallow: clearing the resume marker is best-effort cleanup. A
    // leftover marker only triggers a harmless no-op resume on the next login.
    await kv.delete(migrationPendingKey(subject)).catch(() => undefined);
    return { status: "already-complete", projects: {} };
  }

  const claim: MigrationClaim = existingClaim ?? {
    subject,
    status: "pending",
    startedAt: now()
  };
  await kv.put(claimKey, JSON.stringify(claim));
  await kv.put(migrationPendingKey(subject), anonUserId);

  const finish = async (status: MigrationStatus, projects: Record<string, string>) => {
    if (anonSessionId) {
      // Safe to swallow: deleting the spent anon session is best-effort; if it
      // fails it simply expires on its own TTL. Not on the security path.
      await kv.delete(`session:${anonSessionId}`).catch(() => undefined);
    }
    await kv.put(
      claimKey,
      JSON.stringify({ ...claim, status: "complete", completedAt: now() } satisfies MigrationClaim)
    );
    // Safe to swallow: best-effort resume-marker cleanup (see above).
    await kv.delete(migrationPendingKey(subject)).catch(() => undefined);
    return { status, projects } as MigrationResult;
  };

  // ---- Handle re-homing (before inventory so published URLs can use it) ----
  // Move the anon user's public handle to the subject: the handle record is
  // always re-pointed (so shared /u/{handle}/ links keep resolving), and the
  // reverse record is promoted only when the subject has no handle of its own.
  // Idempotent and non-destructive, matching this module's ordering.
  await migrateHandle({ bucket, anonUserId, subject, now });
  const subjectHandle = await getUserHandle(bucket, subject);

  // ---- Inventory ----
  const anonProjectIds = await listProjectIds(bucket, anonUserId);
  const uploadKeys = await listKeys(bucket, uploadsPrefix(anonUserId));

  if (anonProjectIds.length === 0 && uploadKeys.length === 0) {
    return finish("nothing-to-migrate", {});
  }

  // ---- Plan: destination ids and published slugs ----
  const projectMap: Record<string, string> = {};
  const slugMap: Record<string, string> = {};
  const taken = new Set<string>();
  const plans: Array<{
    oldId: string;
    newId: string;
    metadata: ProjectMetadata | null;
    newSlug?: string;
  }> = [];

  for (const oldId of anonProjectIds) {
    const newId = await resolveTargetProjectId(bucket, subject, anonUserId, oldId, taken);
    taken.add(newId);
    projectMap[oldId] = newId;

    const metadata = await getMetadata(bucket, anonUserId, oldId);
    let newSlug: string | undefined;
    if (metadata?.published) {
      const oldSlug = metadata.slug || oldId;
      const used = await usedSubjectSlugs(bucket, subject, anonUserId, oldId);
      newSlug = suffixSlug(metadata.slug ? oldSlug : newId, used);
      slugMap[oldSlug] = newSlug;
    }
    plans.push({ oldId, newId, metadata, newSlug });
  }

  // ---- Copy projects (metadata rewritten; every object copy-if-absent) ----
  for (const plan of plans) {
    const fromPrefix = `${projectPrefix(anonUserId)}${plan.oldId}/`;
    const toPrefix = `${projectPrefix(subject)}${plan.newId}/`;

    // Metadata first, so concurrent/resumed runs can recognize our copy.
    if (plan.metadata) {
      const rewritten: ProjectMetadata = {
        ...plan.metadata,
        id: plan.newId,
        importedFrom: anonUserId,
        importedOriginalId: plan.oldId,
        ...(plan.newSlug ? { slug: plan.newSlug } : {}),
        ...(plan.metadata.publishedUrl && plan.newSlug
          ? {
              // Never let the subject id into a client-visible URL. When the
              // subject has a handle, rewrite to the canonical /u/{handle}/
              // form; otherwise drop the stored URL (it will be regenerated on
              // the next publish once a handle exists).
              ...(subjectHandle
                ? {
                    publishedUrl: rewritePublishedUrl(
                      plan.metadata.publishedUrl,
                      subjectHandle,
                      plan.newSlug
                    )
                  }
                : { publishedUrl: undefined })
            }
          : {})
      };
      if (!(await bucket.head(`${toPrefix}.metadata.json`))) {
        await putJson(bucket, `${toPrefix}.metadata.json`, rewritten);
      }
    }

    for (const key of await listKeys(bucket, fromPrefix)) {
      const relative = key.slice(fromPrefix.length);
      if (relative === ".metadata.json") continue; // handled above
      await copyIfAbsent(bucket, key, `${toPrefix}${relative}`);
    }

    // Snapshots: archives copied verbatim, snapshot records re-pointed.
    const fromSnapshots = `${snapshotUserPrefix(anonUserId)}${plan.oldId}/`;
    const toSnapshots = `${snapshotUserPrefix(subject)}${plan.newId}/`;
    for (const key of await listKeys(bucket, fromSnapshots)) {
      const relative = key.slice(fromSnapshots.length);
      const toKey = `${toSnapshots}${relative}`;
      if (key.endsWith(".json")) {
        if (!(await bucket.head(toKey))) {
          const record = await readJson<ProjectSnapshot>(bucket, key);
          if (record) {
            await putJson(bucket, toKey, { ...record, projectId: plan.newId });
          }
        }
      } else {
        await copyIfAbsent(bucket, key, toKey);
      }
    }

    // Agent chat history (Durable Object SQLite) — best-effort, never fatal.
    if (porter) {
      try {
        await porter.port(anonUserId, plan.oldId, subject, plan.newId);
      } catch (error) {
        console.warn(
          `Chat-history migration failed for ${anonUserId}:${plan.oldId} -> ${subject}:${plan.newId}`,
          error
        );
      }
    }
  }

  // ---- Uploads ----
  for (const key of await listKeys(bucket, uploadsPrefix(anonUserId))) {
    const relative = key.slice(uploadsPrefix(anonUserId).length);
    await copyIfAbsent(bucket, key, `${uploadsPrefix(subject)}${relative}`);
  }

  // ---- Forwarding pointer BEFORE deleting originals (URL continuity) ----
  const pointer: MigrationPointer = {
    version: 1,
    subject,
    migratedAt: now(),
    projects: projectMap,
    slugs: slugMap
  };
  await putJson(bucket, migrationPointerKey(anonUserId), pointer);

  // ---- Delete originals (the pointer object stays forever) ----
  const pointerKey = migrationPointerKey(anonUserId);
  for (const key of await listKeys(bucket, projectPrefix(anonUserId))) {
    if (key === pointerKey) continue;
    await bucket.delete(key);
  }
  for (const key of await listKeys(bucket, snapshotUserPrefix(anonUserId))) {
    await bucket.delete(key);
  }
  for (const key of await listKeys(bucket, uploadsPrefix(anonUserId))) {
    await bucket.delete(key);
  }

  return finish("migrated", projectMap);
}

/**
 * Load the forwarding pointer for a user namespace, if that namespace was
 * migrated. Used by the published-site servers as a fallback when normal
 * slug resolution finds nothing under the (old, anonymous) owner id.
 */
export async function loadMigrationPointer(
  bucket: R2Bucket,
  userId: string
): Promise<MigrationPointer | null> {
  const pointer = await readJson<MigrationPointer>(bucket, migrationPointerKey(userId));
  // SS-27: reject an empty subject as well as a missing/non-string one. An empty
  // subject cannot own a namespace, and the publisher worker's copy of this
  // guard already rejected it — accepting `subject:""` here would follow a
  // pointer to `projects//…`, diverging from the publisher.
  if (!pointer || pointer.version !== 1 || typeof pointer.subject !== "string" || !pointer.subject) {
    return null;
  }
  return pointer;
}
