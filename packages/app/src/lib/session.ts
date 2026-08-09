import { createMiddleware } from "hono/factory";
import { getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import type { Env, LegacySessionRecord, User } from "../types";
import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from "./constants";
import {
  cailAuthRequiredResponse,
  resolveKeyringGatewayJwt,
  resolveRequestIdentity,
  type CailIdentity,
} from "./cail-identity";
import { migrationPendingKey } from "./migration";
import {
  emitDiagnostic,
  createSiteStudioBoundaryContext,
  getLoggingContext,
  serializeSiteStudioLoggingContext,
  type LoggingVariables,
  type SiteStudioLoggingContext,
  withOperationalSubject,
} from "./logging";

type SessionVariables = {
  sessionId: string;
  user: User;
  /**
   * Raw, already-verified selected identity JWT from the current request.
   * Downstream handlers forward this exact token to the CAIL model proxy.
   */
  cailIdentityJwt?: string;
  cailGatewayJwt?: string;
};

/** KV session key for a verified CAIL subject. */
function cailSessionKey(subject: string): string {
  return `cail:${subject}`;
}

function userFromIdentity(identity: CailIdentity, createdAt: string): User {
  return {
    id: identity.subject,
    createdAt,
    cail: true,
    email: identity.email,
    name: identity.name,
    // Separately keyed log subject; never derived from `id`.
    ...(identity.operationalSubject === undefined
      ? {}
      : { operationalSubject: identity.operationalSubject }),
  };
}

function isSessionRecord(value: unknown): value is LegacySessionRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Record<string, unknown>;
  return (
    typeof maybe.expiresAt === "string" &&
    !!maybe.user &&
    typeof maybe.user === "object" &&
    typeof (maybe.user as Record<string, unknown>).id === "string" &&
    typeof (maybe.user as Record<string, unknown>).createdAt === "string"
  );
}

/**
 * SS-46: the session/migration store was
 * UNREACHABLE — distinct from "no record" / "invalid record". Callers must fail
 * loud (503, retryable) instead of treating the session as absent: reading an
 * outage as "absent" would mint a fresh identity or skip the migration marker,
 * and the subsequent cookie write would permanently orphan the previous
 * workspace namespace.
 */
export class SessionStoreUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SessionStoreUnavailableError";
  }
}

/** SS-46: retryable 503 for a session-store outage. Never "record absent". */
function sessionStoreUnavailableResponse(): Response {
  return new Response(
    JSON.stringify({
      error: "session_store_unavailable",
      message: "Site Studio cannot reach its session store right now. Please retry in a moment.",
    }),
    {
      status: 503,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": "5",
      },
    }
  );
}

async function readLegacySession(
  env: Env,
  sessionId: string,
  logging?: SiteStudioLoggingContext,
): Promise<User | null> {
  let legacyText: string | null;
  try {
    const legacy = await env.SITE_STUDIO_BUCKET.get(`sessions/${sessionId}.json`);
    legacyText = legacy ? await legacy.text() : null;
  } catch (error) {
    // SS-46: same distinction for the legacy store — an R2 transport failure is
    // an outage, not an absent record.
    throw new SessionStoreUnavailableError(
      `Legacy session store unavailable reading ${sessionId}`,
      { cause: error }
    );
  }
  if (legacyText === null) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(legacyText) as unknown;
  } catch {
    emitDiagnostic("warning", "invalid_legacy_session", {}, logging);
    return null;
  }

  if (!isSessionRecord(parsed)) {
    return null;
  }

  const expiresAt = Date.parse(parsed.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    return null;
  }

  return parsed.user;
}

function importCompletionKey(subject: string): string {
  return `imports/${encodeURIComponent(subject)}`;
}

async function hasCompletedImport(env: Env, subject: string): Promise<boolean> {
  try {
    return (await env.SITE_STUDIO_BUCKET.get(importCompletionKey(subject))) !== null;
  } catch (error) {
    throw new SessionStoreUnavailableError("Import completion store unavailable", { cause: error });
  }
}

async function recordCompletedImport(env: Env, subject: string): Promise<void> {
  try {
    await env.SITE_STUDIO_BUCKET.put(
      importCompletionKey(subject),
      "",
      { onlyIf: { etagDoesNotMatch: "*" } }
    );
  } catch (error) {
    throw new SessionStoreUnavailableError("Import completion store unavailable", { cause: error });
  }
}

