import { describe, it, expect } from "vitest";
import {
  cailAuthRequiredResponse,
  cailIdentityConfigured,
  cailIdentityRequired,
  getRequestIdentity,
  resolveRequestIdentity,
} from "./cail-identity";

const SECRET = "test-shared-secret-at-least-32-bytes";
const ENV = { CAIL_IDENTITY_JWT_SECRET: SECRET };

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

/** Mint an HS256 JWT with the given header/payload using WebCrypto. */
async function mintJwt(
  payload: Record<string, unknown>,
  { secret = SECRET, header = { alg: "HS256", typ: "JWT" } } = {}
): Promise<string> {
  const headerB64 = base64urlJson(header);
  const payloadB64 = base64urlJson(payload);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
  return `${headerB64}.${payloadB64}.${base64url(new Uint8Array(sig))}`;
}

function validClaims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://tools.ailab.gc.cuny.edu/cail-sso",
    aud: "cail-internal",
    sub: "cail-abc123",
    email: "someone@gc.cuny.edu",
    name: "Some One",
    entitlements: ["site-studio"],
    iat: now,
    exp: now + 300,
    ...overrides,
  };
}

/**
 * Request carrying `token` in the `X-CAIL-Identity-JWT` header — the only way a
 * verified identity reaches this worker.
 */
function requestWithToken(token: string): Request {
  return new Request("https://x/", {
    headers: { "X-CAIL-Identity-JWT": token },
  });
}

type V2PublicJwk = JsonWebKey & { kid: string; alg: "RS256"; use: "sig" };
type V2Key = { privateKey: CryptoKey; jwk: V2PublicJwk };

async function generateV2Key(kid: string): Promise<V2Key> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  ) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    privateKey: pair.privateKey,
    jwk: { ...jwk, kid, alg: "RS256", use: "sig" } as V2PublicJwk,
  };
}

async function mintV2Jwt(
  key: V2Key,
  claims: Record<string, unknown> = {},
  kid = key.jwk.kid
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64urlJson({ alg: "RS256", typ: "JWT", kid });
  const payload = base64urlJson({
    iss: "https://tools.ailab.gc.cuny.edu/cail-sso",
    aud: "cail:site-studio",
    sub: "cail-v2-subject",
    entitlements: ["site-studio"],
    iat: now,
    exp: now + 300,
    ...claims,
  });
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key.privateKey,
    new TextEncoder().encode(`${header}.${payload}`)
  );
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}

function requestWithIdentityHeaders(v1: string | null, v2: string | null): Request {
  const headers = new Headers();
  if (v1 !== null) headers.set("X-CAIL-Identity-JWT", v1);
  if (v2 !== null) headers.set("X-CAIL-Identity-JWT-V2", v2);
  return new Request("https://x/", { headers });
}

/**
 * These exercise JWT verification through `getRequestIdentity` — the module's
 * real surface, which wires the shared `@cuny-ai-lab/cail-identity` verifier to
 * this worker's issuer allowlist. (The primitive's own byte-level tests live in
 * the `@cuny-ai-lab/cail-identity` package.)
 */
