import { z } from "zod";
import type { Env, LegacySessionRecord, User } from "../types";
import type { MutationJournalStore } from "./owner-mutations";
import {
  migrationPendingKey,
  type MigrationResult,
} from "./migration";
import {
  emitDiagnostic,
  type SiteStudioLoggingContext,
} from "./logging";

/** Retryable failure for an import-store boundary. */
export class SessionStoreUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SessionStoreUnavailableError";
  }
}

const legacyUserSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  cail: z.boolean().optional(),
  email: z.string().optional(),
  name: z.string().optional(),
  operationalSubject: z.string().optional(),
});

const legacySessionSchema = z.object({
  user: legacyUserSchema,
  expiresAt: z.string(),
});

const resolvingImportStateSchema = z.object({
  status: z.literal("resolving"),
  origin: z.literal("cookie-reservation"),
  anonSessionId: z.string().min(1),
}).strict();

const pendingImportStateSchema = z.object({
  status: z.literal("pending"),
  origin: z.enum(["legacy-marker", "cookie-reservation"]),
  anonUserId: z.string().startsWith("user_"),
  anonSessionId: z.string().optional(),
}).strict();

const importStateSchema = z.discriminatedUnion("status", [
  resolvingImportStateSchema,
  pendingImportStateSchema,
]);

export type PendingImportState = z.infer<typeof importStateSchema>;

export type SubjectImportOutcome = "imported" | "closed";

/** One subject's durable first-login reservation in its MutationCoordinator. */
export const IMPORT_STATE_STORAGE_KEY = "anonymous-import";

export function importCompletionKey(subject: string): string {
  return `imports/${encodeURIComponent(subject)}`;
}

