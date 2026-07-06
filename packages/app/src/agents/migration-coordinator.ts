import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import {
  decideClaim,
  decideMarkComplete,
  type ClaimDecision,
  type ClaimRecord
} from "../lib/migration-claim";

/**
 * MigrationCoordinator — the authoritative first-gate for WHO may migrate an
 * anonymous namespace into a CAIL subject (SS-3 / SS-19).
 *
 * Keyed by `idFromName(anonId)` (see session.ts). One DO instance exists per
 * anonymous namespace, and a DO runs single-threaded, so every subject racing
 * to claim the SAME anon namespace lands in the SAME instance and their claim
 * calls SERIALIZE. That is the atomic mutual exclusion the old KV
 * read-check-write lacked: no two subjects can both read the claim as empty and
 * both proceed. Keying by the anon id (not the subject) is what makes competing
 * subjects contend on one point — a subject-keyed DO would scatter them.
 *
 * State lives in `ctx.storage` under a single key. Because there is exactly one
 * DO per anonId, the stored record's identity is implied by the DO itself; the
 * `anonId` argument is accepted for symmetry with the caller and for a
 * defensive assertion, not to disambiguate storage.
 *
 * How this composes with the retained KV layer (lib/migration.ts): this DO is
 * the FIRST gate — it decides, atomically, which single subject is allowed to
 * migrate a given anon namespace. Once granted, migrateAnonymousData still runs
 * its own KV `migration:<anonId>` claim + `migration-pending:<subject>` resume
 * marker. Those are NOT a second authority on ownership (the DO already settled
 * that); they are the resumability / step-idempotency layer: a migration that
 * dies mid-run leaves the pending marker so a later authenticated request by
 * the SAME (already-granted) subject resumes it. The DO gate and the KV resume
 * marker never disagree because only one subject can pass the DO gate, and only
 * that subject ever writes the KV records.
 */
const CLAIM_STORAGE_KEY = "claim";

export class MigrationCoordinator extends DurableObject<Env> {
  private now(): string {
    return new Date().toISOString();
  }

  /**
   * Atomically decide whether `subject` may migrate the anonymous namespace
   * this DO represents. Serialized against all other claims for the same anonId
   * by the single-threaded DO runtime.
   *
   *  - No prior claim            → { granted: true,  resume: false } (fresh win)
   *  - Prior claim, same subject → { granted: true,  resume: true  } (resume)
   *  - Prior claim, different    → { granted: false, claimedBy }     (SS-3 block)
   */
  async claim(anonId: string, subject: string): Promise<ClaimDecision> {
    const record = await this.ctx.storage.get<ClaimRecord>(CLAIM_STORAGE_KEY);
    const { decision, newRecord } = decideClaim(record, subject, () => this.now());
    if (newRecord) {
      await this.ctx.storage.put(CLAIM_STORAGE_KEY, newRecord);
    }
    return decision;
  }

  /**
   * Flip this DO's claim to `complete`, but only when `subject` is the recorded
   * owner (a refused claimant can never complete someone else's claim). No-op
   * when the record is missing, owned by another subject, or already complete.
   */
  async markComplete(anonId: string, subject: string): Promise<void> {
    const record = await this.ctx.storage.get<ClaimRecord>(CLAIM_STORAGE_KEY);
    const updated = decideMarkComplete(record, subject, () => this.now());
    if (updated) {
      await this.ctx.storage.put(CLAIM_STORAGE_KEY, updated);
    }
  }
}
