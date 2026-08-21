import { beforeAll, describe, expect, it } from "vitest";
import { CAIL_CANONICAL_ISSUER } from "@cuny-ai-lab/cail-identity";
import {
  TEST_SUBJECTS,
  canonicalTestSubject,
  createTestIdentityIssuer,
  type MintTestIdentityJwtOptions,
  type TestIdentityIssuer,
} from "@cuny-ai-lab/cail-identity/testing";
import {
  cailAuthRequiredResponse,
  getRequestIdentity,
  resolveRequestIdentity,
} from "./cail-identity";

const AUDIENCE = "cail:site-studio";
type IdentityJsonValue = string | number | boolean | null | IdentityJsonValue[] | { [key: string]: IdentityJsonValue };
type IdentityJsonObject = { [key: string]: IdentityJsonValue };
type IdentityEnv = {
  CAIL_IDENTITY_JWKS: string;
  CAIL_IDENTITY_ISSUER: string;
};

let issuer: TestIdentityIssuer;
let currentEnv: IdentityEnv;

beforeAll(async () => {
  // Mint the exact production Doorway issuer used by the app.
  issuer = await createTestIdentityIssuer({ kid: "current", issuer: CAIL_CANONICAL_ISSUER });
  currentEnv = {
    CAIL_IDENTITY_JWKS: issuer.jwksJson,
    CAIL_IDENTITY_ISSUER: CAIL_CANONICAL_ISSUER,
  };
});

/** Mint a site-studio-audience token from the shared kit; override any claim. */
function mintJwt(overrides: Partial<MintTestIdentityJwtOptions> = {}): Promise<string> {
  return issuer.mintIdentityJwt({
    audience: AUDIENCE,
    email: "someone@gc.cuny.edu",
    name: "Some One",
    entitlements: ["site-studio"],
    ...overrides,
  });
}

function requestWithToken(token: string): Request {
  return new Request("https://site-studio.example/", {
    headers: { "X-CAIL-Identity-JWT": token },
  });
}

// ---------------------------------------------------------------------------
// Hand-rolled negative-path fixture for the one shape the testing kit cannot
// express: mintIdentityJwt only signs RS256, so the alg-tampering contract
// violation needs a local signer. (The array-audience negative moved onto the
// kit in cail-identity 5.2.5.)
// ---------------------------------------------------------------------------

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlJson(value: IdentityJsonValue): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

type PublicJwk = JsonWebKey & { kid: string; alg: "RS256"; use: "sig" };
type LocalKey = { privateKey: CryptoKey; jwk: PublicJwk };

async function generateLocalKey(kid: string): Promise<LocalKey> {
  // SAFETY: Web Crypto generateKey with RSASSA-PKCS1-v1_5 and extractable keys
  // returns a CryptoKeyPair by contract.
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
    // SAFETY: The test signer adds the required RS256 metadata to this exported
    // public JWK before using it as the local verification key.
    jwk: { ...jwk, kid, alg: "RS256", use: "sig" } as PublicJwk,
  };
}

function validLocalClaims(overrides: IdentityJsonObject = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: CAIL_CANONICAL_ISSUER,
    aud: AUDIENCE,
    sub: TEST_SUBJECTS.alice,
    email: "someone@gc.cuny.edu",
    iat: now,
    exp: now + 300,
    ...overrides,
  };
}

async function signLocalJwt(
  key: LocalKey,
  claims: IdentityJsonObject = {},
  header: IdentityJsonObject = { alg: "RS256", typ: "JWT", kid: key.jwk.kid }
): Promise<string> {
  const headerPart = base64urlJson(header);
  const payloadPart = base64urlJson(validLocalClaims(claims));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key.privateKey,
    new TextEncoder().encode(`${headerPart}.${payloadPart}`)
  );
  return `${headerPart}.${payloadPart}.${base64url(new Uint8Array(signature))}`;
}

let localKey: LocalKey;
let localEnv: IdentityEnv;

