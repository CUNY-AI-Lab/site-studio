/**
 * Pure claim-decision logic for the anonymous→subject migration gate (SS-3).
 *
 * Background — the split-brain race this closes:
 * The first-login migration (lib/migration.ts) re-homes an anonymous `user_…`
 * namespace into a CAIL subject. Before this module, the "who owns this anon
 * namespace" decision was a KV read-check-write on `migration:<anonId>` with no
 * compare-and-set. Under KV's eventual consistency, two DIFFERENT subjects that
 * both present the SAME anonymous session cookie can each read the claim as
 * `null` and each migrate the anon namespace into their OWN subject — the data
 * lands under two owners (split brain). The SS-19 residual is the same root
 * cause at a narrower blast radius: two concurrent FIRST logins for the same
 * anon+subject both pass the pre-check.
 *
 * Fix: a Durable Object (agents/migration-coordinator.ts) keyed by
 * `idFromName(anonId)` provides the atomic mutual exclusion. A DO executes
 * single-threaded, so ALL claimants of one anon namespace serialize to one
 * point — the DO reads/writes its `ctx.storage` claim record with no
 * interleaving. Keying by the ANON NAMESPACE (not the subject) is essential:
 * the race is different-subjects-competing-for-the-same-anon-namespace, so the
 * serialization point must be the thing they contend over (the anon id). A
 * subject-keyed DO would place the two racing subjects in two DIFFERENT DOs and
 * would NOT serialize them.
 *
 * This module holds ONLY the pure decision (stored record + claimant subject →
 * grant/refuse/resume + the record to persist). It has no `cloudflare:workers`
 * imports, so it is unit-testable under node/vitest, which cannot load a real
 * DO class. The DO is a thin shell that reads storage, calls `decideClaim`,
 * writes the returned record back, and returns the outcome. This mirrors how
 * the repo keeps DO-runtime logic testable (lib/agent-porter.ts lazy-imports
 * the runtime-only `agents` module for the same reason).
 */

/** Durable claim record stored in the coordinator DO's `ctx.storage`. */
export interface ClaimRecord {
  /** The CAIL subject that first claimed this anonymous namespace. */
  subject: string;
  status: "pending" | "complete";
  startedAt: string;
  completedAt?: string;
}

/** Outcome returned to the caller (session.ts) by the DO's `claim` RPC. */
export interface ClaimDecision {
  /** True when THIS subject may proceed to migrate the anon namespace. */
  granted: boolean;
  /**
   * True when the grant is a resume of this same subject's earlier claim
   * (record already existed for this subject), rather than a fresh first claim.
   * The caller treats both the same for migration, but it disambiguates a
   * first-gate grant from a resume for logging/telemetry.
   */
  resume: boolean;
  /**
   * The subject that owns the claim when granted:false (i.e. the anon namespace
   * was already claimed by a DIFFERENT subject — the SS-3 block). null on a
   * grant.
   */
  claimedBy: string | null;
}

/** The full result of `decideClaim`: the outcome plus what to persist. */
export interface ClaimResolution {
  decision: ClaimDecision;
  /**
   * The record to write back to storage, or null when nothing should change
   * (a refusal never mutates another subject's claim).
   */
  newRecord: ClaimRecord | null;
}

/**
 * Decide a claim for `subject` against the currently-stored `record`.
 *
 *  - No record        → GRANT (fresh), status "pending". First claimant wins.
 *  - Record, same     → GRANT (resume). Idempotent retry by the owning subject;
 *    a partial migration must be resumable, so the same subject is always let
 *    back in without disturbing the record.
 *  - Record, different → REFUSE. The SS-3 block: a second, different subject can
 *    never claim an anon namespace already bound to someone else. The stored
 *    record is left untouched (newRecord: null).
 *
 * Pure and total: given the same inputs it always returns the same outputs and
 * never touches storage or the clock itself (the caller supplies `now`).
 */
export function decideClaim(
  record: ClaimRecord | null | undefined,
  subject: string,
  now: () => string
): ClaimResolution {
  if (!record) {
    const newRecord: ClaimRecord = { subject, status: "pending", startedAt: now() };
    return {
      decision: { granted: true, resume: false, claimedBy: null },
      newRecord
    };
  }

  if (record.subject === subject) {
    // Resume: the owning subject is retrying. Never rewrite the record here —
    // preserve startedAt/status so a `complete` record stays complete and a
    // `pending` one keeps its original start time.
    return {
      decision: { granted: true, resume: true, claimedBy: subject },
      newRecord: null
    };
  }

  // A different subject already owns this anon namespace: hard refusal.
  return {
    decision: { granted: false, resume: false, claimedBy: record.subject },
    newRecord: null
  };
}

/**
 * Decide the record to persist when marking a claim complete. Only the owning
 * subject may flip its own claim to `complete`; a mismatched subject is a no-op
 * (returns null) so a refused claimant can never mutate the real owner's record.
 */
export function decideMarkComplete(
  record: ClaimRecord | null | undefined,
  subject: string,
  now: () => string
): ClaimRecord | null {
  if (!record || record.subject !== subject) {
    return null;
  }
  if (record.status === "complete") {
    return null; // already complete — nothing to write
  }
  return { ...record, status: "complete", completedAt: now() };
}
