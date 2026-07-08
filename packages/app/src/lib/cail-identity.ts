/**
 * CAIL gateway identity (CUNYLogin SSO) for the site-studio-app worker.
 *
 * The OpenResty SSO gate on tools.ailab.gc.cuny.edu authenticates the browser
 * and injects an `X-CAIL-Identity-JWT` header on each request it forwards
 * (see the cail-gateway repo: docs/INTEGRATION.md §3, gateway/README.md
 * "Identity contract"). This worker is ALSO directly reachable on its
 * workers.dev URL, so bare `X-CAIL-*` headers prove nothing — anyone can set
 * them. Identity is accepted ONLY from the verified JWT.
 *
 * JWT verification is delegated to the shared `@cuny-ai-lab/cail-identity`
 * primitive (one source of truth across the CAIL fleet; the same verifier the
 * model-proxy uses). The primitive pins HS256, enforces `exp`/`nbf` with a
 * clock tolerance, requires `aud === "cail-internal"`, and EXACT-matches `iss`
 * against an explicit allowlist — see the allowlist passed at the call site
 * below. The stable pseudonymous CAIL subject (`sub`, "cail-<hex>") is the only
 * durable key for workspace ownership. Never key anything by email.
 *
 * The shared secret arrives as the `CAIL_IDENTITY_JWT_SECRET` wrangler secret
 * (ops-managed; never in code). If it is unset, identity is disabled and every
 * request is anonymous (pre-rollout behavior).
 */

import {
  verifyIdentityJwt,
  CAIL_CANONICAL_ISSUER,
  CAIL_STAGING_ISSUER,
  type CailIdentity,
} from "@cuny-ai-lab/cail-identity";

export type { CailIdentity };

/**
 * Issuers this worker accepts. EXACT-match allowlist (not a suffix check):
 * production `tools.ailab.gc.cuny.edu` and staging `tools.cuny.qzz.io`. Any
 * other `iss` is rejected. An empty allowlist would reject every token.
 */
const ALLOWED_ISSUERS = [CAIL_CANONICAL_ISSUER, CAIL_STAGING_ISSUER];

/** The header the SSO gate injects. Bare `X-CAIL-*` headers are never trusted. */
export const CAIL_IDENTITY_HEADER = "X-CAIL-Identity-JWT";

/**
 * Verify the CAIL identity carried on a request, if any. Returns the identity,
 * or `null` when the request is anonymous, the token is invalid/expired, or the
 * shared secret is not configured. Never throws.
 */
export async function getRequestIdentity(
  request: Request,
  env: { CAIL_IDENTITY_JWT_SECRET?: string }
): Promise<CailIdentity | null> {
  const secret = env.CAIL_IDENTITY_JWT_SECRET;
  if (!secret) return null;
  const token = request.headers.get(CAIL_IDENTITY_HEADER);
  if (!token) return null;
  return verifyIdentityJwt(token, secret, { allowedIssuers: ALLOWED_ISSUERS });
}

/**
 * True when the worker must reject anonymous requests to protected routes (401).
 * Flip `CAIL_REQUIRE_IDENTITY="true"` (with the secret set) at the same time the
 * gateway lands `CAIL_SSO_MODE=enforce` — otherwise the workers.dev URL stays an
 * anonymous bypass around SSO and budgets. If the flag is on but the secret is
 * missing, every identity check fails and protected routes close — never open —
 * by misconfiguration (fail closed).
 */
export function cailIdentityRequired(env: { CAIL_REQUIRE_IDENTITY?: string }): boolean {
  return env.CAIL_REQUIRE_IDENTITY === "true";
}

/**
 * The CAIL `authentication_required` envelope (docs/INTEGRATION.md §2), returned
 * verbatim so the frontend treats worker-issued and gate-issued 401s alike and
 * redirects to `/login?rt=<current-path>`.
 */
export function cailAuthRequiredResponse(): Response {
  return new Response(
    JSON.stringify({
      error: "authentication_required",
      message:
        "Sign in with CUNY Login to use Site Studio.",
      login_url: "/login",
    }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer realm="CAIL"',
      },
    }
  );
}
