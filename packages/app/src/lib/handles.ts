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
 * The claim flow (see `claimHandle` for the full interleaving walk):
 *
 * Each mapping record is written with atomic R2 put-if-absent (`onlyIf:
 * { etagDoesNotMatch: "*" }`): a lost conditional write means someone else won,
 * so concurrent claimants cannot clobber or silently share. The reverse slot
 * `userhandles/{owner}` is claimed FIRST because it is the "one handle per user"
 * gate — two handles racing for the same owner both contend on that one key, so
 * the loser has written nothing under `handles/…`. On then losing the forward
 * `handles/{handle}` write, the claim retires only the exact reverse generation
 * it created. A newer healthy replacement can never be deleted by the loser.
 *
 * These two writes are NOT one transaction, so a crash BETWEEN them can still
 * leave a durable orphan: the reverse slot written while the forward record was
 * never claimed (or was later won by someone else), pointing the user at a
 * handle they do not own. `claimHandle`'s fast path therefore VERIFIES the pair
 * before trusting the reverse slot — if the forward record is missing or points
 * at a different owner, the reverse slot is a stale orphan and is conditionally
 * replaced so the claim proceeds cleanly, instead of the old behavior of
 * falsely reporting "you already have a handle" and hiding the orphan forever.
 * The repair atomically replaces the exact stale R2 generation with the new
 * claim rather than deleting it, so two concurrent repairers cannot erase one
 * another's healthy replacement.
 * A healthy reverse+forward pair keeps the idempotent-success /
 * different-handle-409 contract. (Reverse-orphan reaper: SS-3 residual #2.)
 */

import { readR2Json } from "./r2-json";

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

/**
 * A missing forward record younger than this is treated as an in-flight claim,
 * not a crashed orphan. R2 cannot atomically commit the two mapping objects, so
 * immediate reaping would let a concurrent request erase a live reverse claim.
 */
export const HANDLE_CLAIM_SETTLE_MS = 2 * 60 * 1000;

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

/**
 * Atomic put-if-absent: write `value` at `key` only when no object exists
 * there. R2's conditional put `onlyIf: { etagDoesNotMatch: "*" }` succeeds iff
 * the key is empty (the wildcard etag never matches an existing object) and
 * returns `null` on a failed condition (no write, no throw). The R2 object
 * returned on success carries the ETag needed to fence any later retirement.
 *
 * This is the compare-and-set the claim flow relies on so two concurrent claims
 * can't both "win" a handle or leave a user owning two handle records.
 */
async function putJsonObjectIfAbsent(
  bucket: R2Bucket,
  key: string,
  value: unknown
): Promise<R2Object | null> {
  return bucket.put(key, JSON.stringify(value), {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" }
  });
}

async function putJsonIfAbsent(bucket: R2Bucket, key: string, value: unknown): Promise<boolean> {
  return (await putJsonObjectIfAbsent(bucket, key, value)) !== null;
}

const RETIRED_REVERSE_CLAIM_AT = "1970-01-01T00:00:00.000Z";

/**
 * Retire only the exact reverse generation whose forward claim lost.
 *
 * R2 has no conditional delete. An unconditional rollback delete can yield
 * after observing the failed forward claim, then erase a newer healthy reverse
 * record written by recovery or another claimant. Replacing the losing
 * generation with an immediately repairable orphan marker preserves the
 * generation fence: if anything changed the slot, this CAS loses harmlessly.
 */
async function retireReverseClaim(
  bucket: R2Bucket,
  key: string,
  expectedEtag: string,
  handle: string
): Promise<void> {
  await bucket.put(
    key,
    JSON.stringify({
      handle,
      claimedAt: RETIRED_REVERSE_CLAIM_AT
    } satisfies UserHandleRecord),
    {
      onlyIf: { etagMatches: expectedEtag },
      httpMetadata: { contentType: "application/json" }
    }
  );
}

/** The handle a candidate resolves to, if any (handle -> owner lookup). */
export async function resolveHandleOwner(bucket: R2Bucket, handle: string): Promise<string | null> {
  const record = await readR2Json<HandleRecord>(bucket, handleRecordKey(handle));
  if (!record || typeof record.ownerId !== "string" || !record.ownerId) {
    return null;
  }
  return record.ownerId;
}

/** Read the reverse mapping without treating it as proof of ownership. */
async function readRecordedUserHandle(
  bucket: R2Bucket,
  ownerId: string,
): Promise<{ record: UserHandleRecord; etag?: string } | null> {
  const object = await bucket.get(userHandleRecordKey(ownerId));
  if (!object) return null;

  let record: UserHandleRecord;
  try {
    record = JSON.parse(await object.text()) as UserHandleRecord;
  } catch {
    return null;
  }
  if (!record || typeof record.handle !== "string" || !record.handle) {
    return null;
  }
  return {
    record,
    etag: typeof object.etag === "string" && object.etag ? object.etag : undefined,
  };
}

async function getRecordedUserHandle(bucket: R2Bucket, ownerId: string): Promise<string | null> {
  return (await readRecordedUserHandle(bucket, ownerId))?.record.handle ?? null;
}

/**
 * The primary handle a user owns, if any.
 *
 * The reverse record is only one half of the non-transactional mapping. Never
 * expose or publish through it unless the forward record still points back to
 * this owner; a crash between the two claim writes can leave a stale reverse
 * record, and migration can deliberately leave forward-only aliases.
 */
export async function getUserHandle(bucket: R2Bucket, ownerId: string): Promise<string | null> {
  const handle = await getRecordedUserHandle(bucket, ownerId);
  if (!handle) return null;
  return (await resolveHandleOwner(bucket, handle)) === ownerId ? handle : null;
}

/**
 * Resolve the effective public handle while an anonymous migration is being
 * retried. A crash can commit the forward `handles/{handle}` update before the
 * subject reverse record, leaving the anonymous reverse record as the only
 * durable clue. `getUserHandle` intentionally rejects that stale reverse
 * record, so migration planning needs this narrowly-scoped recovery read.
 */
export async function getMigrationHandle(
  bucket: R2Bucket,
  anonUserId: string,
  subject: string
): Promise<string | null> {
  const subjectHandle = await getUserHandle(bucket, subject);
  if (subjectHandle) return subjectHandle;

  const anonRecord = await readRecordedUserHandle(bucket, anonUserId);
  if (!anonRecord) return null;
  const anonHandle = anonRecord.record.handle;
  const owner = await resolveHandleOwner(bucket, anonHandle);
  return owner === anonUserId || owner === subject ? anonHandle : null;
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
 *
 * The two mapping records use compare-and-set writes, but R2 has no transaction
 * across them. A missing forward record is not reaped until the reverse claim
 * is older than HANDLE_CLAIM_SETTLE_MS, so a live first claim keeps the per-user
 * gate while its forward write is in flight.
 *
 *   1. Claim the per-user REVERSE slot `userhandles/{owner}` FIRST with
 *      put-if-absent. This slot is the single "one handle per user" gate: a user
 *      racing two different handles has both attempts contend on this one key, so
 *      one wins and the loser has written nothing under `handles/…` yet.
 *      A lost reverse claim means the user already has (or just took)
 *      a handle: if it's this same handle, succeed idempotently; otherwise 409.
 *   2. Claim the handle record `handles/{handle}` with put-if-absent. A lost
 *      claim means another user won this handle; conditionally retire the exact
 *      reverse generation written in step 1 and 409. The conditional write
 *      cannot alter a newer generation installed by a concurrent request.
 *
 * Expected interleavings:
 *  - Same user, two handles A and B: both reach step 1 on the same
 *    `userhandles/{owner}` key and put-if-absent lets one through. A second
 *    request that observes the fresh half-claim returns a retryable 409.
 *  - Two users X and Y, same handle H, fully interleaved: each claims its own
 *    distinct reverse slot in step 1 (different keys, both succeed), then both
 *    contend on `handles/H` in step 2. One wins; the other retires only its exact
 *    reverse generation and 409s. The handle is owned by exactly one user.
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

  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Fast-path reads (best-effort; the atomic puts below are authoritative).
    //
    // Reverse-orphan reaper (SS-3 residual #2, SS-32): a reverse slot
    // `userhandles/{owner}` is only trustworthy if the FORWARD record
    // `handles/{thatHandle}` exists AND points back at this owner. A crash
    // between claimHandle's two put-if-absent writes can leave the reverse slot
    // pointing at a handle whose forward record was never written (or was later
    // won by someone else). The old fast path returned "you already have a
    // handle" on the reverse slot alone, which HID that orphan permanently.
    //
    // R2 has no conditional delete, so repair by atomically REPLACING the exact
    // orphan generation with this request's new reverse claim. If another
    // repairer or migration changed the slot first, the ETag condition loses and
    // we restart once against the winner. No delete gap can erase that winner.
    //
    // Interleavings this reaper heals vs. leaves intact:
    //  A) Crash after reverse put, before forward put: reverse says {owner->H},
    //     forward `handles/H` is MISSING. resolveHandleOwner(H) === null → orphan.
    //     Reap the reverse slot, fall through, and re-claim cleanly (self-heals
    //     even when the caller now asks for a DIFFERENT handle than the orphaned
    //     one — the owner never truly owned H, so no 409 is warranted).
    //  B) Crash after reverse put; another user then legitimately wins `handles/H`:
    //     reverse says {owner->H}, forward `handles/H` points at STRANGER, not
    //     owner. Trusting the reverse would wrongly claim owner holds H. Reap the
    //     reverse slot and fall through; the owner is now handle-less and the
    //     subsequent claim resolves against the real state (idempotent success if
    //     they asked for a free handle, taken-409 if they asked for H itself).
    //  C) Healthy pair (forward exists and points at owner): NOT an orphan. Keep
    //     the original contract — same handle → idempotent success; different
    //     handle → 409 "you already have a handle".
    const existingRecord = await readR2Json<UserHandleRecord>(bucket, userHandleRecordKey(ownerId));
    const existingOwn =
      existingRecord && typeof existingRecord.handle === "string" && existingRecord.handle
        ? existingRecord.handle
        : null;
    if (existingOwn) {
      const forwardOwner = await resolveHandleOwner(bucket, existingOwn);
      if (forwardOwner === ownerId) {
        // Case C: healthy reverse+forward pair.
        if (existingOwn === handle) {
          return { ok: true, handle, alreadyOwned: true };
        }
        return {
          ok: false,
          status: 409,
          reason: "You already have a handle. Handles can't be changed."
        };
      }
      const claimedAtMs = Date.parse(existingRecord!.claimedAt);
      const nowMs = Date.parse(now());
      if (
        Number.isFinite(claimedAtMs) &&
        Number.isFinite(nowMs) &&
        nowMs - claimedAtMs >= 0 &&
        nowMs - claimedAtMs < HANDLE_CLAIM_SETTLE_MS
      ) {
        return {
          ok: false,
          status: 409,
          reason: "Your handle claim is still in progress. Try again shortly."
        };
      }
      // Cases A/B: the reverse slot is an orphan (forward missing or owned by
      // someone else). Atomically promote this request into the reverse slot.
      const reverseKey = userHandleRecordKey(ownerId);
      const latestObject = await bucket.get(reverseKey);
      if (!latestObject) {
        if (attempt === 0) {
          continue;
        }
        return {
          ok: false,
          status: 409,
          reason: "You already have a handle. Handles can't be changed."
        };
      }
      let latest: UserHandleRecord | null = null;
      try {
        latest = JSON.parse(await latestObject.text()) as UserHandleRecord;
      } catch {
        // Malformed ownership state is not safe to replace automatically.
      }
      if (
        latest?.handle !== existingRecord?.handle ||
        latest?.claimedAt !== existingRecord?.claimedAt
      ) {
        if (attempt === 0) {
          continue;
        }
        return {
          ok: false,
          status: 409,
          reason: "You already have a handle. Handles can't be changed."
        };
      }

      const claimedAt = now();
      const replaced = await bucket.put(
        reverseKey,
        JSON.stringify({ handle, claimedAt } satisfies UserHandleRecord),
        {
          onlyIf: { etagMatches: latestObject.etag },
          httpMetadata: { contentType: "application/json" }
        }
      );
      if (!replaced) {
        if (attempt === 0) continue;
        return {
          ok: false,
          status: 409,
          reason: "You already have a handle. Handles can't be changed."
        };
      }

      // The exact orphan generation is now this request's fresh claim. Finish
      // at the forward-key gate below without a second reverse put.
      const handleWon = await putJsonIfAbsent(bucket, handleRecordKey(handle), {
        ownerId,
        claimedAt
      } satisfies HandleRecord);
      if (handleWon) {
        return { ok: true, handle, alreadyOwned: false };
      }
      const currentOwner = await resolveHandleOwner(bucket, handle);
      if (currentOwner === ownerId) {
        return { ok: true, handle, alreadyOwned: true };
      }
      await retireReverseClaim(bucket, reverseKey, replaced.etag, handle);
      return { ok: false, status: 409, reason: "That handle is taken." };
    }

    const claimedAt = now();

    // Step 1: atomically claim the per-user reverse slot. This is the "one handle
    // per user" gate and it comes FIRST so a lost race here means no handle record
    // was written by this attempt (no orphan).
    const reverseKey = userHandleRecordKey(ownerId);
    const reverseClaim = await putJsonObjectIfAbsent(bucket, reverseKey, {
      handle,
      claimedAt
    } satisfies UserHandleRecord);
    if (!reverseClaim) {
      // We lost the reverse slot to a concurrent claim by this same owner. Read
      // what actually landed: same handle → idempotent success; different → 409.
      const settled = await getUserHandle(bucket, ownerId);
      if (settled === handle) {
        return { ok: true, handle, alreadyOwned: true };
      }
      return {
        ok: false,
        status: 409,
        reason: "You already have a handle. Handles can't be changed."
      };
    }

    // Step 2: atomically claim the handle record. We now own the reverse slot, so
    // any failure here must NOT leave an authoritative reverse claim pointing at
    // a handle we don't own.
    const handleWon = await putJsonIfAbsent(bucket, handleRecordKey(handle), {
      ownerId,
      claimedAt
    } satisfies HandleRecord);
    if (handleWon) {
      return { ok: true, handle, alreadyOwned: false };
    }

    // The handle record already exists. If it points at us, this is a self-heal:
    // the handle was ours but the reverse slot had gone missing (which is exactly
    // what we just wrote in step 1). Keep the reverse slot and succeed.
    const currentOwner = await resolveHandleOwner(bucket, handle);
    if (currentOwner === ownerId) {
      return { ok: true, handle, alreadyOwned: true };
    }

    // Another user owns the handle. Retire only the exact reverse generation we
    // wrote in step 1, without risking a newer healthy replacement, then 409.
    await retireReverseClaim(bucket, reverseKey, reverseClaim.etag, handle);
    return { ok: false, status: 409, reason: "That handle is taken." };
  }

  return {
    ok: false,
    status: 409,
    reason: "You already have a handle. Handles can't be changed."
  };
}