beforeAll(async () => {
  localKey = await generateLocalKey("local");
  localEnv = {
    CAIL_IDENTITY_JWKS: JSON.stringify({ keys: [localKey.jwk] }),
    CAIL_IDENTITY_ISSUER: CAIL_CANONICAL_ISSUER,
  };
});

describe("getRequestIdentity", () => {
  it("accepts a valid canonical identity token", async () => {
    const identity = await getRequestIdentity(requestWithToken(await mintJwt()), currentEnv);

    expect(identity).toEqual({
      subject: TEST_SUBJECTS.alice,
      email: "someone@gc.cuny.edu",
      name: "Some One",
      entitlements: ["site-studio"],
    });
  });

  it("rejects a token signed by a key outside the configured JWKS", async () => {
    const otherIssuer = await createTestIdentityIssuer({ kid: "other" });
    const token = await otherIssuer.mintIdentityJwt({ audience: AUDIENCE });
    expect(await getRequestIdentity(requestWithToken(token), currentEnv)).toBeNull();
  });

  it("rejects an algorithm other than RS256", async () => {
    // Sanity: the same local key verifies when the header is untampered.
    expect(await getRequestIdentity(requestWithToken(await signLocalJwt(localKey)), localEnv))
      .not.toBeNull();
    const token = await signLocalJwt(localKey, {}, {
      alg: "none",
      typ: "JWT",
      kid: localKey.jwk.kid,
    });
    expect(await getRequestIdentity(requestWithToken(token), localEnv)).toBeNull();
  });

  it("rejects an expired token", async () => {
    // exp = (now - 3720) + 3600 = 120 seconds in the past.
    const token = await mintJwt({ now: Math.floor(Date.now() / 1000) - 3720 });
    expect(await getRequestIdentity(requestWithToken(token), currentEnv)).toBeNull();
  });

  it("rejects the wrong audience", async () => {
    const token = await mintJwt({ audience: "cail:another-service" });
    expect(await getRequestIdentity(requestWithToken(token), currentEnv)).toBeNull();
  });

  it("rejects array-valued audiences, including a one-element array", async () => {
    const token = await mintJwt({ audience: [AUDIENCE] });
    expect(await getRequestIdentity(requestWithToken(token), currentEnv)).toBeNull();
  });

  it("preserves the verified canonical subject byte-for-byte as the durable owner key", async () => {
    const subject = canonicalTestSubject("durable-owner");
    const token = await mintJwt({ subject });
    await expect(getRequestIdentity(requestWithToken(token), currentEnv))
      .resolves.toMatchObject({ subject });
  });

  it("rejects non-canonical subjects (v4 accepts only cail-<32 lowercase hex>)", async () => {
    for (const subject of [
      "  Opaque-CAIL-Subject  ",
      "cail-ABC12300ABC12300ABC12300ABC12300",
      "cail-abc123",
      "someone@gc.cuny.edu",
    ]) {
      const token = await mintJwt({ subject });
      expect(await getRequestIdentity(requestWithToken(token), currentEnv)).toBeNull();
    }
  });

  it("rejects non-allowlisted and look-alike issuers", async () => {
    const untrusted = await mintJwt({ issuer: "https://evil.example/not-cail" });
    const lookAlike = await mintJwt({ issuer: "https://evil.example/cail-sso" });

    expect(await getRequestIdentity(requestWithToken(untrusted), currentEnv)).toBeNull();
    expect(await getRequestIdentity(requestWithToken(lookAlike), currentEnv)).toBeNull();
  });

  it("rejects a self-consistent attacker issuer, JWKS, and token configuration", async () => {
    const attackerIssuer = "https://evil.example/cail-sso";
    const attacker = await createTestIdentityIssuer({ kid: "attacker" });
    const token = await attacker.mintIdentityJwt({
      audience: AUDIENCE,
      issuer: attackerIssuer,
    });

    await expect(getRequestIdentity(requestWithToken(token), {
      CAIL_IDENTITY_JWKS: attacker.jwksJson,
      CAIL_IDENTITY_ISSUER: attackerIssuer,
    })).resolves.toBeNull();
  });

  it("fails closed when the configured issuer is not CAIL's canonical issuer", async () => {
    const productionToken = await mintJwt();

    for (const env of [
      { ...currentEnv, CAIL_IDENTITY_ISSUER: undefined },
      { ...currentEnv, CAIL_IDENTITY_ISSUER: "https://evil.example/cail-sso" },
    ]) {
      await expect(getRequestIdentity(requestWithToken(productionToken), env))
        .resolves.toBeNull();
    }
  });

  it("rejects an empty subject", async () => {
    const token = await mintJwt({ subject: "" });
    expect(await getRequestIdentity(requestWithToken(token), currentEnv)).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    expect(await getRequestIdentity(requestWithToken("not-a-jwt"), currentEnv)).toBeNull();
    expect(await getRequestIdentity(requestWithToken("a.b"), currentEnv)).toBeNull();
  });
});