async function retireLegacySession(
  env: Env,
  sessionId: string | undefined,
): Promise<void> {
  if (!sessionId) return;
  try {
    await env.SITE_STUDIO_BUCKET.delete(`sessions/${sessionId}.json`);
  } catch (error) {
    throw new SessionStoreUnavailableError("Legacy import session could not be retired", {
      cause: error,
    });
  }
}

/**
 * First-login migration trigger. On an authenticated request that still
 * carries the pre-SSO anonymous session cookie, claim that anonymous
 * namespace for the subject and re-home its data. Independently, resume any
 * interrupted migration recorded under the subject (the anonymous cookie is
 * replaced by the subject cookie after the first request, so resumption must
 * not depend on it). Pure anonymous requests never reach this function.
 *
 * SS-3 / SS-19 — atomic mutual exclusion on the claim:
 * The "who may migrate this anon namespace" decision is settled by the
 * MigrationCoordinator Durable Object, keyed by `idFromName(anonId)`. Because a
 * DO runs single-threaded and every subject racing the SAME anon namespace
 * lands in the SAME DO instance, the claim calls SERIALIZE — the old KV
 * read-check-write could let two different subjects both read the claim as
 * empty and both migrate (split brain). The DO is now the AUTHORITATIVE first
 * gate: if `claim()` is not granted (a different subject already owns the anon
 * namespace) we SKIP migration entirely and never touch the data.
 *
 * The KV claim (`migration:<anonId>`) and subject-keyed resume marker
 * (`migration-pending:<subject>`) inside migrateAnonymousData are RETAINED, but
 * their role narrows: they are the resumability / step-idempotency layer, not a
 * second ownership authority. Only one subject can pass the DO gate, and only
 * that subject ever writes those KV records, so the two layers never disagree.
 * A migration that dies mid-run leaves the pending marker, and a later request
 * by the SAME (already-granted) subject resumes it — the DO grants that subject
 * a `resume` claim, and the KV records drive convergence (copy-if-absent,
 * deterministic renames).
 */
