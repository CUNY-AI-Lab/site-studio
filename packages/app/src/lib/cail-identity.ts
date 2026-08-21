/**
 * CAIL gateway identity (CUNYLogin SSO) for the site-studio-app worker.
 *
 * CAIL Doorway authenticates the browser and injects identity JWT headers on
 * each request it forwards. This worker is also directly reachable on its
 * workers.dev URL, so bare `X-CAIL-*` headers prove nothing — anyone can set
 * them. Identity is accepted only from the verified JWT.
 *
 * JWT verification is delegated to the shared `@cuny-ai-lab/cail-identity`
 * primitive. Site Studio accepts one contract: RS256, a public key selected
 * from `CAIL_IDENTITY_JWKS`, and the service-specific `cail:site-studio`
 * audience. The deployment issuer must match CAIL's one canonical standalone
 * Doorway issuer and cannot define a new trust root.
 * The stable pseudonymous CAIL subject (`sub`) is the only durable key for workspace
 * ownership. Never key anything by email.
 */

import {
  CAIL_CANONICAL_ISSUER,
  CAIL_GATEWAY_AUDIENCE,
  createCailAuthError,
  readIdentityKeyring,
  serializeCailAuthError,
  verifyKeyringGatewayJwt,
  type CailIdentity,
  type IdentityVerifierConfig,
  loadIdentityVerifierConfig,
  verifyIdentityJwt,
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
export const SITE_STUDIO_LAUNCH_PATH = "/launch/site-studio" as const;

/**
 * cail-identity 5.2.5 validates the canonical issuer, audience, and every JWKS key
 * once and returns a frozen snapshot. The snapshot is cached per (jwks, issuer)
 * so a request does not re-import keys; a configuration failure yields `null`
 * here and an "invalid" resolution, never a silently anonymous request.
 */
// Bounded: each entry strongly retains imported CryptoKeys for a whole JWKS,
// and an isolate can survive repeated key rotations, so an unbounded map would
// accumulate every historical key set. Two entries cover the rotation overlap
// (old and new) that the identity contract's kid-overlap procedure requires.
const VERIFIER_CACHE_MAX = 2;
const verifierCache = new Map<string, IdentityVerifierConfig>();

async function loadVerifier(
  env: IdentityVerificationEnv,
  audience: string = CAIL_IDENTITY_AUDIENCE
): Promise<IdentityVerifierConfig | null> {
  const jwks = env.CAIL_IDENTITY_JWKS;
  if (!jwks || env.CAIL_IDENTITY_ISSUER !== CAIL_CANONICAL_ISSUER) return null;
  const issuer = CAIL_CANONICAL_ISSUER;
  const key = `${audience}\u0000${issuer}\u0000${jwks}`;
  const cached = verifierCache.get(key);
  if (cached) return cached;
  const loaded = await loadIdentityVerifierConfig({
    jwks,
    issuer,
    expectedAudience: audience,
  });
  if (!loaded.ok) return null;
  if (verifierCache.size >= VERIFIER_CACHE_MAX) {
    const oldest = verifierCache.keys().next().value;
    if (oldest !== undefined) verifierCache.delete(oldest);
  }
  verifierCache.set(key, loaded.config);
  return loaded.config;
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
  if (!token) return { status: "invalid" };
  const config = await loadVerifier(env);
  if (!config) return { status: "invalid" };

  const identity = await verifyIdentityJwt(token, config);
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
 * The CAIL `authentication_required` envelope (docs/INTEGRATION.md §2), returned
 * verbatim so the frontend treats worker-issued and gate-issued 401s alike and
 * redirects to the protected Doorway Site Studio path.
 */
export function cailAuthRequiredResponse(): Response {
  const body = createCailAuthError(
    "authentication_required",
    "Please sign in to continue.",
    SITE_STUDIO_LAUNCH_PATH,
  );
  return new Response(
    serializeCailAuthError(body),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer realm="CAIL"',
        "Cache-Control": "no-store",
      },
    }
  );
}


/**
 * Resolve the keyring gateway leg (identity-keyring-v1) for a request whose
 * app leg already verified: full verification against the cail:gateway
 * audience plus subject agreement. Returns the token to forward, null when
 * absent, or "invalid" (callers fail closed).
 */
export async function resolveKeyringGatewayJwt(
  request: Request,
  env: IdentityVerificationEnv,
  verifiedSubject: string,
): Promise<string | null | "invalid"> {
  const keyring = readIdentityKeyring(request.headers);
  if (keyring === null) return "invalid";
  if (keyring.gatewayJwt === undefined) return null;
  const loaded = await loadVerifier(env, CAIL_GATEWAY_AUDIENCE);
  if (loaded === null) return "invalid";
  const identity = await verifyKeyringGatewayJwt(keyring, loaded, verifiedSubject);
  return identity === null ? "invalid" : keyring.gatewayJwt;
}
