import { createMiddleware } from "hono/factory";
import { getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import type { Env, LegacySessionRecord, User } from "../types";
import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from "./constants";
import {
  cailAuthRequiredResponse,
  cailIdentityRequired,
  getRequestIdentity,
  type CailIdentity,
} from "./cail-identity";
import { migrateAnonymousData, migrationPendingKey } from "./migration";
import { createAgentHistoryPorter } from "./agent-porter";

type SessionVariables = {
  sessionId: string;
  user: User;
  /**
   * Raw, already-verified `X-CAIL-Identity-JWT` from the current request, when
   * present. Downstream handlers (routes/agents.ts) forward it to the CAIL model
   * proxy. Never a substitute for verification — it is only set after
   * `getRequestIdentity()` accepts the token.
   */
  cailIdentityJwt?: string;
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
  };
}

function sessionKey(sessionId: string): string {
  return `session:${sessionId}`;
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

async function readCurrentSession(env: Env, sessionId: string): Promise<User | null> {
  try {
    const fromKv = await env.SESSION_KV.get(sessionKey(sessionId), "json");
    if (fromKv && typeof fromKv === "object" && typeof (fromKv as Record<string, unknown>).id === "string") {
      return fromKv as User;
    }
  } catch (error) {
    console.warn(`Ignoring invalid KV session for ${sessionId}`, error);
  }

  const legacy = await env.SITE_STUDIO_BUCKET.get(`sessions/${sessionId}.json`);
  if (!legacy) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await legacy.text()) as unknown;
  } catch (error) {
    console.warn(`Ignoring invalid legacy session for ${sessionId}`, error);
    return null;
  }

  if (!isSessionRecord(parsed)) {
    return null;
  }

  if (Date.parse(parsed.expiresAt) < Date.now()) {
    return null;
  }

  await env.SESSION_KV.put(sessionKey(sessionId), JSON.stringify(parsed.user), {
    expirationTtl: SESSION_TTL_SECONDS
  });

  return parsed.user;
}

function createAnonymousUser(): User {
  return {
    id: `user_${crypto.randomUUID().replace(/-/g, "")}`,
    createdAt: new Date().toISOString()
  };
}

/**
 * First-login migration trigger. On an authenticated request that still
 * carries the pre-SSO anonymous session cookie, claim that anonymous
 * namespace for the subject and re-home its data. Independently, resume any
 * interrupted migration recorded under the subject (the anonymous cookie is
 * replaced by the subject cookie after the first request, so resumption must
 * not depend on it). Pure anonymous requests never reach this function.
 */
async function migrateAnonymousSessionIfPresent(
  c: Context<{ Bindings: Env; Variables: SessionVariables }>,
  subject: string
): Promise<void> {
  const porter = createAgentHistoryPorter(c.env);
  const cookieValue = getCookie(c, SESSION_COOKIE_NAME) || "";

  if (cookieValue && cookieValue !== subject) {
    const anonUser = await readCurrentSession(c.env, cookieValue);
    if (anonUser && anonUser.id.startsWith("user_")) {
      await migrateAnonymousData({
        bucket: c.env.SITE_STUDIO_BUCKET,
        kv: c.env.SESSION_KV,
        anonUserId: anonUser.id,
        subject,
        anonSessionId: cookieValue,
        porter,
      });
      return;
    }
  }

  const pendingAnonId = await c.env.SESSION_KV.get(migrationPendingKey(subject)).catch(() => null);
  if (pendingAnonId) {
    await migrateAnonymousData({
      bucket: c.env.SITE_STUDIO_BUCKET,
      kv: c.env.SESSION_KV,
      anonUserId: pendingAnonId,
      subject,
      porter,
    });
  }
}

/**
 * Auth middleware for protected routes.
 *
 * Identity precedence (docs/INTEGRATION.md §3):
 *   1. A verified `X-CAIL-Identity-JWT` (from the SSO gate) wins. The durable
 *      owner key becomes the CAIL subject; the KV session is bound to that
 *      subject so the browser cookie remains a convenience affordance but never
 *      the source of ownership. Bare X-CAIL-* headers are ignored — this worker
 *      is reachable on workers.dev, where anyone can set them.
 *   2. No/invalid identity + CAIL_REQUIRE_IDENTITY="true" → 401
 *      `authentication_required` envelope (this is a protected kind=api route;
 *      browsers redirect to /login?rt=…).
 *   3. No/invalid identity + not required → anonymous KV session
 *      (pre-SSO-rollout behavior, unchanged).
 */
export const authMiddleware = createMiddleware<{ Bindings: Env; Variables: SessionVariables }>(async (c, next) => {
  const existingSessionId = c.get("sessionId") as string | undefined;
  const existingUser = c.get("user") as User | undefined;

  if (existingSessionId && existingUser) {
    await next();
    return;
  }

  const identity = await getRequestIdentity(c.req.raw, c.env);

  if (identity) {
    // Verified CAIL identity: own everything by the subject.
    const rawJwt = c.req.raw.headers.get("X-CAIL-Identity-JWT");
    if (rawJwt) {
      c.set("cailIdentityJwt", rawJwt);
    }

    const subject = identity.subject;

    // First-login migration: if this authenticated request still carries the
    // pre-SSO anonymous session cookie, claim that anonymous namespace for
    // this subject and re-home its data (lib/migration.ts). Also resume a
    // previously interrupted migration recorded under the subject. Failures
    // never block authentication — the pending marker makes them retryable.
    try {
      await migrateAnonymousSessionIfPresent(c, subject);
    } catch (error) {
      console.error(`Anonymous-data migration failed for ${subject}`, error);
    }

    const kvKey = cailSessionKey(subject);
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

  // No verified identity. Fail closed when enforcement is on.
  if (cailIdentityRequired(c.env)) {
    return cailAuthRequiredResponse();
  }

  // Anonymous fallback (pre-SSO-rollout). Unchanged from the original flow.
  let sessionId = getCookie(c, SESSION_COOKIE_NAME) || "";
  let user: User | null = null;

  if (sessionId) {
    user = await readCurrentSession(c.env, sessionId);
  }

  if (!user) {
    sessionId = crypto.randomUUID().replace(/-/g, "");
    user = createAnonymousUser();
    await c.env.SESSION_KV.put(sessionKey(sessionId), JSON.stringify(user), {
      expirationTtl: SESSION_TTL_SECONDS
    });

    setCookie(c, SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      maxAge: SESSION_TTL_SECONDS,
      path: "/",
      sameSite: "Strict",
      secure: new URL(c.req.url).protocol === "https:"
    });
  }

  c.set("sessionId", sessionId);
  c.set("user", user);
  await next();
});

/** The verified CAIL identity JWT for this request, if any (already verified). */
export function getCailIdentityJwt(c: { get: (key: "cailIdentityJwt") => string | undefined }): string | null {
  return c.get("cailIdentityJwt") ?? null;
}

export function getUser(c: { get: (key: "user") => User }): User {
  return c.get("user");
}