async function migrateAnonymousSessionIfPresent(
  c: Context<{ Bindings: Env; Variables: SessionVariables & LoggingVariables }>,
  subject: string,
  logging?: SiteStudioLoggingContext,
): Promise<boolean> {
  if (await hasCompletedImport(c.env, subject)) {
    return false;
  }

  const cookieValue = getCookie(c, SESSION_COOKIE_NAME) || "";

  const runMigration = async (anonUserId: string, anonSessionId?: string) => {
    const namespace = c.env.MUTATION_COORDINATOR;
    if (!namespace) throw new Error("MUTATION_COORDINATOR is not configured");
    return namespace.get(namespace.idFromName(`owner:${anonUserId}`))
      .migrateAnonymous(
        anonUserId,
        subject,
        anonSessionId,
        serializeSiteStudioLoggingContext(logging),
      );
  };

  if (cookieValue && cookieValue !== subject) {
    const anonUser = await readLegacySession(c.env, cookieValue, logging);
    // Only absorb a namespace when the presented cookie resolves to a live,
    // anonymous (`user_…`) legacy R2 session record. A random string, an expired
    // record, or a subject-owned record all fall through untouched.
    if (anonUser && anonUser.id.startsWith("user_")) {
      const anonId = anonUser.id;

      // ATOMIC FIRST GATE (SS-3): serialize all subjects racing this anon
      // namespace through the coordinator DO. `.get(idFromName(anonId))` routes
      // every claimant of THIS anon id to the one DO instance whose
      // single-threaded execution grants exactly one subject. A forged/replayed
      // cookie pointing at a namespace already owned by another subject is
      // refused here, before we touch any data.
      let decision: { granted: boolean };
      try {
        const stub = c.env.MIGRATION_COORDINATOR.get(
          c.env.MIGRATION_COORDINATOR.idFromName(anonId)
        );
        decision = await stub.claim(anonId, subject);
      } catch (error) {
        // SS-46 (fail CLOSED, loud): if the coordinator is unreachable we cannot
        // establish resumability for this still-unmigrated anon namespace, and we
        // never fall back to the racy KV-only path. Silently skipping here would
        // let the middleware overwrite the anon cookie with the subject cookie
        // and permanently orphan the data (no cookie, no pending marker), so
        // propagate as a storage outage: the request 503s and the user retries
        // with the anon cookie intact.
        throw new SessionStoreUnavailableError(
          `Migration claim gate unavailable for ${anonId} -> ${subject}`,
          { cause: error }
        );
      }

      if (!decision.granted) {
        // Another subject already owns this anon namespace. Do not absorb.
        await recordCompletedImport(c.env, subject);
        return false;
      }

      try {
        const result = await runMigration(anonId, cookieValue);
        if (result.status === "refused") {
          throw new SessionStoreUnavailableError("Import ownership claim was refused");
        }
        await retireLegacySession(c.env, cookieValue);
        await recordCompletedImport(c.env, subject);
      } catch (error) {
        // SS-46: a failure is only safe to absorb upstream once resumability is
        // established — the subject-keyed pending marker written at claim time.
        // If the failure predates the marker (e.g. the claim read/write hit a KV
        // outage), swallowing it would let the middleware replace the anon
        // cookie and orphan the namespace, so escalate to a storage outage.
        // The marker probe's own failure conservatively counts as "no marker".
        const marker = await c.env.SESSION_KV.get(migrationPendingKey(subject)).catch(() => null);
        if (!marker) {
          throw new SessionStoreUnavailableError(
            `Migration for ${anonId} -> ${subject} failed before it became resumable`,
            { cause: error }
          );
        }
        throw error;
      }

      // Flip the DO claim to complete (best-effort; the KV resume marker and
      // idempotent copy already make a missed completion safe to retry).
      try {
        const stub = c.env.MIGRATION_COORDINATOR.get(
          c.env.MIGRATION_COORDINATOR.idFromName(anonId)
        );
        await stub.markComplete(anonId, subject);
      } catch (error) {
        emitDiagnostic("warning", "migration_mark_complete_failed", {}, logging);
      }
      return true;
    }
  }

  let pendingAnonId: string | null;
  try {
    pendingAnonId = await c.env.SESSION_KV.get(migrationPendingKey(subject));
  } catch (error) {
    throw new SessionStoreUnavailableError("Import resume store unavailable", { cause: error });
  }
  if (pendingAnonId) {
    // Resume path: the subject already holds the DO claim (it was granted on the
    // first login that wrote this pending marker). Re-confirm the grant so a DO
    // that lost/expired state doesn't let a stranger resume, then finish the
    // interrupted run. The claim is idempotent for the owning subject (resume).
    let decision: { granted: boolean };
    try {
      const stub = c.env.MIGRATION_COORDINATOR.get(
        c.env.MIGRATION_COORDINATOR.idFromName(pendingAnonId)
      );
      decision = await stub.claim(pendingAnonId, subject);
    } catch (error) {
      throw new SessionStoreUnavailableError("Import resume gate unavailable", { cause: error });
    }
    if (!decision.granted) {
      throw new SessionStoreUnavailableError("Import resume claim was refused");
    }

    const result = await runMigration(pendingAnonId);
    if (result.status === "refused") {
      throw new SessionStoreUnavailableError("Import ownership claim was refused");
    }
    await recordCompletedImport(c.env, subject);

    try {
      const stub = c.env.MIGRATION_COORDINATOR.get(
        c.env.MIGRATION_COORDINATOR.idFromName(pendingAnonId)
      );
      await stub.markComplete(pendingAnonId, subject);
    } catch (error) {
      emitDiagnostic("warning", "migration_mark_complete_failed", {}, logging);
    }
    return true;
  }

  // This was the subject's first successful login and no resolvable legacy
  // source exists. Record that fact once so later requests do not keep probing
  // migration state or treat an unrelated old cookie as a new import source.
  await recordCompletedImport(c.env, subject);
  return false;
}

/**
 * Auth middleware for protected routes.
 *
 * Identity contract (docs/INTEGRATION.md §3):
 *   1. `X-CAIL-Identity-JWT` must verify as RS256 against
 *      `CAIL_IDENTITY_JWKS`; `CAIL_IDENTITY_PROFILE` selects a source-owned
 *      issuer and `CAIL_IDENTITY_ISSUER` must match it exactly for audience
 *      `cail:site-studio`. The durable owner
 *      key becomes the CAIL subject; the KV session is bound to that subject so
 *      the browser cookie remains a convenience affordance but never the source
 *      of ownership. Other bare X-CAIL-* headers are ignored — this worker is
 *      reachable on workers.dev, where anyone can set them.
 *   2. No identity → 401 `authentication_required`. Legacy sessions are data
 *      import sources only; they never authenticate a request.
 */
