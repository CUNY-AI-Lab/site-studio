import { beforeAll, describe, expect, it } from "vitest";
import {
  cailAuthRequiredResponse,
  cailIdentityRequired,
  getRequestIdentity,
  resolveRequestIdentity,
} from "./cail-identity";

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

type PublicJwk = JsonWebKey & { kid: string; alg: "RS256"; use: "sig" };
type TestKey = { privateKey: CryptoKey; jwk: PublicJwk };

async function generateKey(kid: string): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  ) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    privateKey: pair.privateKey,
    jwk: { ...jwk, kid, alg: "RS256", use: "sig" } as PublicJwk,
  };
}

function validClaims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://tools.ailab.gc.cuny.edu/cail-sso",
    aud: "cail:site-studio",
    sub: "cail-abc123",
    email: "someone@gc.cuny.edu",
    name: "Some One",
    entitlements: ["site-studio"],
    iat: now,
    exp: now + 300,
    ...overrides,
  };
}

async function mintJwt(
  key: TestKey,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = { alg: "RS256", typ: "JWT", kid: key.jwk.kid }
): Promise<string> {
  const headerPart = base64urlJson(header);
  const payloadPart = base64urlJson(validClaims(claims));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key.privateKey,
    new TextEncoder().encode(`${headerPart}.${payloadPart}`)
  );
  return `${headerPart}.${payloadPart}.${base64url(new Uint8Array(signature))}`;
}

function requestWithToken(token: string): Request {
  return new Request("https://site-studio.example/", {
    headers: { "X-CAIL-Identity-JWT": token },
  });
}

let currentKey: TestKey;
let currentEnv: { CAIL_IDENTITY_JWKS: string };

beforeAll(async () => {
  currentKey = await generateKey("current");
  currentEnv = { CAIL_IDENTITY_JWKS: JSON.stringify({ keys: [currentKey.jwk] }) };
});

describe("getRequestIdentity", () => {
  it("accepts a valid canonical identity token", async () => {
    const identity = await getRequestIdentity(requestWithToken(await mintJwt(currentKey)), currentEnv);

    expect(identity).toEqual({
      subject: "cail-abc123",
      email: "someone@gc.cuny.edu",
      name: "Some One",
      entitlements: ["site-studio"],
    });
  });

  it("accepts the staging issuer", async () => {
    const token = await mintJwt(currentKey, {
      iss: "https://tools.cuny.qzz.io/cail-sso",
    });
    await expect(getRequestIdentity(requestWithToken(token), currentEnv))
      .resolves.toMatchObject({ subject: "cail-abc123" });
  });

  it("rejects a token signed by a key outside the configured JWKS", async () => {
    const otherKey = await generateKey("other");
    expect(await getRequestIdentity(requestWithToken(await mintJwt(otherKey)), currentEnv)).toBeNull();
  });

  it("rejects an algorithm other than RS256", async () => {
    const token = await mintJwt(currentKey, {}, {
      alg: "none",
      typ: "JWT",
      kid: currentKey.jwk.kid,
    });
    expect(await getRequestIdentity(requestWithToken(token), currentEnv)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await mintJwt(currentKey, { exp: now - 120 });
    expect(await getRequestIdentity(requestWithToken(token), currentEnv)).toBeNull();
  });

  it("rejects the wrong audience", async () => {
    const token = await mintJwt(currentKey, { aud: "cail:another-service" });
    expect(await getRequestIdentity(requestWithToken(token), currentEnv)).toBeNull();
  });

  it("rejects non-allowlisted and look-alike issuers", async () => {
    const untrusted = await mintJwt(currentKey, { iss: "https://evil.example/not-cail" });
    const lookAlike = await mintJwt(currentKey, { iss: "https://evil.example/cail-sso" });

    expect(await getRequestIdentity(requestWithToken(untrusted), currentEnv)).toBeNull();
    expect(await getRequestIdentity(requestWithToken(lookAlike), currentEnv)).toBeNull();
  });

  it("rejects an empty subject", async () => {
    const token = await mintJwt(currentKey, { sub: "" });
    expect(await getRequestIdentity(requestWithToken(token), currentEnv)).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    expect(await getRequestIdentity(requestWithToken("not-a-jwt"), currentEnv)).toBeNull();
    expect(await getRequestIdentity(requestWithToken("a.b"), currentEnv)).toBeNull();
  });
});

describe("resolveRequestIdentity", () => {
  it("returns the verified identity and exact canonical token", async () => {
    const token = await mintJwt(currentKey);
    const result = await resolveRequestIdentity(requestWithToken(token), currentEnv);

    expect(result).toMatchObject({
      status: "verified",
      token,
      identity: { subject: "cail-abc123" },
    });
  });

  it("accepts every unambiguous key in a rotating JWKS", async () => {
    const oldKey = await generateKey("old");
    const newKey = await generateKey("new");
    const env = {
      CAIL_IDENTITY_JWKS: JSON.stringify({ keys: [oldKey.jwk, newKey.jwk] }),
    };

    await expect(resolveRequestIdentity(requestWithToken(await mintJwt(oldKey)), env))
      .resolves.toMatchObject({ status: "verified" });
    await expect(resolveRequestIdentity(requestWithToken(await mintJwt(newKey)), env))
      .resolves.toMatchObject({ status: "verified" });
  });

  it("distinguishes an absent identity from an invalid presented credential", async () => {
    await expect(resolveRequestIdentity(new Request("https://site-studio.example/"), currentEnv))
      .resolves.toEqual({ status: "absent" });
    await expect(resolveRequestIdentity(requestWithToken("not-a-jwt"), currentEnv))
      .resolves.toEqual({ status: "invalid" });
  });

  it.each([
    ["missing", undefined],
    ["malformed", "{not-json"],
  ])("rejects a presented token when the JWKS is %s", async (_name, jwks) => {
    const token = await mintJwt(currentKey);
    await expect(resolveRequestIdentity(requestWithToken(token), { CAIL_IDENTITY_JWKS: jwks }))
      .resolves.toEqual({ status: "invalid" });
  });

  it("ignores bare identity attribute headers", async () => {
    const request = new Request("https://site-studio.example/", {
      headers: { "X-CAIL-Subject": "cail-forged" },
    });
    await expect(resolveRequestIdentity(request, currentEnv)).resolves.toEqual({ status: "absent" });
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
  it("returns the CAIL authentication_required envelope", async () => {
    const response = cailAuthRequiredResponse();
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: "authentication_required",
      login_url: "/login",
    });
  });
});