describe("getRequestIdentity — JWT verification", () => {
  it("accepts a well-formed token and returns the identity", async () => {
    const identity = await getRequestIdentity(
      requestWithToken(await mintJwt(validClaims())),
      ENV
    );
    expect(identity).not.toBeNull();
    expect(identity!.subject).toBe("cail-abc123");
    expect(identity!.email).toBe("someone@gc.cuny.edu");
    expect(identity!.name).toBe("Some One");
    expect(identity!.entitlements).toEqual(["site-studio"]);
  });

  it("accepts the staging issuer (allowlisted)", async () => {
    const token = await mintJwt(
      validClaims({ iss: "https://tools.cuny.qzz.io/cail-sso" })
    );
    const identity = await getRequestIdentity(requestWithToken(token), ENV);
    expect(identity!.subject).toBe("cail-abc123");
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await mintJwt(validClaims(), { secret: "wrong-shared-secret-at-least-32-bytes" });
    expect(await getRequestIdentity(requestWithToken(token), ENV)).toBeNull();
  });

  it("rejects a non-HS256 algorithm (alg pinning)", async () => {
    // "alg: none" must never be accepted even if the signature check is skipped.
    const token = await mintJwt(validClaims(), { header: { alg: "none", typ: "JWT" } });
    expect(await getRequestIdentity(requestWithToken(token), ENV)).toBeNull();
  });

  it("rejects an expired token (beyond clock tolerance)", async () => {
    const now = Math.floor(Date.now() / 1000);
    // The primitive applies a 60s default clock tolerance; go well past it.
    const token = await mintJwt(validClaims({ exp: now - 120 }));
    expect(await getRequestIdentity(requestWithToken(token), ENV)).toBeNull();
  });

  it("rejects the wrong audience", async () => {
    const token = await mintJwt(validClaims({ aud: "someone-else" }));
    expect(await getRequestIdentity(requestWithToken(token), ENV)).toBeNull();
  });

  it("rejects a non-allowlisted issuer", async () => {
    const token = await mintJwt(validClaims({ iss: "https://evil.example/not-cail" }));
    expect(await getRequestIdentity(requestWithToken(token), ENV)).toBeNull();
  });

  it("rejects a look-alike issuer that only ends with /cail-sso (EXACT-match, not suffix)", async () => {
    // The old hand-copied verifier accepted anything ending in "/cail-sso"
    // (endsWith). The shared primitive EXACT-matches the allowlist, so a
    // forged issuer that merely shares the suffix is now rejected. This is the
    // intended tightening (closes Codex #3).
    const token = await mintJwt(validClaims({ iss: "https://evil.example/cail-sso" }));
    expect(await getRequestIdentity(requestWithToken(token), ENV)).toBeNull();
  });

  it("rejects an empty or missing subject", async () => {
    const token = await mintJwt(validClaims({ sub: "" }));
    expect(await getRequestIdentity(requestWithToken(token), ENV)).toBeNull();
  });

  it("rejects a malformed token", async () => {
    expect(await getRequestIdentity(requestWithToken("not-a-jwt"), ENV)).toBeNull();
    expect(await getRequestIdentity(requestWithToken("a.b"), ENV)).toBeNull();
  });
});

describe("getRequestIdentity — request wiring", () => {
  it("returns null when no secret is configured", async () => {
    const token = await mintJwt(validClaims());
    expect(await getRequestIdentity(requestWithToken(token), {})).toBeNull();
  });

  it("returns null when the header is absent", async () => {
    const req = new Request("https://x/");
    expect(await getRequestIdentity(req, ENV)).toBeNull();
  });

  it("verifies the X-CAIL-Identity-JWT header", async () => {
    const token = await mintJwt(validClaims());
    const identity = await getRequestIdentity(requestWithToken(token), ENV);
    expect(identity!.subject).toBe("cail-abc123");
  });

  it("ignores bare X-CAIL-Subject headers (never trusted)", async () => {
    const req = new Request("https://x/", { headers: { "X-CAIL-Subject": "cail-forged" } });
    expect(await getRequestIdentity(req, ENV)).toBeNull();
  });
});

