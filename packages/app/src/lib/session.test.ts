import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../types";
import { authMiddleware } from "./session";

const JWT_SECRET = "session-test-secret";

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function mintIdentityJwt(sub: string, secret = JWT_SECRET): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  const headerB64 = base64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payloadB64 = base64url(
    enc.encode(
      JSON.stringify({
        iss: "https://tools.ailab.gc.cuny.edu/cail-sso",
        aud: "cail-internal",
        sub,
        email: "u@gc.cuny.edu",
        exp: now + 300,
        iat: now
      })
    )
  );
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${headerB64}.${payloadB64}`));
  return `${headerB64}.${payloadB64}.${base64url(new Uint8Array(sig))}`;
}

function createEnv(overrides?: Partial<Env>): Env {
  return {
    APP_PUBLIC_DOMAIN: "https://tools.ailab.gc.cuny.edu",
    LEGACY_PUBLIC_DOMAIN: "https://tools.cuny.qzz.io",
    LOADER: {} as WorkerLoader,
    CAIL_API_BASE: "https://cail.example/proxy",
    CAIL_MODEL: "test-model",
    SESSION_KV: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined)
    } as unknown as KVNamespace,
    SITE_STUDIO_BUCKET: {
      get: vi.fn(async () => null)
    } as unknown as R2Bucket,
    SITE_BUILDER_AGENT: {} as DurableObjectNamespace<any>,
    ASSETS: undefined,
    ...overrides
  };
}

describe("authMiddleware", () => {
  it("creates a new anonymous session when a legacy session blob is malformed", async () => {
    const app = new Hono<{ Bindings: Env; Variables: { user: { id: string; createdAt: string } } }>();
    app.use("*", authMiddleware);
    app.get("/api/test", (c) => c.json({ user: c.get("user") }));

    const kvPut = vi.fn(async () => undefined);
    const env = createEnv({
      SESSION_KV: {
        get: vi.fn(async () => null),
        put: kvPut
      } as unknown as KVNamespace,
      SITE_STUDIO_BUCKET: {
        get: vi.fn(async () => ({
          text: async () => "{not valid json"
        }))
      } as unknown as R2Bucket
    });

    const response = await app.request("http://site-studio.test/api/test", {
      headers: {
        Cookie: "site-studio-session=broken-session"
      }
    }, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      user: {
        id: expect.stringMatching(/^user_/),
        createdAt: expect.any(String)
      }
    });
    expect(kvPut).toHaveBeenCalledTimes(1);
    expect(response.headers.get("set-cookie")).toContain("site-studio-session=");
  });

  it("keys the user by the CAIL subject when a verified identity JWT is present", async () => {
    const app = new Hono<{ Bindings: Env; Variables: { user: { id: string; createdAt: string } } }>();
    app.use("*", authMiddleware);
    app.get("/api/test", (c) => c.json({ user: c.get("user") }));

    const kvPut = vi.fn(async () => undefined);
    const env = createEnv({
      CAIL_IDENTITY_JWT_SECRET: JWT_SECRET,
      SESSION_KV: {
        get: vi.fn(async () => null),
        put: kvPut
      } as unknown as KVNamespace
    });

    const token = await mintIdentityJwt("cail-subject-xyz");
    const response = await app.request(
      "http://site-studio.test/api/test",
      { headers: { "X-CAIL-Identity-JWT": token } },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { user: { id: string; cail?: boolean; email?: string } };
    expect(body.user.id).toBe("cail-subject-xyz");
    expect(body.user.cail).toBe(true);
    expect(body.user.email).toBe("u@gc.cuny.edu");
    // Session is bound to the subject, not a random cookie id.
    expect(response.headers.get("set-cookie")).toContain("site-studio-session=cail-subject-xyz");
  });

  it("returns the authentication_required envelope when identity is required but absent", async () => {
    const app = new Hono<{ Bindings: Env; Variables: { user: { id: string; createdAt: string } } }>();
    app.use("*", authMiddleware);
    app.get("/api/test", (c) => c.json({ user: c.get("user") }));

    const env = createEnv({
      CAIL_IDENTITY_JWT_SECRET: JWT_SECRET,
      CAIL_REQUIRE_IDENTITY: "true"
    });

    const response = await app.request("http://site-studio.test/api/test", {}, env);
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("authentication_required");
  });

  it("ignores a bare X-CAIL-Subject header and falls back to anonymous", async () => {
    const app = new Hono<{ Bindings: Env; Variables: { user: { id: string; createdAt: string } } }>();
    app.use("*", authMiddleware);
    app.get("/api/test", (c) => c.json({ user: c.get("user") }));

    const env = createEnv({ CAIL_IDENTITY_JWT_SECRET: JWT_SECRET });
    const response = await app.request(
      "http://site-studio.test/api/test",
      { headers: { "X-CAIL-Subject": "cail-forged" } },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { user: { id: string } };
    expect(body.user.id).toMatch(/^user_/); // anonymous, not the forged subject
  });
});
