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
 * Contract (must match key-service/src/identity.ts and
 * cloudflare/workers/shared/utils/cail-identity.ts):
 *   - HS256, algorithm PINNED (never let the token pick it)
 *   - aud === "cail-internal"
 *   - iss ends with "/cail-sso"
 *   - exp enforced (the gate mints short-lived tokens, CAIL_IDENTITY_JWT_TTL,
 *     currently 300s)
 *   - sub is the stable pseudonymous CAIL subject ("cail-<hex>") — the only
 *     durable key for workspace ownership. Never key anything by email.
 *
 * The shared secret arrives as the `CAIL_IDENTITY_JWT_SECRET` wrangler secret
 * (ops-managed; never in code). If it is unset, identity is disabled and every
 * request is anonymous (pre-rollout behavior).
 */

export interface CailIdentity {
  /** Stable pseudonymous CAIL subject, e.g. "cail-<hex>". Durable owner key. */
  subject: string;
  email?: string;
  name?: string;
  entitlements: string[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const JWT_AUDIENCE = "cail-internal";

function base64UrlDecode(segment: string): Uint8Array<ArrayBuffer> | null {
  try {
    const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Verify an `X-CAIL-Identity-JWT` token. Returns the identity on success, or
 * `null` for any failure (malformed, wrong alg, bad signature, expired, wrong
 * aud/iss, empty sub). Never throws.
 *
 * Ported from cail-gateway key-service/src/identity.ts — keep in sync.
 */
export async function verifyIdentityJwt(
  token: string,
  secret: string,
  now: number = Math.floor(Date.now() / 1000)
): Promise<CailIdentity | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  const headerBytes = base64UrlDecode(headerB64);
  const payloadBytes = base64UrlDecode(payloadB64);
  const signature = base64UrlDecode(signatureB64);
  if (!headerBytes || !payloadBytes || !signature) return null;

  let header: { alg?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(decoder.decode(headerBytes));
    payload = JSON.parse(decoder.decode(payloadBytes));
  } catch {
    return null;
  }
  // Pin the algorithm — never let the token pick it.
  if (header.alg !== "HS256") return null;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    encoder.encode(`${headerB64}.${payloadB64}`)
  );
  if (!valid) return null;

  if (typeof payload.exp !== "number" || payload.exp <= now) return null;
  if (payload.aud !== JWT_AUDIENCE) return null;
  if (typeof payload.iss !== "string" || !payload.iss.endsWith("/cail-sso")) return null;
  if (typeof payload.sub !== "string" || payload.sub === "") return null;

  return {
    subject: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    name: typeof payload.name === "string" ? payload.name : undefined,
    entitlements: Array.isArray(payload.entitlements)
      ? payload.entitlements.filter((e): e is string => typeof e === "string")
      : [],
  };
}

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
  return verifyIdentityJwt(token, secret);
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
