import { createMiddleware } from "hono/factory";
import { setCookie } from "hono/cookie";
import type { Context, Env as HonoEnv } from "hono";
import type { Env, User } from "../types";
import { CSRF_COOKIE_NAME, SESSION_TTL_SECONDS } from "./constants";

/**
 * CSRF protection per docs/INTEGRATION.md §3¾ ("CSRF for gated tools").
 *
 * Threat model recap: the SSO gate authenticates browsers with an ambient
 * SameSite=Lax cookie, so a forged cross-site request can arrive already
 * carrying valid gate-injected identity. Sibling tools on the same host are
 * same-origin, so origin posture alone cannot separate them — only the
 * per-tool token (rule 3) can. Rules implemented here:
 *
 *   Rule 2 — origin-check every state-changing route (Sec-Fetch-Site
 *            preferred, Origin fallback; both-absent falls through to the
 *            token, never to "trust").
 *   Rule 3 — require the per-session X-CAIL-CSRF token on every mutation.
 *
 * No Authorization / sk-cail exemption exists here on purpose: the contract's
 * "pure API clients authenticating with `Authorization: Bearer sk-cail-…`"
 * carve-out does not apply to Site Studio, because Site Studio's session
 * routes never authenticate by API key — identity comes only from the
 * gate-injected JWT or the session cookie, both of which are ambient
 * browser credentials, so every mutation must pass the token check.
 */

export const CSRF_HEADER_NAME = "X-CAIL-CSRF";

/** Exact 403 body for every CSRF rejection (shared contract with the frontend). */
export const CSRF_ERROR_BODY = {
  error: "csrf_verification_failed",
  message: "This request was blocked because it did not come from Site Studio. Refresh the page and try again."
} as const;

/**
 * KV key for the per-session CSRF token. Keyed by the session's durable user
 * id. Judgment call vs. the contract's "keyed by X-CAIL-Subject": when the
 * request carries a verified CAIL identity the durable id IS the subject
 * (`cail-…`); anonymous pre-SSO sessions have no subject, so their anonymous
 * `user_…` id stands in. Same key space, same lifetime as the session record.
 */
function csrfTokenKey(userId: string): string {
  return `csrf:${userId}`;
}

/** Mint 32 random bytes as lowercase hex (64 chars). */
function mintToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Look up the session's CSRF token without minting one. */
export async function getCsrfToken(kv: KVNamespace, userId: string): Promise<string | null> {
  const stored = await kv.get(csrfTokenKey(userId));
  return typeof stored === "string" && stored.length > 0 ? stored : null;
}

/**
 * Lazily mint the session's CSRF token, persisting it in KV so it is stable
 * across requests for the session's life (same TTL as the session record).
 */
export async function getOrMintCsrfToken(kv: KVNamespace, userId: string): Promise<string> {
  const existing = await getCsrfToken(kv, userId);
  if (existing) {
    return existing;
  }

  const token = mintToken();
  await kv.put(csrfTokenKey(userId), token, { expirationTtl: SESSION_TTL_SECONDS });
  return token;
}

/**
 * Deliver the KV token to page JS via a cookie (INTEGRATION.md §3¾ rule 3
 * "Delivery"). The token must NEVER appear in a response body — a same-origin
 * sibling or student-authored /sites/ script could fetch GET /api/csrf with the
 * ambient session cookie and read a JSON token straight out of the body,
 * defeating rule 3. A path-scoped cookie is the one same-origin-proof channel:
 * browsers only expose a cookie to pages under its Path.
 *
 * Attributes:
 *  - name `cail_csrf_sitestudio`, value = the KV token.
 *  - Path = CSRF_COOKIE_PATH (default "/"). At a shared-host launch set this to
 *    the tool's own prefix so siblings/published-site JS can't read the cookie.
 *  - Secure (dev-aware, matching lib/session.ts: only over https), SameSite=Lax
 *    (per contract — Lax here, not the session cookie's Strict, so a top-level
 *    navigation into the SPA still carries it), and NOT HttpOnly so page JS can
 *    read it via document.cookie. This is stateful double-submit: the server
 *    still verifies the request header against the KV token, so a readable
 *    cookie does not weaken the check — a sibling that plants its own
 *    cookie+header pair still can't produce the real KV token.
 */
export function setCsrfCookie<E extends HonoEnv & { Bindings: Env }>(
  c: Context<E>,
  token: string
): void {
  setCookie(c, CSRF_COOKIE_NAME, token, {
    httpOnly: false,
    maxAge: SESSION_TTL_SECONDS,
    path: c.env.CSRF_COOKIE_PATH || "/",
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:"
  });
}

/**
 * Constant-time string comparison. Always scans the full presented string so
 * the comparison time does not leak the position of the first mismatch.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);

  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < aBytes.length; i += 1) {
    diff |= aBytes[i] ^ bBytes[i % Math.max(bBytes.length, 1)];
  }
  return diff === 0;
}

function tokenMatches(presented: string | null, expected: string | null): boolean {
  return !!presented && !!expected && timingSafeEqual(presented, expected);
}

/** APP_PUBLIC_DOMAIN normalized to an origin string, or null when unset/unparseable. */
function appPublicOrigin(appPublicDomain: string | undefined): string | null {
  if (!appPublicDomain) {
    return null;
  }
  try {
    return new URL(appPublicDomain).origin;
  } catch {
    return null;
  }
}

