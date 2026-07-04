/**
 * User-chosen public handles.
 *
 * A handle is the human-readable segment in a published-site URL:
 * `/u/{handle}/{slug}/`. It replaces the old `/sites/{ownerId}/{slug}/` shape,
 * whose owner id leaked the internal CAIL subject into every public URL.
 *
 * Backbone contract (do not weaken):
 * - A handle is **user-chosen only**. It is NEVER derived from the CAIL subject
 *   id or the email — no hashing, no truncation. The two-way mapping between a
 *   handle and its owning subject stays server-side; no API response and no URL
 *   ever exposes the subject.
 * - Validation is conservative because handles may later promote to a
 *   cross-tool namespace: lowercase `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`, no
 *   consecutive hyphens, length 3–32, plus a reserved list.
 * - Claim-once and immutable in v1 (no rename). The first session to claim a
 *   handle owns it; a subject may hold at most one handle.
 *
 * Storage (R2, readable by BOTH the app worker and the publisher worker, which
 * has no KV — so the mapping lives in the bucket, not KV):
 *   - `handles/{handle}.json`      -> { ownerId, claimedAt }  (handle -> owner)
 *   - `userhandles/{ownerId}.json` -> { handle, claimedAt }   (owner -> handle)
 *
 * The claim flow mirrors lib/migration.ts's claim-once idiom: read-then-write
 * with a best-effort re-read to detect a racing claimant. R2 has no
 * compare-and-set, so a very narrow race window (two brand-new handles claimed
 * in the same instant) is possible; at this scale that is acceptable, and the
 * re-read makes the loser fail rather than silently share.
 */

export interface HandleRecord {
  /** Durable owner key (CAIL subject or anonymous `user_…` id). */
  ownerId: string;
  claimedAt: string;
}

export interface UserHandleRecord {
  handle: string;
  claimedAt: string;
}

export const HANDLE_MIN_LENGTH = 3;
export const HANDLE_MAX_LENGTH = 32;

/** Shape: lowercase alphanumerics and hyphens, no leading/trailing hyphen. */
const HANDLE_SHAPE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Reserved handles. Kept broad on purpose: route prefixes (`u`, `api`, `sites`,
 * `preview`), institution words (`cuny`, `gc`, `cail`), and role/impersonation
 * words (`admin`, `official`, `staff`, `root`, `system`) that a public handle
 * must never be allowed to squat.
 */
export const RESERVED_HANDLES = new Set<string>([
  "admin",
  "api",
  "app",
  "assets",
  "blog",
  "cail",
  "cuny",
  "dashboard",
  "docs",
  "edit",
  "editor",
  "files",
  "gc",
  "help",
  "login",
  "logout",
  "mail",
  "official",
  "preview",
  "root",
  "sites",
  "static",
  "support",
  "staff",
  "system",
  "test",
  "tools",
  "u",
  "user",
  "users",
  "www"
]);

export type HandleValidation =
  | { valid: true; handle: string }
  | { valid: false; reason: string };

/**
 * Validate a candidate handle against the conservative rule set. Returns the
 * normalized (already-lowercase) handle on success or a human reason on
 * failure. This function does NOT check availability — see `checkHandle`.
 */
export function validateHandle(candidate: string): HandleValidation {
  const handle = candidate.trim();

  if (handle.length === 0) {
    return { valid: false, reason: "Enter a handle." };
  }
  if (handle !== handle.toLowerCase()) {
    return { valid: false, reason: "Handles must be lowercase." };
  }
  if (handle.length < HANDLE_MIN_LENGTH) {
    return { valid: false, reason: `Handles must be at least ${HANDLE_MIN_LENGTH} characters.` };
  }
  if (handle.length > HANDLE_MAX_LENGTH) {
    return { valid: false, reason: `Handles must be at most ${HANDLE_MAX_LENGTH} characters.` };
  }
  if (handle.includes("--")) {
    return { valid: false, reason: "Handles cannot contain consecutive hyphens." };
  }
  if (!HANDLE_SHAPE.test(handle)) {
    return {
      valid: false,
      reason: "Use lowercase letters, numbers, and hyphens; no leading or trailing hyphen."
    };
  }
  if (RESERVED_HANDLES.has(handle)) {
    return { valid: false, reason: "That handle is reserved." };
  }

  return { valid: true, handle };
}

export function handleRecordKey(handle: string): string {
  return `handles/${handle}.json`;
}