/**
 * Re-home a handle from an anonymous namespace to a CAIL subject during
 * first-login migration (lib/migration.ts):
 *  - It conditionally rewrites `handles/{anonHandle}` ownerId -> subject only
 *    while the forward record still belongs to the anonymous owner. Ownership
 *    drift fails closed and leaves the import pending.
 *  - Move `userhandles/{anon}` -> `userhandles/{subject}` ONLY when the subject
 *    has no handle of its own; if the subject already has a primary handle it
 *    keeps it, and the anon handle survives as an alias (handle record only).
 *    "Has no handle of its own" is decided ATOMICALLY by put-if-absent on the
 *    reverse slot (SS-52), never by a read-then-plain-put — see below.
 */
export async function migrateHandle(options: {
  bucket: R2Bucket;
  anonUserId: string;
  subject: string;
  now?: () => string;
}): Promise<void> {
  const { bucket, anonUserId, subject } = options;
  const now = options.now ?? (() => new Date().toISOString());

  // Migration must inspect a stale reverse record so it can distinguish
  // "nothing to move" from forward-ownership drift and fail the import closed.
  const anonReverse = await readRecordedUserHandle(bucket, anonUserId);
  if (!anonReverse) {
    return; // nothing to move
  }
  const anonHandle = anonReverse.record.handle;

  // Re-home the forward record only when its current ETag still proves that it
  // belongs to the anonymous owner. A stale/orphaned reverse record must never
  // be able to overwrite a later legitimate claimant. Seeing `subject` is the
  // idempotent crash-recovery case: the forward write committed previously but
  // the reverse-slot cleanup did not.
  const forwardKey = handleRecordKey(anonHandle);
  const forwardObject = await bucket.get(forwardKey);
  if (!forwardObject) {
    throw new Error("Handle migration stopped because forward ownership changed.");
  }
  let record: HandleRecord;
  try {
    record = JSON.parse(await forwardObject.text()) as HandleRecord;
  } catch {
    throw new Error("Handle migration stopped because forward ownership changed.");
  }
  if (record.ownerId !== anonUserId && record.ownerId !== subject) {
    throw new Error("Handle migration stopped because forward ownership changed.");
  }
  const claimedAt = record.claimedAt || now();
  if (record.ownerId === anonUserId) {
    const updated = await bucket.put(
      forwardKey,
      JSON.stringify({ ownerId: subject, claimedAt } satisfies HandleRecord),
      {
        httpMetadata: { contentType: "application/json" },
        onlyIf: { etagMatches: forwardObject.etag }
      }
    );
    if (!updated) {
      throw new Error("Handle migration stopped because forward ownership changed.");
    }
  }

  // SS-52: promote the anon handle to the subject's primary ONLY by atomically
  // claiming the reverse slot with put-if-absent. The subject's own concurrent
  // POST /api/handle CAS-claims this same `userhandles/{subject}` key
  // (claimHandle step 1); the old read-check-then-plain-put here could observe
  // "no handle", lose that race, and then CLOBBER the just-claimed reverse slot
  // — permanently orphaning the claimed handle (its forward record points at
  // the subject, but no reverse slot names it, so it can neither be used nor
  // ever re-claimed by anyone else). Losing this conditional write means the
  // subject already holds (or just claimed) a primary handle — re-checking the
  // settled mapping there is purely confirmatory, since either way the reverse
  // slot must NOT be overwritten: the anon handle simply stays an alias (its
  // forward record was re-homed to the subject above), which is exactly the
  // documented outcome for a subject that already has a handle. Idempotent
  // re-runs land here too (the reverse slot already names anonHandle).
  await putJsonIfAbsent(bucket, userHandleRecordKey(subject), {
    handle: anonHandle,
    claimedAt
  } satisfies UserHandleRecord);

  // R2 has no conditional delete. Retire only the exact anonymous reverse
  // generation observed above; if another anonymous request replaced it while
  // migration was in flight, the ETag condition loses and that newer claim
  // survives. A storage failure is best-effort cleanup: the stale reverse is
  // non-authoritative because its forward record now points at the subject.
  if (anonReverse.etag) {
    await retireReverseClaim(
      bucket,
      userHandleRecordKey(anonUserId),
      anonReverse.etag,
      anonHandle,
    ).catch(() => undefined);
  }
}
