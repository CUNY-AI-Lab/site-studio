/**
 * CAIL gateway identity (CUNYLogin SSO) for the site-studio-app worker.
 *
 * The OpenResty SSO gate on tools.ailab.gc.cuny.edu authenticates the browser
 * and injects identity JWT headers on each request it forwards
 * (see the cail-gateway repo: docs/INTEGRATION.md §3, gateway/README.md
 * "Identity contract"). This worker is ALSO directly reachable on its
 * workers.dev URL, so bare `X-CAIL-*` headers prove nothing — anyone can set
 * them. Identity is accepted ONLY from the verified JWT.
 *
 * JWT verification is delegated to the shared `@cuny-ai-lab/cail-identity`
 * primitive. V1 pins HS256 and the legacy `cail-internal` audience. V2 pins
 * RS256, selects a public key from the configured JWKS, and requires the
 * service-specific `cail:site-studio` audience. Both exact-match `iss` against
 * the allowlist below. The stable pseudonymous CAIL subject (`sub`) is the only
 * durable key for workspace ownership. Never key anything by email.
 *
 * V2 is authoritative when its header is present: malformed/missing JWKS or an
 * invalid V2 token rejects the request, with no V1 fallback. When V2 is absent,
 * the existing V1 behavior is unchanged.
 */

import {
  verifyIdentityJwt,
  verifyIdentityJwtV2,
  CAIL_CANONICAL_ISSUER,
  CAIL_STAGING_ISSUER,
  type CailIdentity,
} from "@cuny-ai-lab/cail-identity";

export type { CailIdentity };

export interface IdentityVerificationEnv {
  CAIL_IDENTITY_JWT_SECRET?: string;
  CAIL_IDENTITY_JWKS?: string;
}

export type RequestIdentityResolution =
  | { status: "verified"; identity: CailIdentity; token: string; version: "v1" | "v2" }
  | { status: "absent" }
  | { status: "invalid" };

/**
 * Issuers this worker accepts. EXACT-match allowlist (not a suffix check):
 * production `tools.ailab.gc.cuny.edu` and staging `tools.cuny.qzz.io`. Any
 * other `iss` is rejected. An empty allowlist would reject every token.
 */
const ALLOWED_ISSUERS = [CAIL_CANONICAL_ISSUER, CAIL_STAGING_ISSUER];

/** The header the SSO gate injects. Bare `X-CAIL-*` headers are never trusted. */
export const CAIL_IDENTITY_HEADER = "X-CAIL-Identity-JWT";
export const CAIL_IDENTITY_V2_HEADER = "X-CAIL-Identity-JWT-V2";
export const CAIL_IDENTITY_V2_AUDIENCE = "cail:site-studio";

function parseJwks(raw: string | undefined): Parameters<typeof verifyIdentityJwtV2>[1] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Parameters<typeof verifyIdentityJwtV2>[1];
  } catch {
    return null;
  }
}

/** True when either generation of identity verification material is present. */
export function cailIdentityConfigured(env: IdentityVerificationEnv): boolean {
  return Boolean(env.CAIL_IDENTITY_JWT_SECRET || env.CAIL_IDENTITY_JWKS);
}

/**
 * Select and verify the request identity while preserving strict V2
 * precedence. The selected raw token is returned with the normalized identity
 * so downstream model calls cannot accidentally re-read a stale V1 header.
 */
export async function resolveRequestIdentity(
  request: Request,
  env: IdentityVerificationEnv
): Promise<RequestIdentityResolution> {
  if (request.headers.has(CAIL_IDENTITY_V2_HEADER)) {
    const token = request.headers.get(CAIL_IDENTITY_V2_HEADER)?.trim() ?? "";
    const jwks = parseJwks(env.CAIL_IDENTITY_JWKS);
    if (!token || !jwks) return { status: "invalid" };

    const identity = await verifyIdentityJwtV2(token, jwks, {
      expectedAudience: CAIL_IDENTITY_V2_AUDIENCE,
      allowedIssuers: ALLOWED_ISSUERS,
    });
    return identity
      ? { status: "verified", identity, token, version: "v2" }
      : { status: "invalid" };
  }

  const secret = env.CAIL_IDENTITY_JWT_SECRET;
  const token = request.headers.get(CAIL_IDENTITY_HEADER)?.trim() ?? "";
  if (!secret || !token) return { status: "absent" };

  const identity = await verifyIdentityJwt(token, secret, { allowedIssuers: ALLOWED_ISSUERS });
  return identity
    ? { status: "verified", identity, token, version: "v1" }
    : { status: "absent" };
}

/**
 * Verify the selected CAIL identity carried on a request, if any. Returns the
 * identity or `null`; callers that must distinguish invalid V2 from absence
 * use `resolveRequestIdentity`. Never throws.
 */
export async function getRequestIdentity(
  request: Request,
  env: IdentityVerificationEnv
): Promise<CailIdentity | null> {
  const resolution = await resolveRequestIdentity(request, env);
  return resolution.status === "verified" ? resolution.identity : null;
}

/**
 * True when the worker must reject anonymous requests to protected routes (401).
 * Flip `CAIL_REQUIRE_IDENTITY="true"` (with V1 or V2 verification configured) at the same time the
 * gateway lands `CAIL_SSO_MODE=enforce` — otherwise the workers.dev URL stays an
 * anonymous bypass around SSO and budgets. If the flag is on but verification
 * material is missing or malformed, protected routes close by misconfiguration.
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
