import { createMiddleware } from "hono/factory";
import { deleteCookie, getCookie } from "hono/cookie";
import type { Context } from "hono";
import type { Env, User } from "../types";
import { SESSION_COOKIE_NAME } from "./constants";
import {
  cailAuthRequiredResponse,
  resolveKeyringGatewayJwt,
  resolveRequestIdentity,
  type CailIdentity,
} from "./cail-identity";
import { hasCompletedImport } from "./anonymous-import";
import {
  emitDiagnostic,
  createSiteStudioBoundaryContext,
  getLoggingContext,
  serializeSiteStudioLoggingContext,
  type LoggingVariables,
  type SiteStudioLoggingContext,
  withOperationalSubject,
} from "./logging";

export type SessionVariables = {
  sessionId: string;
  user: User;
  /**
   * Raw, already-verified selected identity JWT from the current request.
   * Downstream handlers forward this exact token to the CAIL model proxy.
   */
  cailIdentityJwt?: string;
  cailGatewayJwt?: string;
};

// Keep the import-store error available to callers that classify session
// boundary failures; the import state machine owns its definition.
export { SessionStoreUnavailableError } from "./anonymous-import";

function userFromIdentity(identity: CailIdentity, createdAt: string): User {
  const user: User = {
    id: identity.subject,
    createdAt,
    cail: true,
    email: identity.email,
    name: identity.name,
  };
  // Separately keyed log subject; never derived from `id`.
  if (identity.operationalSubject !== undefined) {
    user.operationalSubject = identity.operationalSubject;
  }
  return user;
}

/** SS-46: retryable 503 for a session-store outage. Never "record absent". */
function sessionStoreUnavailableResponse(): Response {
  return new Response(
    JSON.stringify({
      error: "session_store_unavailable",
      message: "Site Studio is having trouble right now. Try again in a moment.",
    }),
    {
      status: 503,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": "5",
      },
    },
  );
}

/** Expire only the old root-scoped import cookie after a completed first login. */
function clearLegacyImportCookie(
  c: Context<{ Bindings: Env; Variables: SessionVariables & LoggingVariables }>,
): void {
  deleteCookie(c, SESSION_COOKIE_NAME, {
    httpOnly: true,
    path: "/",
    sameSite: "Strict",
    secure: new URL(c.req.url).protocol === "https:",
  });
}

/**
 * First-login migration trigger. The subject-keyed MutationCoordinator owns
 * unresolved import selection: it reserves a source before the anonymous
 * claim/copy begins, then calls the distinct anonymous-owner queue. This keeps
 * an admitted source selected across failed copies and prevents a queued
 * no-cookie or alternate-cookie request from closing/replacing it.
 */
async function migrateAnonymousSessionIfPresent(
  c: Context<{ Bindings: Env; Variables: SessionVariables & LoggingVariables }>,
  subject: string,
  logging?: SiteStudioLoggingContext,
): Promise<"imported" | "closed"> {
  // Completed imports are immutable and need not wait behind the owner's
  // mutation queue. The same check remains inside the queue to cover a marker
  // written between this fast path and RPC admission.
  if (await hasCompletedImport(c.env, subject)) return "closed";

  const namespace = c.env.MUTATION_COORDINATOR;
  if (!namespace) throw new Error("MUTATION_COORDINATOR is not configured");
  return namespace
    .get(namespace.idFromName(`owner:${subject}`))
    .migrateAnonymousForSubject(
      subject,
      getCookie(c, SESSION_COOKIE_NAME) || "",
      serializeSiteStudioLoggingContext(logging),
    );
}

/**
 * Auth middleware for protected routes.
 *
 * Identity contract (docs/security-and-recovery.md, identity and ownership):
 *   1. `X-CAIL-Identity-JWT` must verify as RS256 against
 *      `CAIL_IDENTITY_JWKS`; `CAIL_IDENTITY_ISSUER` must match CAIL's
 *      canonical issuer exactly for audience `cail:site-studio`. The durable
 *      owner key becomes the CAIL subject.
 *      The legacy cookie is an import source only; no subject-keyed session
 *      cookie or KV record is issued or consulted for authentication. Other
 *      bare X-CAIL-* headers are ignored — this worker is
 *      reachable on workers.dev, where anyone can set them.
 *   2. No identity → 401 `authentication_required`. The one preceding
 *      exception is the validated, read-only preview capability. Legacy
 *      sessions are data import sources only; they never authenticate a request.
 */
export const authMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: SessionVariables & LoggingVariables;
}>(async (c, next) => {
  const logging = getLoggingContext(c) ?? createSiteStudioBoundaryContext(c.env);
  const existingSessionId = c.get("sessionId");
  const existingUser = c.get("user");

  // Preview assets have a separate, short-lived project capability. No other
  // session state may bypass verified identity authentication.
  if (existingSessionId === "preview-token" && existingUser) {
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
      identity.subject,
    );
    if (gatewayLeg === "invalid") {
      return cailAuthRequiredResponse();
    }
    if (gatewayLeg !== null) {
      c.set("cailGatewayJwt", gatewayLeg);
    }

    const subject = identity.subject;
    const identityLogging = withOperationalSubject(logging, identity.operationalSubject);
    const hadLegacyCookie = Boolean(getCookie(c, SESSION_COOKIE_NAME));

    // First-login migration: unresolved selection and resume run through the
    // subject owner gate. A failed import returns before cookie retirement.
    try {
      const importOutcome = await migrateAnonymousSessionIfPresent(c, subject, identityLogging);
      if (importOutcome === "imported") {
        emitDiagnostic("info", "account_import_completed", {}, identityLogging);
      }
    } catch {
      // Never replace the legacy cookie after a failed import. A private 503
      // preserves both the source namespace and the subject-keyed resume state
      // so the next successful login can retry the same idempotent copy.
      emitDiagnostic("error", "account_import_migration_failed", {}, identityLogging);
      return sessionStoreUnavailableResponse();
    }

    // The legacy cookie is only an import source. Clear it after a successful
    // import or the no-source first-login close; failures return above.
    if (hadLegacyCookie) clearLegacyImportCookie(c);

    const user = userFromIdentity(identity, new Date().toISOString());
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