export type CsrfRequestFacts = {
  /** `Sec-Fetch-Site` header value, or null when absent. */
  secFetchSite: string | null;
  /** `Origin` header value, or null when absent. */
  origin: string | null;
  /** The request's own serving origin (from the request URL). */
  requestOrigin: string;
  /** env.APP_PUBLIC_DOMAIN (may be a full URL; normalized to an origin). */
  appPublicDomain?: string;
  /** Token presented by the caller (header or WS query param). */
  presentedToken: string | null;
  /** Token stored for this session in KV, or null when never minted. */
  expectedToken: string | null;
};

/**
 * Rules 2 + 3 as one decision. Both must pass:
 *
 * Rule 3 (always): the request must present a token matching the session's
 * stored token (constant-time). Missing/mismatched/never-minted → reject.
 *
 * Rule 2 (layered on top):
 *  - `Sec-Fetch-Site` present → only `same-origin` is accepted. `same-site`,
 *    `cross-site`, and `none` are rejected EVEN WITH a valid Origin header
 *    (2026-07-05 clarification: rejecting `same-site` is required by rule 2,
 *    not extra strictness — same-site means cross-origin within the
 *    registrable domain, and its Origin can never equal the canonical one).
 *  - `Sec-Fetch-Site` absent but `Origin` present → Origin must exactly equal
 *    the request's own serving origin or APP_PUBLIC_DOMAIN.
 *  - Both absent (non-browser client) → the token alone decides; never
 *    trust-by-default.
 */
export function csrfDecision(facts: CsrfRequestFacts): boolean {
  // Rule 3 first: the token is mandatory in every posture.
  if (!tokenMatches(facts.presentedToken, facts.expectedToken)) {
    return false;
  }

  // Rule 2: origin posture.
  const secFetchSite = facts.secFetchSite?.trim().toLowerCase() || null;
  if (secFetchSite !== null) {
    return secFetchSite === "same-origin";
  }

  if (facts.origin !== null) {
    const canonical = appPublicOrigin(facts.appPublicDomain);
    return facts.origin === facts.requestOrigin || (!!canonical && facts.origin === canonical);
  }

  // Both origin signals absent: rule-3 token (already verified) decides.
  return true;
}

type ContextLike = {
  req: { header: (name: string) => string | undefined; url: string };
  env: Env;
};

/**
 * Verify a state-changing HTTP request against rules 2 + 3. `token` is the
 * session's stored token (from `getCsrfToken`); pass null when none exists.
 */
export function verifyCsrf(c: ContextLike, opts: { token: string | null }): boolean {
  return csrfDecision({
    secFetchSite: c.req.header("Sec-Fetch-Site") ?? null,
    origin: c.req.header("Origin") ?? null,
    requestOrigin: new URL(c.req.url).origin,
    appPublicDomain: c.env.APP_PUBLIC_DOMAIN,
    presentedToken: c.req.header(CSRF_HEADER_NAME) ?? null,
    expectedToken: opts.token
  });
}

/**
 * Rule 4 decision for a WebSocket upgrade (routes/agents.ts). The token
 * arrives as `?csrf=` on the upgrade URL (browsers cannot set custom headers
 * on WS handshakes). Origin posture: browsers always send `Origin` on WS
 * upgrades, so a present-but-foreign Origin is rejected even with a valid
 * token; an absent Origin (non-browser test client) is accepted only because
 * the valid token already proves first-party provenance.
 */
export function verifyWsUpgrade(facts: {
  origin: string | null;
  requestOrigin: string;
  appPublicDomain?: string;
  presentedToken: string | null;
  expectedToken: string | null;
}): boolean {
  if (!tokenMatches(facts.presentedToken, facts.expectedToken)) {
    return false;
  }

  if (facts.origin !== null) {
    const canonical = appPublicOrigin(facts.appPublicDomain);
    return facts.origin === facts.requestOrigin || (!!canonical && facts.origin === canonical);
  }

  return true;
}

/**
 * Method-scoped CSRF middleware: no-ops on GET/HEAD/OPTIONS (reads stay open,
 * CORS preflights must pass), enforces rules 2 + 3 on everything else. Mounted
 * once on `/api/*` (after authMiddleware) so newly added mutation routes are
 * covered by default rather than opted in one by one.
 */
export const csrfProtect = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    await next();
    return;
  }

  // The session user is set by authMiddleware upstream. A mutation path with
  // no session in scope has no token to verify against and fails closed.
  const user = (c as unknown as { get: (key: string) => unknown }).get("user") as User | undefined;
  const expected = user ? await getCsrfToken(c.env.SESSION_KV, user.id) : null;

  if (!verifyCsrf(c, { token: expected })) {
    return c.json(CSRF_ERROR_BODY, 403);
  }

  await next();
});
