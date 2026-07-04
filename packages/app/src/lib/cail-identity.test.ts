import { describe, it, expect } from "vitest";
import {
  cailAuthRequiredResponse,
  cailIdentityRequired,
  getRequestIdentity,
  verifyIdentityJwt,
} from "./cail-identity";

const SECRET = "test-shared-secret";

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

describe("verifyIdentityJwt", () => {
  it("accepts a well-formed token and returns the identity", async () => {
    const token = await mintJwt(validClaims());
    const identity = await verifyIdentityJwt(token, SECRET);
    expect(identity).not.toBeNull();
    expect(identity!.subject).toBe("cail-abc123");
    expect(identity!.email).toBe("someone@gc.cuny.edu");
    expect(identity!.name).toBe("Some One");
    expect(identity!.entitlements).toEqual(["site-studio"]);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await mintJwt(validClaims(), { secret: "wrong-secret" });
    expect(await verifyIdentityJwt(token, SECRET)).toBeNull();
  });

  it("rejects a non-HS256 algorithm (alg pinning)", async () => {
    // "alg: none" must never be accepted even if the signature check is skipped.
    const token = await mintJwt(validClaims(), { header: { alg: "none", typ: "JWT" } });
    expect(await verifyIdentityJwt(token, SECRET)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await mintJwt(validClaims({ exp: now - 1 }));
    expect(await verifyIdentityJwt(token, SECRET)).toBeNull();
  });

  it("rejects the wrong audience", async () => {
    const token = await mintJwt(validClaims({ aud: "someone-else" }));
    expect(await verifyIdentityJwt(token, SECRET)).toBeNull();
  });

  it("rejects an issuer that does not end with /cail-sso", async () => {
    const token = await mintJwt(validClaims({ iss: "https://evil.example/not-cail" }));
    expect(await verifyIdentityJwt(token, SECRET)).toBeNull();
  });

  it("rejects an empty or missing subject", async () => {
    const token = await mintJwt(validClaims({ sub: "" }));
    expect(await verifyIdentityJwt(token, SECRET)).toBeNull();
  });

  it("rejects a malformed token", async () => {
    expect(await verifyIdentityJwt("not-a-jwt", SECRET)).toBeNull();
    expect(await verifyIdentityJwt("a.b", SECRET)).toBeNull();
  });
});

describe("getRequestIdentity", () => {
  it("returns null when no secret is configured", async () => {
    const token = await mintJwt(validClaims());
    const req = new Request("https://x/", { headers: { "X-CAIL-Identity-JWT": token } });
    expect(await getRequestIdentity(req, {})).toBeNull();
  });

  it("returns null when the header is absent", async () => {
    const req = new Request("https://x/");
    expect(await getRequestIdentity(req, { CAIL_IDENTITY_JWT_SECRET: SECRET })).toBeNull();
  });

  it("verifies the X-CAIL-Identity-JWT header", async () => {
    const token = await mintJwt(validClaims());
    const req = new Request("https://x/", { headers: { "X-CAIL-Identity-JWT": token } });
    const identity = await getRequestIdentity(req, { CAIL_IDENTITY_JWT_SECRET: SECRET });
    expect(identity!.subject).toBe("cail-abc123");
  });

  it("ignores bare X-CAIL-Subject headers (never trusted)", async () => {
    const req = new Request("https://x/", { headers: { "X-CAIL-Subject": "cail-forged" } });
    expect(await getRequestIdentity(req, { CAIL_IDENTITY_JWT_SECRET: SECRET })).toBeNull();
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