export async function readLegacySession(
  env: Pick<Env, "SITE_STUDIO_BUCKET">,
  sessionId: string,
  logging?: SiteStudioLoggingContext,
): Promise<User | null> {
  let legacyText: string | null;
  try {
    const legacy = await env.SITE_STUDIO_BUCKET.get(`sessions/${sessionId}.json`);
    legacyText = legacy ? await legacy.text() : null;
  } catch (error) {
    // An R2 transport failure is not an absent session. Treating it as absent
    // would close first-login import and orphan the old namespace.
    throw new SessionStoreUnavailableError(
      `Legacy session store unavailable reading ${sessionId}`,
      { cause: error },
    );
  }
  if (legacyText === null) return null;

  let parsed: LegacySessionRecord;
  try {
    parsed = legacySessionSchema.parse(JSON.parse(legacyText));
  } catch {
    emitDiagnostic("warning", "invalid_legacy_session", {}, logging);
    return null;
  }

  const expiresAt = Date.parse(parsed.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  return parsed.user;
}

export async function hasCompletedImport(
  env: Pick<Env, "SITE_STUDIO_BUCKET">,
  subject: string,
): Promise<boolean> {
  try {
    return (await env.SITE_STUDIO_BUCKET.get(importCompletionKey(subject))) !== null;
  } catch (error) {
    throw new SessionStoreUnavailableError(
      "Import completion store unavailable",
      { cause: error },
    );
  }
}

export async function recordCompletedImport(
  env: Pick<Env, "SITE_STUDIO_BUCKET">,
  subject: string,
): Promise<void> {
  try {
    await env.SITE_STUDIO_BUCKET.put(
      importCompletionKey(subject),
      "",
      { onlyIf: { etagDoesNotMatch: "*" } },
    );
  } catch (error) {
    throw new SessionStoreUnavailableError(
      "Import completion store unavailable",
      { cause: error },
    );
  }
}

export async function retireLegacySession(
  env: Pick<Env, "SITE_STUDIO_BUCKET">,
  sessionId: string | undefined,
): Promise<void> {
  if (!sessionId) return;
  try {
    await env.SITE_STUDIO_BUCKET.delete(`sessions/${sessionId}.json`);
  } catch (error) {
    throw new SessionStoreUnavailableError(
      "Legacy import session could not be retired",
      { cause: error },
    );
  }
}

type ImportEnvironment = Pick<Env, "SITE_STUDIO_BUCKET" | "SESSION_KV">;

export interface SubjectImportOptions {
  env: ImportEnvironment;
  storage: MutationJournalStore;
  subject: string;
  cookieValue?: string;
  logging?: SiteStudioLoggingContext;
  /** Atomic first-wins claim keyed by the anonymous owner. */
  claimAnonymous: (
    anonUserId: string,
    subject: string,
  ) => Promise<{ granted: boolean }>;
  /** The distinct anonymous-owner MutationCoordinator queue. */
  migrateAnonymous: (
    anonUserId: string,
    subject: string,
    anonSessionId?: string,
  ) => Promise<MigrationResult>;
  /** Best-effort completion of the anonymous namespace's claim gate. */
  markAnonymousComplete?: (anonUserId: string, subject: string) => Promise<void>;
}

/**
 * Run one subject's first-login import decision.
 *
 * The caller must invoke this from the subject-keyed MutationCoordinator
 * queue. A cookie source is reserved in that queue's durable storage before
 * the anonymous claim/copy RPC starts. Thus a later no-cookie or alternate-
 * cookie request cannot close or replace a source admitted by an earlier
 * request, including when the copy fails. The R2 completion marker remains
 * the sole completion authority; the DO record is a pending source
 * reservation only.
 */
export async function runSubjectImport(
  options: SubjectImportOptions,
): Promise<SubjectImportOutcome> {
  const {
    env,
    storage,
    subject,
    cookieValue = "",
    logging,
    claimAnonymous,
    migrateAnonymous,
  } = options;

  // A completed R2 marker is authoritative even if a crash left an old
  // pending reservation behind. The marker means the source has already been
  // copied/retired; retrying it would be an unintended re-import.
  if (await hasCompletedImport(env, subject)) return "closed";

  let reservationCreatedHere = false;
  let pendingState = await storage.get<PendingImportState>(IMPORT_STATE_STORAGE_KEY);
  if (pendingState !== undefined) {
    pendingState = importStateSchema.parse(pendingState);
  }

  // A durable resolving state means an earlier request selected this exact
  // cookie but failed before R2 could reveal the anonymous owner. It remains
  // the source decision: retry it even when the current request has no cookie
  // (or presents a different one). A transport failure leaves it intact.
  let cookieResolutionWasAlreadyAttempted = pendingState?.status === "resolving";
  if (pendingState?.status === "resolving") {
    const legacyUser = await readLegacySession(
      env,
      pendingState.anonSessionId,
      logging,
    );
    if (legacyUser?.id.startsWith("user_")) {
      pendingState = {
        status: "pending",
        origin: "cookie-reservation",
        anonUserId: legacyUser.id,
        anonSessionId: pendingState.anonSessionId,
      };
      await storage.put(IMPORT_STATE_STORAGE_KEY, pendingState);
    } else {
      // The selected source is now absent or invalid. Clear only this
      // unresolved reservation and continue with an older legacy marker, if
      // one exists; do not replace it with the current request's cookie.
      await storage.delete(IMPORT_STATE_STORAGE_KEY);
      pendingState = undefined;
    }
  }

  if (!pendingState) {
    let legacyPending: string | null;
    try {
      legacyPending = await env.SESSION_KV.get(migrationPendingKey(subject));
    } catch (error) {
      throw new SessionStoreUnavailableError(
        "Import resume store unavailable",
        { cause: error },
      );
    }
    if (legacyPending !== null) {
      // Existing pending markers are retained as a recovery source. Invalid
      // values fail closed instead of turning into a made-up owner claim.
      pendingState = pendingImportStateSchema.parse({
        status: "pending",
        origin: "legacy-marker",
        anonUserId: legacyPending,
      });
      await storage.put(IMPORT_STATE_STORAGE_KEY, pendingState);
    }
  }

  if (
    !pendingState &&
    !cookieResolutionWasAlreadyAttempted &&
    cookieValue &&
    cookieValue !== subject
  ) {
    // Record the cookie before R2 lookup. If the lookup fails, a queued
    // no-cookie request will resume this exact source instead of closing
    // first-login import and losing the only recovery handle.
    const resolvingState: PendingImportState = {
      status: "resolving",
      origin: "cookie-reservation",
      anonSessionId: cookieValue,
    };
    await storage.put(IMPORT_STATE_STORAGE_KEY, resolvingState);
    reservationCreatedHere = true;
    cookieResolutionWasAlreadyAttempted = true;
    const legacyUser = await readLegacySession(env, cookieValue, logging);
    if (legacyUser?.id.startsWith("user_")) {
      // Persist the resolved owner alongside the cookie before contacting
      // either coordinator. If the claim RPC fails transiently, the next
      // request still resumes this exact source rather than selecting another
      // cookie or closing import.
      pendingState = {
        status: "pending",
        origin: "cookie-reservation",
        anonUserId: legacyUser.id,
        anonSessionId: cookieValue,
      };
      await storage.put(IMPORT_STATE_STORAGE_KEY, pendingState);
    } else {
      // Invalid or absent source follows the existing no-source close policy.
      // The reservation prevents a concurrent request from selecting another
      // source while this request is resolving it.
      await storage.delete(IMPORT_STATE_STORAGE_KEY);
      pendingState = undefined;
    }
  }

  if (!pendingState) {
    // No cookie source and no prior reservation: close first-login import only
    // while holding the subject queue, so a queued source cannot be lost.
    await recordCompletedImport(env, subject);
    return "closed";
  }

  const decision = await claimAnonymous(pendingState.anonUserId, subject);
  if (!decision.granted) {
    if (reservationCreatedHere) {
      // This reservation has not yet written the KV claim and belongs only to
      // this subject. Remove it after a definitive cross-subject refusal;
      // retain pre-existing pending state so historical resumes stay intact.
      await storage.delete(IMPORT_STATE_STORAGE_KEY);
    }
    throw new SessionStoreUnavailableError("Import ownership claim was refused");
  }

  const result = await migrateAnonymous(
    pendingState.anonUserId,
    subject,
    pendingState.anonSessionId,
  );

  if (result.status === "refused") {
    if (reservationCreatedHere) {
      await storage.delete(IMPORT_STATE_STORAGE_KEY);
    }
    throw new SessionStoreUnavailableError("Import ownership claim was refused");
  }

  // Retirement and completion stay after the copy. A failure in either step
  // leaves the pending reservation available for an idempotent retry.
  await retireLegacySession(env, pendingState.anonSessionId);
  await recordCompletedImport(env, subject);

  // Completion is now durable in R2; deletion is cleanup only. If it fails,
  // the next call sees the completion marker before considering any source.
  await storage.delete(IMPORT_STATE_STORAGE_KEY).catch(() => undefined);
  if (options.markAnonymousComplete) {
    await options.markAnonymousComplete(pendingState.anonUserId, subject).catch(() => {
      emitDiagnostic("warning", "migration_mark_complete_failed", {}, logging);
    });
  }
  return "imported";
}