export const authMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: SessionVariables & LoggingVariables;
}>(async (c, next) => {
  const logging = getLoggingContext(c) ?? createSiteStudioBoundaryContext(c.env);
  const existingSessionId = c.get("sessionId") as string | undefined;
  const existingUser = c.get("user") as User | undefined;

  if (existingSessionId && existingUser) {
    await next();
    return;
  }

  const identityResolution = await resolveRequestIdentity(c.req.raw, c.env);

  // A presented credential must verify. Invalid tokens and missing or malformed
  // JWKS configuration reject.
  if (identityResolution.status === "invalid") {
    return cailAuthRequiredResponse();
  }

  if (identityResolution.status === "verified") {
    // Verified CAIL identity: own everything by the subject.
    const { identity, token } = identityResolution;
    c.set("cailIdentityJwt", token);

    // Keyring gateway leg (identity-keyring-v1): verified against the
    // gateway audience and bound to this request's subject before it may be
    // forwarded. A present-but-invalid leg fails the request closed.
    const gatewayLeg = await resolveKeyringGatewayJwt(
      c.req.raw,
      c.env,
      identity.subject
    );
    if (gatewayLeg === "invalid") {
      return cailAuthRequiredResponse();
    }
    if (gatewayLeg !== null) {
      c.set("cailGatewayJwt", gatewayLeg);
    }

    const subject = identity.subject;
    const identityLogging = withOperationalSubject(logging, identity.operationalSubject);

    // First-login migration: if this authenticated request still carries the
    // pre-SSO anonymous session cookie, claim that anonymous namespace for
    // this subject and re-home its data (lib/migration.ts). Also resume a
    // previously interrupted migration recorded under the subject.
    try {
      const imported = await migrateAnonymousSessionIfPresent(c, subject, identityLogging);
      if (imported) {
        emitDiagnostic("info", "account_import_completed", {}, identityLogging);
      }
    } catch (error) {
      // Never replace the legacy cookie after a failed import. A private 503
      // preserves both the source namespace and the subject-keyed resume marker
      // so the next successful login can retry the same idempotent copy.
      emitDiagnostic("error", "account_import_migration_failed", {}, identityLogging);
      return sessionStoreUnavailableResponse();
    }

    const kvKey = cailSessionKey(subject);
    // Safe to swallow: this read only recovers the original createdAt for the
    // refreshed session record. On a KV blip we fall back to now() — a cosmetic
    // timestamp reset, never an auth or identity decision.
    const stored = await c.env.SESSION_KV.get(kvKey, "json").catch(() => null);
    const createdAt =
      stored && typeof stored === "object" && typeof (stored as Record<string, unknown>).createdAt === "string"
        ? (stored as User).createdAt
        : new Date().toISOString();
    const user = userFromIdentity(identity, createdAt);

    // Refresh the subject-keyed session record (profile attrs may change).
    await c.env.SESSION_KV.put(kvKey, JSON.stringify(user), {
      expirationTtl: SESSION_TTL_SECONDS,
    });

    // The session id is the subject itself: ownership follows identity, not a
    // random cookie. We still set a cookie so same-browser requests that briefly
    // lack the gate-injected header stay bound to the same subject.
    //
    // Cookie posture (INTEGRATION.md §3¾ rule 7): HttpOnly + Secure +
    // SameSite=Strict, pinned by test. Path stays "/" because this worker owns
    // its whole origin on the Workers deployment; a tools.ailab path-prefix
    // deployment (siblings sharing the host) would want Path scoped under the
    // tool's prefix so sibling tools can't read or clobber it.
    setCookie(c, SESSION_COOKIE_NAME, subject, {
      httpOnly: true,
      maxAge: SESSION_TTL_SECONDS,
      path: "/",
      sameSite: "Strict",
      secure: new URL(c.req.url).protocol === "https:",
    });

    c.set("sessionId", subject);
    c.set("user", user);
    await next();
    return;
  }

  return cailAuthRequiredResponse();
});

/** The verified CAIL identity JWT for this request, if any (already verified). */
export function getCailIdentityJwt(c: { get: (key: "cailIdentityJwt") => string | undefined }): string | null {
  return c.get("cailIdentityJwt") ?? null;
}

/** The verified keyring gateway leg for this request, if delivered. */
export function getCailGatewayJwt(c: { get: (key: "cailGatewayJwt") => string | undefined }): string | null {
  return c.get("cailGatewayJwt") ?? null;
}

export function getUser(c: { get: (key: "user") => User }): User {
  return c.get("user");
}