describe("resolveRequestIdentity", () => {
  it("returns the verified identity and exact canonical token", async () => {
    const token = await mintJwt();
    const result = await resolveRequestIdentity(requestWithToken(token), currentEnv);

    expect(result).toMatchObject({
      status: "verified",
      token,
      identity: { subject: TEST_SUBJECTS.alice },
    });
  });

  it("accepts every unambiguous key in a rotating JWKS", async () => {
    const oldIssuer = await createTestIdentityIssuer({ kid: "old", issuer: CAIL_CANONICAL_ISSUER });
    const newIssuer = await createTestIdentityIssuer({ kid: "new", issuer: CAIL_CANONICAL_ISSUER });
    const env = {
      CAIL_IDENTITY_JWKS: JSON.stringify({
        keys: [...oldIssuer.jwks.keys, ...newIssuer.jwks.keys],
      }),
      CAIL_IDENTITY_ISSUER: CAIL_CANONICAL_ISSUER,
    };

    await expect(resolveRequestIdentity(
      requestWithToken(await oldIssuer.mintIdentityJwt({ audience: AUDIENCE })),
      env
    )).resolves.toMatchObject({ status: "verified" });
    await expect(resolveRequestIdentity(
      requestWithToken(await newIssuer.mintIdentityJwt({ audience: AUDIENCE })),
      env
    )).resolves.toMatchObject({ status: "verified" });
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
    const token = await mintJwt();
    await expect(resolveRequestIdentity(requestWithToken(token), {
      CAIL_IDENTITY_JWKS: jwks,
      CAIL_IDENTITY_ISSUER: CAIL_CANONICAL_ISSUER,
    }))
      .resolves.toEqual({ status: "invalid" });
  });

  it.each([undefined, "", ` ${CAIL_CANONICAL_ISSUER}`])(
    "fails closed when the deployment issuer is missing or malformed (%s)",
    async (issuerValue) => {
      const token = await mintJwt();
      await expect(resolveRequestIdentity(requestWithToken(token), {
        CAIL_IDENTITY_JWKS: currentEnv.CAIL_IDENTITY_JWKS,
        CAIL_IDENTITY_ISSUER: issuerValue,
      })).resolves.toEqual({ status: "invalid" });
    },
  );

  it("ignores bare identity attribute headers", async () => {
    const request = new Request("https://site-studio.example/", {
      headers: { "X-CAIL-Subject": TEST_SUBJECTS.bob },
    });
    await expect(resolveRequestIdentity(request, currentEnv)).resolves.toEqual({ status: "absent" });
  });
});

describe("cailAuthRequiredResponse", () => {
  it("returns the CAIL authentication_required envelope", async () => {
    const response = cailAuthRequiredResponse();
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "authentication_required",
        message: "Please sign in to continue.",
        launch: "/launch/site-studio",
      },
    });
  });
});