export function userHandleRecordKey(ownerId: string): string {
  return `userhandles/${ownerId}.json`;
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

/** The handle a candidate resolves to, if any (handle -> owner lookup). */
export async function resolveHandleOwner(bucket: R2Bucket, handle: string): Promise<string | null> {
  const record = await readJson<HandleRecord>(bucket, handleRecordKey(handle));
  if (!record || typeof record.ownerId !== "string" || !record.ownerId) {
    return null;
  }
  return record.ownerId;
}

/** The handle a user owns, if any (owner -> handle lookup). */
export async function getUserHandle(bucket: R2Bucket, ownerId: string): Promise<string | null> {
  const record = await readJson<UserHandleRecord>(bucket, userHandleRecordKey(ownerId));
  if (!record || typeof record.handle !== "string" || !record.handle) {
    return null;
  }
  return record.handle;
}

export type CheckHandleResult = {
  handle: string;
  valid: boolean;
  available: boolean;
  reason?: string;
};

/**
 * Validate a candidate and report whether it is free. Availability is only
 * meaningful when the shape is valid, so an invalid candidate reports
 * `available: false` with the validation reason.
 */
export async function checkHandle(bucket: R2Bucket, candidate: string): Promise<CheckHandleResult> {
  const normalized = candidate.trim();
  const validation = validateHandle(normalized);
  if (!validation.valid) {
    return { handle: normalized, valid: false, available: false, reason: validation.reason };
  }

  const owner = await resolveHandleOwner(bucket, validation.handle);
  if (owner) {
    return {
      handle: validation.handle,
      valid: true,
      available: false,
      reason: "That handle is taken."
    };
  }

  return { handle: validation.handle, valid: true, available: true };
}

export type ClaimHandleResult =
  | { ok: true; handle: string; alreadyOwned: boolean }
  | { ok: false; status: 400 | 409; reason: string };

/**
 * Claim a handle for `ownerId`. Claim-once and immutable in v1:
 *  - If the user already owns exactly this handle, succeed idempotently.
 *  - If the user already owns a *different* handle, refuse (409) — no rename.
 *  - If the handle is taken by someone else, refuse (409).
 *  - Otherwise write both mapping records, then re-read `handles/{h}` to detect
 *    a racing claimant (best-effort; documented narrow window).
 */
export async function claimHandle(
  bucket: R2Bucket,
  ownerId: string,
  candidate: string,
  now: () => string = () => new Date().toISOString()
): Promise<ClaimHandleResult> {
  const validation = validateHandle(candidate);
  if (!validation.valid) {
    return { ok: false, status: 400, reason: validation.reason };
  }
  const handle = validation.handle;

  // One handle per user (immutable in v1).
  const existingOwn = await getUserHandle(bucket, ownerId);
  if (existingOwn) {
    if (existingOwn === handle) {
      return { ok: true, handle, alreadyOwned: true };
    }
    return {
      ok: false,
      status: 409,
      reason: "You already have a handle. Handles can't be changed."
    };
  }

  // Handle must be free.
  const currentOwner = await resolveHandleOwner(bucket, handle);
  if (currentOwner) {
    if (currentOwner === ownerId) {
      // The handle record points at us but the reverse record was missing —
      // heal it and treat as an idempotent success.
      await putJson(bucket, userHandleRecordKey(ownerId), {
        handle,
        claimedAt: now()
      } satisfies UserHandleRecord);
      return { ok: true, handle, alreadyOwned: true };
    }
    return { ok: false, status: 409, reason: "That handle is taken." };
  }

  const claimedAt = now();
  await putJson(bucket, handleRecordKey(handle), { ownerId, claimedAt } satisfies HandleRecord);
  await putJson(bucket, userHandleRecordKey(ownerId), { handle, claimedAt } satisfies UserHandleRecord);

  // Best-effort race detection: if two brand-new claims landed together the
  // last writer wins the handle record; the loser sees a mismatch and backs
  // out its reverse record so it does not falsely believe it owns the handle.
  const confirmed = await resolveHandleOwner(bucket, handle);
  if (confirmed !== ownerId) {
    await bucket.delete(userHandleRecordKey(ownerId)).catch(() => undefined);
    return { ok: false, status: 409, reason: "That handle was just taken. Try another." };
  }

  return { ok: true, handle, alreadyOwned: false };
}

/**
 * Re-home a handle from an anonymous namespace to a CAIL subject during
 * first-login migration (lib/migration.ts). Non-destructive and idempotent,
 * mirroring the module's copy-then-delete ordering:
 *  - Always rewrite `handles/{anonHandle}` ownerId -> subject so shared
 *    `/u/{anonHandle}/…` links keep resolving.
 *  - Move `userhandles/{anon}` -> `userhandles/{subject}` ONLY when the subject
 *    has no handle of its own; if the subject already has a primary handle it
 *    keeps it, and the anon handle survives as an alias (handle record only).
 */
export async function migrateHandle(options: {
  bucket: R2Bucket;
  anonUserId: string;
  subject: string;
  now?: () => string;
}): Promise<void> {
  const { bucket, anonUserId, subject } = options;
  const now = options.now ?? (() => new Date().toISOString());

  const anonHandle = await getUserHandle(bucket, anonUserId);
  if (!anonHandle) {
    return; // nothing to move
  }

  // Point the handle record at the subject (idempotent — safe to repeat).
  const record = await readJson<HandleRecord>(bucket, handleRecordKey(anonHandle));
  const claimedAt = record?.claimedAt ?? now();
  await putJson(bucket, handleRecordKey(anonHandle), {
    ownerId: subject,
    claimedAt
  } satisfies HandleRecord);

  const subjectHandle = await getUserHandle(bucket, subject);
  if (!subjectHandle) {
    // Subject has no handle: promote the anon handle to the subject's primary.
    await putJson(bucket, userHandleRecordKey(subject), {
      handle: anonHandle,
      claimedAt
    } satisfies UserHandleRecord);
  }
  // else: subject keeps its existing primary; anon handle stays an alias.

  // Drop the anon reverse record (handle record already re-homed above).
  await bucket.delete(userHandleRecordKey(anonUserId)).catch(() => undefined);
}
