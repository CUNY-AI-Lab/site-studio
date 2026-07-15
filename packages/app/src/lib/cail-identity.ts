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
 * primitive. Site Studio accepts one contract: RS256, a public key selected
 * from `CAIL_IDENTITY_JWKS`, and the service-specific `cail:site-studio`
 * audience. The issuer must exactly match the deployment's single configured
 * `CAIL_IDENTITY_ISSUER`; production and staging trust are never combined. The stable
 * pseudonymous CAIL subject (`sub`) is the only durable key for workspace
 * ownership. Never key anything by email.
 */

import {
  verifyIdentityJwt,
  type CailIdentity,
} from "@cuny-ai-lab/cail-identity";

export type { CailIdentity };

export interface IdentityVerificationEnv {
  CAIL_IDENTITY_JWKS?: string;
  CAIL_IDENTITY_ISSUER?: string;
}

export type RequestIdentityResolution =
  | { status: "verified"; identity: CailIdentity; token: string }
  | { status: "absent" }
  | { status: "invalid" };

/** The header the SSO gate injects. Bare `X-CAIL-*` headers are never trusted. */
export const CAIL_IDENTITY_HEADER = "X-CAIL-Identity-JWT";
export const CAIL_IDENTITY_AUDIENCE = "cail:site-studio";

function parseJwks(raw: string | undefined): Parameters<typeof verifyIdentityJwt>[1] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Parameters<typeof verifyIdentityJwt>[1];
  } catch {
    return null;
  }
}

/**
 * Verify the canonical request identity. The raw token is returned with the
 * verified identity so downstream model calls forward the exact value.
 */
export async function resolveRequestIdentity(
  request: Request,
  env: IdentityVerificationEnv
): Promise<RequestIdentityResolution> {
  if (!request.headers.has(CAIL_IDENTITY_HEADER)) return { status: "absent" };

  const token = request.headers.get(CAIL_IDENTITY_HEADER)?.trim() ?? "";
  const jwks = parseJwks(env.CAIL_IDENTITY_JWKS);
  const issuer = env.CAIL_IDENTITY_ISSUER;
  if (!token || !jwks || typeof issuer !== "string" || issuer.length === 0 || issuer.trim() !== issuer) {
    return { status: "invalid" };
  }

  const identity = await verifyIdentityJwt(token, jwks, {
    expectedAudience: CAIL_IDENTITY_AUDIENCE,
    allowedIssuers: [issuer],
  });
  return identity
    ? { status: "verified", identity, token }
    : { status: "invalid" };
}

/**
 * Verify the selected CAIL identity carried on a request, if any. Returns the
 * identity or `null`; callers that must distinguish invalid credentials from absence
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
 * Flip `CAIL_REQUIRE_IDENTITY="true"` with JWKS verification configured at the same time the
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