describe("resolveRequestIdentity — additive V2", () => {
  it("requires the Site Studio audience", async () => {
    const key = await generateV2Key("current");
    const env = { CAIL_IDENTITY_JWKS: JSON.stringify({ keys: [key.jwk] }) };

    const accepted = await resolveRequestIdentity(
      requestWithIdentityHeaders(null, await mintV2Jwt(key)),
      env
    );
    expect(accepted).toMatchObject({ status: "verified", version: "v2" });

    const rejected = await resolveRequestIdentity(
      requestWithIdentityHeaders(null, await mintV2Jwt(key, { aud: "cail-internal" })),
      env
    );
    expect(rejected).toEqual({ status: "invalid" });
  });

  it("accepts old and new keys during JWKS rotation", async () => {
    const oldKey = await generateV2Key("old");
    const newKey = await generateV2Key("new");
    const env = { CAIL_IDENTITY_JWKS: JSON.stringify({ keys: [oldKey.jwk, newKey.jwk] }) };

    await expect(resolveRequestIdentity(
      requestWithIdentityHeaders(null, await mintV2Jwt(oldKey)),
      env
    )).resolves.toMatchObject({ status: "verified", version: "v2" });
    await expect(resolveRequestIdentity(
      requestWithIdentityHeaders(null, await mintV2Jwt(newKey)),
      env
    )).resolves.toMatchObject({ status: "verified", version: "v2" });
  });

  it("selects valid V2 over V1 and returns the selected raw token", async () => {
    const key = await generateV2Key("current");
    const v1 = await mintJwt(validClaims({ sub: "cail-v1-subject" }));
    const v2 = await mintV2Jwt(key);
    const result = await resolveRequestIdentity(
      requestWithIdentityHeaders(v1, v2),
      { ...ENV, CAIL_IDENTITY_JWKS: JSON.stringify({ keys: [key.jwk] }) }
    );

    expect(result).toMatchObject({
      status: "verified",
      version: "v2",
      token: v2,
      identity: { subject: "cail-v2-subject" },
    });
  });

  it.each([
    ["missing", undefined],
    ["malformed", "{not-json"],
  ])("rejects present V2 with %s JWKS and never falls back to valid V1", async (_name, jwks) => {
    const v1 = await mintJwt(validClaims({ sub: "cail-v1-subject" }));
    const env = { CAIL_IDENTITY_JWT_SECRET: SECRET, CAIL_IDENTITY_JWKS: jwks };
    expect(await resolveRequestIdentity(requestWithIdentityHeaders(v1, "not-a-jwt"), env))
      .toEqual({ status: "invalid" });
  });

  it("rejects invalid V2 without falling back to valid V1", async () => {
    const key = await generateV2Key("current");
    const v1 = await mintJwt(validClaims({ sub: "cail-v1-subject" }));
    const invalidV2 = await mintV2Jwt(key, { aud: "cail:another-app" });
    const result = await resolveRequestIdentity(
      requestWithIdentityHeaders(v1, invalidV2),
      { ...ENV, CAIL_IDENTITY_JWKS: JSON.stringify({ keys: [key.jwk] }) }
    );
    expect(result).toEqual({ status: "invalid" });
  });

  it("preserves V1 when the V2 header is absent", async () => {
    const v1 = await mintJwt(validClaims({ sub: "cail-v1-subject" }));
    const result = await resolveRequestIdentity(requestWithIdentityHeaders(v1, null), ENV);
    expect(result).toMatchObject({
      status: "verified",
      version: "v1",
      token: v1,
      identity: { subject: "cail-v1-subject" },
    });
  });
});

describe("cailIdentityConfigured", () => {
  it("is true when either V1 or V2 verification material is configured", () => {
    expect(cailIdentityConfigured({ CAIL_IDENTITY_JWT_SECRET: SECRET })).toBe(true);
    expect(cailIdentityConfigured({ CAIL_IDENTITY_JWKS: '{"keys":[]}' })).toBe(true);
    expect(cailIdentityConfigured({})).toBe(false);
  });
});

describe("cailIdentityRequired", () => {
  it("is true only when the flag is exactly 'true'", () => {
    expect(cailIdentityRequired({ CAIL_REQUIRE_IDENTITY: "true" })).toBe(true);
    expect(cailIdentityRequired({ CAIL_REQUIRE_IDENTITY: "false" })).toBe(false);
    expect(cailIdentityRequired({})).toBe(false);
  });
});

describe("cailAuthRequiredResponse", () => {
  it("returns the CAIL authentication_required envelope (401)", async () => {
    const res = cailAuthRequiredResponse();
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("authentication_required");
    expect(body.login_url).toBe("/login");
    expect(typeof body.message).toBe("string");
  });
});
