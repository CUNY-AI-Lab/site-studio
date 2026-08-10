import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { CAIL_CANONICAL_ISSUER } from "@cuny-ai-lab/cail-identity";
import {
  TEST_SUBJECTS,
  canonicalTestSubject,
  createTestIdentityIssuer,
  type TestIdentityIssuer,
} from "@cuny-ai-lab/cail-identity/testing";
import type { Env } from "../types";
import { authMiddleware, getCailIdentityJwt } from "./session";
import { migrateAnonymousData } from "./migration";

let identityIssuer: TestIdentityIssuer;
let identityJwks: string;
const PUBLISHED_BASE_URL = "https://cail-doorway.ailab-452.workers.dev/site-studio";

beforeAll(async () => {
  // Mint the exact production Doorway issuer configured by this suite.
  identityIssuer = await createTestIdentityIssuer({
    kid: "session-test",
    issuer: CAIL_CANONICAL_ISSUER,
  });
  identityJwks = identityIssuer.jwksJson;
});

function mintIdentityJwt(sub: string): Promise<string> {
  return identityIssuer.mintIdentityJwt({
    audience: "cail:site-studio",
    subject: sub,
    email: "u@gc.cuny.edu",
    expiresInSeconds: 300
  });
}

/**
 * In-memory stand-in for the MigrationCoordinator DO namespace. vitest runs
 * under node and cannot load the real `cloudflare:workers` DO class, so we model
 * the DO's serialized, first-wins claim decision here. `idFromName(anonId)`
 * returns the anonId as the "id"; `.get(id)` returns a stub whose `claim`/
 * `markComplete` read and mutate a shared per-anonId record map — exactly the
 * single-serialization-point semantics the real DO provides. First subject to
 * claim an anonId wins; a different subject is refused (granted:false).
 */
type CoordinatorRecord = { subject: string; status: "pending" | "complete" };
type MockCoordinator = {
  /** The DO namespace, ready to drop into Env["MIGRATION_COORDINATOR"]. */
  namespace: Env["MIGRATION_COORDINATOR"];
  /** The shared per-anonId claim map, for direct assertions/seeding in tests. */
  records: Map<string, CoordinatorRecord>;
};

function createCoordinatorNamespace(): MockCoordinator {
  const records = new Map<string, CoordinatorRecord>();
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      claim: async (anonId: string, subject: string) => {
        const existing = records.get(anonId);
        if (!existing) {
          records.set(anonId, { subject, status: "pending" });
          return { granted: true, resume: false, claimedBy: null };
        }
        if (existing.subject === subject) {
          return { granted: true, resume: true, claimedBy: subject };
        }
        return { granted: false, resume: false, claimedBy: existing.subject };
      },
      markComplete: async (anonId: string, subject: string) => {
        const existing = records.get(anonId);
        if (existing && existing.subject === subject) {
          records.set(anonId, { ...existing, status: "complete" });
        }
      }
    })
  } as unknown as Env["MIGRATION_COORDINATOR"];
  return { namespace, records };
}

function createEnv(overrides?: Partial<Env>): Env {
  const env: Env = {
    CAIL_LOG_ENV: "test",
    APP_PUBLIC_DOMAIN: "https://cail-doorway.ailab-452.workers.dev",
    PUBLISHED_BASE_URL,
    LOADER: {} as WorkerLoader,
    CAIL_API_BASE: "https://cail.example/proxy",
    CAIL_IDENTITY_ISSUER: CAIL_CANONICAL_ISSUER,
    CAIL_MODEL: "test-model",
    SESSION_KV: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined)
    } as unknown as KVNamespace,
    SITE_STUDIO_BUCKET: {
      get: vi.fn(async () => null),
      put: vi.fn(async (key: string) => ({ key }))
    } as unknown as R2Bucket,
    SITE_BUILDER_AGENT: {} as DurableObjectNamespace<any>,
    MIGRATION_COORDINATOR: createCoordinatorNamespace().namespace,
    ASSETS: undefined,
    ...overrides
  };
  env.MUTATION_COORDINATOR ??= {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: () => ({
      migrateAnonymous: (anonUserId: string, subject: string, anonSessionId?: string) =>
        migrateAnonymousData({
          bucket: env.SITE_STUDIO_BUCKET,
          kv: env.SESSION_KV,
          anonUserId,
          subject,
          publishedBaseUrl: env.PUBLISHED_BASE_URL!,
          anonSessionId
        })
    })
  } as unknown as Env["MUTATION_COORDINATOR"];
  return env;
}

describe("authMiddleware", () => {
  it("keys the user by the CAIL subject when a verified identity JWT is present", async () => {
    const app = new Hono<{ Bindings: Env; Variables: { user: { id: string; createdAt: string } } }>();
    app.use("*", authMiddleware);
    app.get("/api/test", (c) => c.json({ user: c.get("user") }));

    const kvPut = vi.fn(async () => undefined);
    const env = createEnv({
      CAIL_IDENTITY_JWKS: identityJwks,
      SESSION_KV: {
        get: vi.fn(async () => null),
        put: kvPut
      } as unknown as KVNamespace
    });

    const subject = TEST_SUBJECTS.alice;
    const token = await mintIdentityJwt(subject);
    const response = await app.request(
      "http://site-studio.test/api/test",
      { headers: { "X-CAIL-Identity-JWT": token } },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { user: { id: string; cail?: boolean; email?: string } };
    expect(body.user.id).toBe(subject);
    expect(body.user.cail).toBe(true);
    expect(body.user.email).toBe("u@gc.cuny.edu");
    // The verified subject is request authority; no subject session cookie or
    // KV record is minted. A first-login request without a legacy cookie emits
    // no continuity cookie at all.
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(kvPut).not.toHaveBeenCalled();
  });

  it("does not consult a subject session cookie or cail KV record for auth", async () => {
    const app = new Hono<{ Bindings: Env; Variables: { user: { id: string; createdAt: string } } }>();
    app.use("*", authMiddleware);
    app.get("/api/test", (c) => c.json({ user: c.get("user") }));

    const subject = TEST_SUBJECTS.alice;
    const token = await mintIdentityJwt(subject);
    const bucketGet = vi.fn(async (..._args: unknown[]) => null);
    const kvGet = vi.fn(async (..._args: unknown[]) => null);
    const env = createEnv({
      CAIL_IDENTITY_JWKS: identityJwks,
      SITE_STUDIO_BUCKET: {
        get: bucketGet,
        put: vi.fn(async () => undefined)
      } as unknown as R2Bucket,
      SESSION_KV: {
        get: kvGet,
        put: vi.fn(async () => undefined)
      } as unknown as KVNamespace
    });

    const response = await app.request(
      "http://site-studio.test/api/test",
      {
        headers: {
          "X-CAIL-Identity-JWT": token,
          Cookie: `site-studio-session=${subject}`
        }
      },
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ user: { id: subject } });
    expect(bucketGet.mock.calls.some(([key]) => key === `sessions/${subject}.json`)).toBe(false);
    expect(kvGet.mock.calls.some(([key]) => key === `cail:${subject}`)).toBe(false);
  });

  it("returns the authentication_required envelope when identity is required but absent", async () => {
    const app = new Hono<{ Bindings: Env; Variables: { user: { id: string; createdAt: string } } }>();
    app.use("*", authMiddleware);
    app.get("/api/test", (c) => c.json({ user: c.get("user") }));

    const env = createEnv({
      CAIL_IDENTITY_JWKS: identityJwks
    });

    const response = await app.request("http://site-studio.test/api/test", {}, env);
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("authentication_required");
  });

  it("rejects a presented invalid identity token", async () => {
    const app = new Hono<{ Bindings: Env; Variables: { user: { id: string; createdAt: string } } }>();
    app.use("*", authMiddleware);
    app.get("/api/test", (c) => c.json({ user: c.get("user") }));

    const response = await app.request(
      "http://site-studio.test/api/test",
      { headers: { "X-CAIL-Identity-JWT": "not-a-jwt" } },
      createEnv({ CAIL_IDENTITY_JWKS: identityJwks })
    );
    expect(response.status).toBe(401);
  });

  it("stores the verified canonical token for downstream calls", async () => {
    const app = new Hono<{
      Bindings: Env;
      Variables: { user: { id: string; createdAt: string }; cailIdentityJwt?: string };
    }>();
    app.use("*", authMiddleware);
    app.get("/api/test", (c) => c.json({ user: c.get("user"), forwardedToken: getCailIdentityJwt(c) }));

    const subject = TEST_SUBJECTS.bob;
    const token = await mintIdentityJwt(subject);
    const response = await app.request(
      "http://site-studio.test/api/test",
      { headers: { "X-CAIL-Identity-JWT": token } },
      createEnv({ CAIL_IDENTITY_JWKS: identityJwks })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      user: { id: subject },
      forwardedToken: token
    });
  });

  it("ignores a bare X-CAIL-Subject header and requires verified identity", async () => {
    const app = new Hono<{ Bindings: Env; Variables: { user: { id: string; createdAt: string } } }>();
    app.use("*", authMiddleware);
    app.get("/api/test", (c) => c.json({ user: c.get("user") }));

    const env = createEnv({ CAIL_IDENTITY_JWKS: identityJwks });
    const response = await app.request(
      "http://site-studio.test/api/test",
      { headers: { "X-CAIL-Subject": canonicalTestSubject("forged-header") } },
      env
    );

    expect(response.status).toBe(401);
  });
});

// ---- First-login anonymous-data migration (lib/migration.ts) ----

function createLiveKV() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string, type?: string) => {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, String(value));
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    })
  } as unknown as KVNamespace & { store: Map<string, string> };
}

function createLiveBucket() {
  const store = new Map<string, string>();
  return {
    store,
    head: vi.fn(async (key: string) => (store.has(key) ? { key } : null)),
    get: vi.fn(async (key: string) => {
      const data = store.get(key);
      if (data === undefined) return null;
      return {
        key,
        httpMetadata: {},
        text: async () => data,
        arrayBuffer: async () => new TextEncoder().encode(data).buffer
      };
    }),
    put: vi.fn(async (key: string, value: any) => {
      store.set(key, typeof value === "string" ? value : new TextDecoder().decode(value));
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async ({ prefix, limit }: any = {}) => {
      const objects = [...store.keys()]
        .filter((key) => !prefix || key.startsWith(prefix))
        .map((key) => ({ key, size: 0, uploaded: new Date(), httpMetadata: {} }));
      return {
        objects: limit ? objects.slice(0, limit) : objects,
        truncated: false,
        delimitedPrefixes: []
      };
    })
  } as unknown as R2Bucket & { store: Map<string, string> };
}

function seedLegacySession(
  bucket: ReturnType<typeof createLiveBucket>,
  sessionId: string,
  userId: string,
) {
  bucket.store.set(
    `sessions/${sessionId}.json`,
    JSON.stringify({
      expiresAt: "2099-01-01T00:00:00.000Z",
      user: { id: userId, createdAt: "2026-01-01T00:00:00.000Z" },
    })
  );
}

describe("authMiddleware anonymous-data migration", () => {
  const SUBJECT = canonicalTestSubject("migration-owner"); // cail-f4729c5b5359d13d2cd445c3151109d3
  const ANON = "user_anon42";

  function buildApp() {
    const app = new Hono<{ Bindings: Env; Variables: { user: { id: string; createdAt: string } } }>();
    app.use("*", authMiddleware);
    app.get("/api/test", (c) => c.json({ user: c.get("user") }));
    return app;
  }

  it("migrates the anonymous namespace on the first authenticated request carrying the anon cookie", async () => {
    const kv = createLiveKV();
    const bucket = createLiveBucket();
    seedLegacySession(bucket, "anon-cookie-1", ANON);
    bucket.store.set(
      `projects/${ANON}/blog/.metadata.json`,
      JSON.stringify({ id: "blog", name: "blog", createdAt: "x", updatedAt: "x", published: false })
    );
    bucket.store.set(`projects/${ANON}/blog/index.html`, "<h1>anon blog</h1>");

    const env = createEnv({
      CAIL_IDENTITY_JWKS: identityJwks,
      SESSION_KV: kv,
      SITE_STUDIO_BUCKET: bucket
    });

    const token = await mintIdentityJwt(SUBJECT);
    const response = await buildApp().request(
      "http://site-studio.test/api/test",
      { headers: { "X-CAIL-Identity-JWT": token, Cookie: "site-studio-session=anon-cookie-1" } },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { user: { id: string } };
    expect(body.user.id).toBe(SUBJECT);
    expect(response.headers.get("set-cookie")).toMatch(/site-studio-session=;[^\r\n]*Max-Age=0/);

    // Data re-homed to the subject; originals gone; claim recorded complete.
    expect(bucket.store.get(`projects/${SUBJECT}/blog/index.html`)).toBe("<h1>anon blog</h1>");
    expect(bucket.store.has(`projects/${ANON}/blog/index.html`)).toBe(false);
    const claim = JSON.parse(kv.store.get(`migration:${ANON}`)!);
    expect(claim).toMatchObject({ subject: SUBJECT, status: "complete" });
    expect(bucket.store.has("sessions/anon-cookie-1.json")).toBe(false);
    expect(bucket.store.has(`imports/${encodeURIComponent(SUBJECT)}`)).toBe(true);
  });

  it("does not rerun import after the per-subject completion record exists", async () => {
    const kv = createLiveKV();
    const bucket = createLiveBucket();
    seedLegacySession(bucket, "anon-cookie-repeat", ANON);
    bucket.store.set(
      `projects/${ANON}/blog/.metadata.json`,
      JSON.stringify({ id: "blog", name: "blog", createdAt: "x", updatedAt: "x", published: false })
    );
    bucket.store.set(`projects/${ANON}/blog/index.html`, "<h1>anon blog</h1>");

    const migrateAnonymous = vi.fn(
      (anonUserId: string, subject: string, anonSessionId?: string) =>
        migrateAnonymousData({
          bucket,
          kv,
          anonUserId,
          subject,
          publishedBaseUrl: env.PUBLISHED_BASE_URL!,
          anonSessionId,
        })
    );
    const env = createEnv({
      CAIL_IDENTITY_JWKS: identityJwks,
      SESSION_KV: kv,
      SITE_STUDIO_BUCKET: bucket,
      MUTATION_COORDINATOR: {
        idFromName: (name: string) => name as unknown as DurableObjectId,
        get: () => ({ migrateAnonymous }),
      } as unknown as Env["MUTATION_COORDINATOR"],
    });
    const token = await mintIdentityJwt(SUBJECT);

    const first = await buildApp().request(
      "http://site-studio.test/api/test",
      { headers: { "X-CAIL-Identity-JWT": token, Cookie: "site-studio-session=anon-cookie-repeat" } },
      env
    );
    expect(first.status).toBe(200);
    expect(migrateAnonymous).toHaveBeenCalledTimes(1);

    const repeat = await buildApp().request(
      "http://site-studio.test/api/test",
      { headers: { "X-CAIL-Identity-JWT": token, Cookie: `site-studio-session=${SUBJECT}` } },
      env
    );
    expect(repeat.status).toBe(200);
    expect(migrateAnonymous).toHaveBeenCalledTimes(1);
    expect(bucket.store.get(`projects/${SUBJECT}/blog/index.html`)).toBe("<h1>anon blog</h1>");
  });

  it("closes first-login import without guessing when no legacy source resolves", async () => {
    const kv = createLiveKV();
    const bucket = createLiveBucket();
    const env = createEnv({
      CAIL_IDENTITY_JWKS: identityJwks,
      SESSION_KV: kv,
      SITE_STUDIO_BUCKET: bucket,
    });
    const token = await mintIdentityJwt(SUBJECT);

    const first = await buildApp().request(
      "http://site-studio.test/api/test",
      { headers: { "X-CAIL-Identity-JWT": token, Cookie: "site-studio-session=unresolvable" } },
      env
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("set-cookie")).toMatch(/site-studio-session=;[^\r\n]*Max-Age=0/);
    expect(bucket.store.has(`imports/${encodeURIComponent(SUBJECT)}`)).toBe(true);

    // A later caller cannot turn an unrelated legacy cookie into a second
    // import opportunity for this already-established subject.
    seedLegacySession(bucket, "late-cookie", ANON);
    bucket.store.set(`projects/${ANON}/blog/index.html`, "<h1>leave in place</h1>");
    const later = await buildApp().request(
      "http://site-studio.test/api/test",
      { headers: { "X-CAIL-Identity-JWT": token, Cookie: "site-studio-session=late-cookie" } },
      env
    );
    expect(later.status).toBe(200);
    expect(bucket.store.has(`projects/${SUBJECT}/blog/index.html`)).toBe(false);
    expect(bucket.store.get(`projects/${ANON}/blog/index.html`)).toBe("<h1>leave in place</h1>");
  });

  it("leaves import incomplete on failure and succeeds on a later login retry", async () => {
    const kv = createLiveKV();
    const bucket = createLiveBucket();
    seedLegacySession(bucket, "anon-cookie-retry", ANON);
    bucket.store.set(
      `projects/${ANON}/blog/.metadata.json`,
      JSON.stringify({ id: "blog", name: "blog", createdAt: "x", updatedAt: "x", published: false })
    );
    bucket.store.set(`projects/${ANON}/blog/index.html`, "<h1>anon blog</h1>");

    let attempts = 0;
    const env = createEnv({
      CAIL_IDENTITY_JWKS: identityJwks,
      SESSION_KV: kv,
      SITE_STUDIO_BUCKET: bucket,
    });
    env.MUTATION_COORDINATOR = {
      idFromName: (name: string) => name as unknown as DurableObjectId,
      get: () => ({
        migrateAnonymous: async (anonUserId: string, subject: string, anonSessionId?: string) => {
          attempts += 1;
          if (attempts === 1) throw new Error("injected import failure");
          return migrateAnonymousData({
            bucket,
            kv,
            anonUserId,
            subject,
            publishedBaseUrl: env.PUBLISHED_BASE_URL!,
            anonSessionId,
          });
        },
      }),
    } as unknown as Env["MUTATION_COORDINATOR"];
    const token = await mintIdentityJwt(SUBJECT);

    const first = await buildApp().request(
      "http://site-studio.test/api/test",
      { headers: { "X-CAIL-Identity-JWT": token, Cookie: "site-studio-session=anon-cookie-retry" } },
      env
    );
    expect(first.status).toBe(503);
    const privateError = await first.text();
    expect(privateError).toContain("session_store_unavailable");
    expect(privateError).not.toContain(SUBJECT);
    expect(privateError).not.toContain(ANON);
    expect(first.headers.get("set-cookie")).toBeNull();
    expect(bucket.store.has(`imports/${encodeURIComponent(SUBJECT)}`)).toBe(false);
    expect(bucket.store.has("sessions/anon-cookie-retry.json")).toBe(true);

    const retry = await buildApp().request(
      "http://site-studio.test/api/test",
      { headers: { "X-CAIL-Identity-JWT": token, Cookie: "site-studio-session=anon-cookie-retry" } },
      env
    );
    expect(retry.status).toBe(200);
    expect(attempts).toBe(2);
    expect(bucket.store.get(`projects/${SUBJECT}/blog/index.html`)).toBe("<h1>anon blog</h1>");
    expect(bucket.store.has(`projects/${ANON}/blog/index.html`)).toBe(false);
    expect(bucket.store.has(`imports/${encodeURIComponent(SUBJECT)}`)).toBe(true);
  });

  it("does not complete or retire a legacy session when the durable migration claim refuses", async () => {
    const kv = createLiveKV();
    const bucket = createLiveBucket();
    const otherSubject = canonicalTestSubject("prior-migration-owner");
    seedLegacySession(bucket, "anon-cookie-refused", ANON);
    kv.store.set(
      `migration:${ANON}`,
      JSON.stringify({ subject: otherSubject, status: "complete", startedAt: "x" })
    );
    const env = createEnv({
      CAIL_IDENTITY_JWKS: identityJwks,
      SESSION_KV: kv,
      SITE_STUDIO_BUCKET: bucket,
    });
    const token = await mintIdentityJwt(SUBJECT);

    const response = await buildApp().request(
      "http://site-studio.test/api/test",
      { headers: { "X-CAIL-Identity-JWT": token, Cookie: "site-studio-session=anon-cookie-refused" } },
      env
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(bucket.store.has(`imports/${encodeURIComponent(SUBJECT)}`)).toBe(false);
    expect(bucket.store.has("sessions/anon-cookie-refused.json")).toBe(true);
  });

  it("retries when legacy session retirement fails before completion", async () => {
    const kv = createLiveKV();
    const bucket = createLiveBucket();
    seedLegacySession(bucket, "anon-cookie-retire", ANON);
    bucket.store.set(
      `projects/${ANON}/blog/.metadata.json`,
      JSON.stringify({ id: "blog", name: "blog", createdAt: "x", updatedAt: "x", published: false })
    );
    bucket.store.set(`projects/${ANON}/blog/index.html`, "<h1>anon blog</h1>");
    const originalDelete = bucket.delete.bind(bucket);
    let failRetirement = true;
    bucket.delete = vi.fn(async (key: string) => {
      if (key === "sessions/anon-cookie-retire.json" && failRetirement) {
        failRetirement = false;
        throw new Error("injected retirement failure");
      }
      return originalDelete(key);
    }) as typeof bucket.delete;
    const env = createEnv({
      CAIL_IDENTITY_JWKS: identityJwks,
      SESSION_KV: kv,
      SITE_STUDIO_BUCKET: bucket,
    });
    const token = await mintIdentityJwt(SUBJECT);

    const first = await buildApp().request(
      "http://site-studio.test/api/test",
      { headers: { "X-CAIL-Identity-JWT": token, Cookie: "site-studio-session=anon-cookie-retire" } },
      env
    );
    expect(first.status).toBe(503);
    expect(first.headers.get("set-cookie")).toBeNull();
    expect(bucket.store.has(`imports/${encodeURIComponent(SUBJECT)}`)).toBe(false);
    expect(bucket.store.has("sessions/anon-cookie-retire.json")).toBe(true);

    const retry = await buildApp().request(
      "http://site-studio.test/api/test",
      { headers: { "X-CAIL-Identity-JWT": token, Cookie: "site-studio-session=anon-cookie-retire" } },
      env
    );
    expect(retry.status).toBe(200);
    expect(bucket.store.has("sessions/anon-cookie-retire.json")).toBe(false);
    expect(bucket.store.has(`imports/${encodeURIComponent(SUBJECT)}`)).toBe(true);
  });

  it("does not import from a legacy session with an invalid expiry", async () => {
    const kv = createLiveKV();
    const bucket = createLiveBucket();
    bucket.store.set(
      "sessions/anon-cookie-invalid-expiry.json",
      JSON.stringify({
        expiresAt: "not-a-date",
        user: { id: ANON, createdAt: "2026-01-01T00:00:00.000Z" },
      })
    );
    bucket.store.set(`projects/${ANON}/blog/index.html`, "<h1>leave in place</h1>");
    const env = createEnv({
      CAIL_IDENTITY_JWKS: identityJwks,
      SESSION_KV: kv,
      SITE_STUDIO_BUCKET: bucket,
    });
    const token = await mintIdentityJwt(SUBJECT);

    const response = await buildApp().request(
      "http://site-studio.test/api/test",
      { headers: { "X-CAIL-Identity-JWT": token, Cookie: "site-studio-session=anon-cookie-invalid-expiry" } },
      env
    );

    expect(response.status).toBe(200);
    expect(bucket.store.has(`projects/${SUBJECT}/blog/index.html`)).toBe(false);
    expect(bucket.store.get(`projects/${ANON}/blog/index.html`)).toBe("<h1>leave in place</h1>");
    expect(bucket.store.has(`imports/${encodeURIComponent(SUBJECT)}`)).toBe(true);
  });

  it("emits completion telemetry without legacy account identifiers", async () => {
    const kv = createLiveKV();
    const bucket = createLiveBucket();
    seedLegacySession(bucket, "anon-cookie-telemetry", ANON);
    const info = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const token = await mintIdentityJwt(SUBJECT);
      const response = await buildApp().request(
        "http://site-studio.test/api/test",
        {
          headers: {
            "X-CAIL-Identity-JWT": token,
            Cookie: "site-studio-session=anon-cookie-telemetry",
          },
        },
        createEnv({
          CAIL_IDENTITY_JWKS: identityJwks,
          SESSION_KV: kv,
          SITE_STUDIO_BUCKET: bucket,
        })
      );

      expect(response.status).toBe(200);
      const events = info.mock.calls.map(([event]) => event as Record<string, unknown>);
      const completed = events.find(
        (event) => event["event.name"] === "site_studio.diagnostic.info"
      );
      expect(completed).toMatchObject({
        "error.type": "account_import_completed",
        "cail.product.id": "site-studio",
      });
      // The ownership subject must never appear in telemetry, and it must not
      // be relabelled into a pseudo id either: the log principal comes only
      // from a verified operational subject (log_sub), which this migration
      // path does not carry, so the event is anonymous.
      expect(completed).not.toHaveProperty("enduser.pseudo.id");
      expect(JSON.stringify(completed)).not.toContain(SUBJECT.slice("cail-".length));
      expect(JSON.stringify(completed)).not.toContain(ANON);
      expect(JSON.stringify(completed)).not.toContain("anon-cookie-telemetry");
    } finally {
      info.mockRestore();
    }
  });

  it("resumes an interrupted migration from the pending marker without the anon cookie", async () => {
    const kv = createLiveKV();
    const bucket = createLiveBucket();
    // Interrupted earlier: claim pending, pending marker set, data still in place.
    kv.store.set(`migration:${ANON}`, JSON.stringify({ subject: SUBJECT, status: "pending", startedAt: "x" }));
    kv.store.set(`migration-pending:${SUBJECT}`, ANON);
    bucket.store.set(
      `projects/${ANON}/blog/.metadata.json`,
      JSON.stringify({ id: "blog", name: "blog", createdAt: "x", updatedAt: "x", published: false })
    );
    bucket.store.set(`projects/${ANON}/blog/index.html`, "<h1>anon blog</h1>");

    const env = createEnv({
      CAIL_IDENTITY_JWKS: identityJwks,
      SESSION_KV: kv,
      SITE_STUDIO_BUCKET: bucket
    });

    const token = await mintIdentityJwt(SUBJECT);
    const response = await buildApp().request(
      "http://site-studio.test/api/test",
      { headers: { "X-CAIL-Identity-JWT": token } }, // no anon cookie any more
      env
    );

    expect(response.status).toBe(200);
    expect(bucket.store.get(`projects/${SUBJECT}/blog/index.html`)).toBe("<h1>anon blog</h1>");
    const claim = JSON.parse(kv.store.get(`migration:${ANON}`)!);
    expect(claim.status).toBe("complete");
    expect(kv.store.has(`migration-pending:${SUBJECT}`)).toBe(false);
  });

  it("fails closed when a pending resume marker points to another subject's claim", async () => {
    const kv = createLiveKV();
    const bucket = createLiveBucket();
    const otherSubject = canonicalTestSubject("resume-owner");
    kv.store.set(
      `migration:${ANON}`,
      JSON.stringify({ subject: otherSubject, status: "pending", startedAt: "x" })
    );
    kv.store.set(`migration-pending:${SUBJECT}`, ANON);
    const env = createEnv({
      CAIL_IDENTITY_JWKS: identityJwks,
      SESSION_KV: kv,
      SITE_STUDIO_BUCKET: bucket,
    });
    const token = await mintIdentityJwt(SUBJECT);

    const response = await buildApp().request(
      "http://site-studio.test/api/test",
      { headers: { "X-CAIL-Identity-JWT": token } },
      env
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(bucket.store.has(`imports/${encodeURIComponent(SUBJECT)}`)).toBe(false);
    expect(kv.store.get(`migration-pending:${SUBJECT}`)).toBe(ANON);
  });

  // SS-3 / SS-19: the anon namespace to absorb is picked from the
  // request-supplied session cookie. If the MigrationCoordinator DO gate reports
  // that namespace is ALREADY claimed by a DIFFERENT subject, a forged/replayed
  // cookie pointing at it must not let a second subject re-home (or even touch)
  // that data — the DO refuses the claim (granted:false) before any work, and
  // the original owner's data is untouched. This is now atomic mutual exclusion,
  // not a racy KV pre-check.
  it("SS-3: refuses to absorb an anon namespace already claimed by another subject", async () => {
    const kv = createLiveKV();
    const bucket = createLiveBucket();
    const OTHER_SUBJECT = canonicalTestSubject("other-owner");

    // A live anon session record still exists (attacker replays this cookie).
    seedLegacySession(bucket, "anon-cookie-1", ANON);
    // Residual anon data that must NOT be re-homed into the new subject.
    bucket.store.set(`projects/${ANON}/blog/index.html`, "<h1>anon blog</h1>");

    const coordinator = createCoordinatorNamespace();
    // The anon namespace was already claimed by OTHER_SUBJECT at the DO gate.
    coordinator.records.set(ANON, { subject: OTHER_SUBJECT, status: "complete" });

    const env = createEnv({
      CAIL_IDENTITY_JWKS: identityJwks,
      SESSION_KV: kv,
      SITE_STUDIO_BUCKET: bucket,
      MIGRATION_COORDINATOR: coordinator.namespace
    });

    const token = await mintIdentityJwt(SUBJECT); // a DIFFERENT, second subject
    const response = await buildApp().request(
      "http://site-studio.test/api/test",
      { headers: { "X-CAIL-Identity-JWT": token, Cookie: "site-studio-session=anon-cookie-1" } },
      env
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "session_store_unavailable"
    });
    expect(response.headers.get("set-cookie")).toBeNull();

    // Nothing re-homed into SUBJECT; the DO claim still owned by OTHER_SUBJECT.
    expect(bucket.store.has(`projects/${SUBJECT}/blog/index.html`)).toBe(false);
    expect(coordinator.records.get(ANON)?.subject).toBe(OTHER_SUBJECT);
    // No KV claim or pending marker was written for SUBJECT (we bailed at the gate).
    expect(kv.store.has(`migration:${ANON}`)).toBe(false);
    expect(kv.store.has(`migration-pending:${SUBJECT}`)).toBe(false);
    expect(bucket.store.has(`imports/${encodeURIComponent(SUBJECT)}`)).toBe(false);
  });

  // SS-3: two DIFFERENT subjects presenting the SAME anon cookie — the classic
  // split-brain. The DO gate serializes them to one first-winner; the second is
  // refused and absorbs nothing, so data can never land under two owners.
  it("SS-3: two different subjects racing the same anon cookie — first wins, second refused", async () => {
    const kv = createLiveKV();
    const bucket = createLiveBucket();
    const SUBJECT_A = canonicalTestSubject("race-subject-a");
    const SUBJECT_B = canonicalTestSubject("race-subject-b");

    seedLegacySession(bucket, "anon-cookie-1", ANON);
    bucket.store.set(
      `projects/${ANON}/blog/.metadata.json`,
      JSON.stringify({ id: "blog", name: "blog", createdAt: "x", updatedAt: "x", published: false })
    );
    bucket.store.set(`projects/${ANON}/blog/index.html`, "<h1>anon blog</h1>");

    // One shared coordinator across both requests (models the single DO instance
    // that all claimants of this anonId reach).
    const coordinator = createCoordinatorNamespace();
    const env = createEnv({
      CAIL_IDENTITY_JWKS: identityJwks,
      SESSION_KV: kv,
      SITE_STUDIO_BUCKET: bucket,
      MIGRATION_COORDINATOR: coordinator.namespace
    });

    const tokenA = await mintIdentityJwt(SUBJECT_A);
    const respA = await buildApp().request(
      "http://site-studio.test/api/test",
      { headers: { "X-CAIL-Identity-JWT": tokenA, Cookie: "site-studio-session=anon-cookie-1" } },
      env
    );
    expect(respA.status).toBe(200);

    // A won the DO gate and migrated.
    expect(bucket.store.get(`projects/${SUBJECT_A}/blog/index.html`)).toBe("<h1>anon blog</h1>");
    expect(coordinator.records.get(ANON)?.subject).toBe(SUBJECT_A);

    // B now presents the same anon cookie after a replay/concurrent browser
    // retained the old legacy record.
    seedLegacySession(bucket, "anon-cookie-1", ANON);
    const tokenB = await mintIdentityJwt(SUBJECT_B);
    const respB = await buildApp().request(
      "http://site-studio.test/api/test",
      { headers: { "X-CAIL-Identity-JWT": tokenB, Cookie: "site-studio-session=anon-cookie-1" } },
      env
    );
    expect(respB.status).toBe(503);
    expect(respB.headers.get("set-cookie")).toBeNull();

    // B was refused — nothing landed under SUBJECT_B; the anon namespace stays
    // bound to SUBJECT_A. No split brain.
    expect(bucket.store.has(`projects/${SUBJECT_B}/blog/index.html`)).toBe(false);
    expect(coordinator.records.get(ANON)?.subject).toBe(SUBJECT_A);
    expect(bucket.store.has(`imports/${encodeURIComponent(SUBJECT_B)}`)).toBe(false);
  });

  // ---- SS-46: storage outage must never read as "record absent" ----
  // An outage while resolving the anon cookie (or while establishing migration
  // resumability) must fail loud with a 503 and leave the anon cookie intact.
  // The old behavior swallowed the outage, skipped migration, and cleared the
  // anon cookie — permanently orphaning the pre-SSO
  // namespace in R2.

  it("SS-46: R2 outage during SSO first login fails 503 and does not orphan the anon namespace", async () => {
    const bucket = createLiveBucket();
    bucket.store.set(`projects/${ANON}/blog/index.html`, "<h1>anon blog</h1>");

    const get = bucket.get as ReturnType<typeof vi.fn>;
    get.mockRejectedValue(new Error("R2 transport failure"));
    const env = createEnv({
      CAIL_IDENTITY_JWKS: identityJwks,
      SITE_STUDIO_BUCKET: bucket
    });

    const token = await mintIdentityJwt(SUBJECT);
    const response = await buildApp().request(
      "http://site-studio.test/api/test",
      { headers: { "X-CAIL-Identity-JWT": token, Cookie: "site-studio-session=anon-cookie-1" } },
      env
    );

    // Fail loud and retryable — NOT a 200 that clears the anon cookie.
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("session_store_unavailable");
    // The anon cookie is retained for a retry.
    expect(response.headers.get("set-cookie")).toBeNull();
    // The anonymous data is untouched.
    expect(bucket.store.get(`projects/${ANON}/blog/index.html`)).toBe("<h1>anon blog</h1>");
  });

  it("SS-46: coordinator outage during SSO first login fails 503 instead of skipping migration and overwriting the cookie", async () => {
    const kv = createLiveKV();
    const bucket = createLiveBucket();
    seedLegacySession(bucket, "anon-cookie-1", ANON);
    bucket.store.set(`projects/${ANON}/blog/index.html`, "<h1>anon blog</h1>");

    const env = createEnv({
      CAIL_IDENTITY_JWKS: identityJwks,
      SESSION_KV: kv,
      SITE_STUDIO_BUCKET: bucket,
      MIGRATION_COORDINATOR: {
        idFromName: (name: string) => name,
        get: () => ({
          claim: async () => {
            throw new Error("DO unreachable");
          },
          markComplete: async () => undefined
        })
      } as unknown as Env["MIGRATION_COORDINATOR"]
    });

    const token = await mintIdentityJwt(SUBJECT);
    const response = await buildApp().request(
      "http://site-studio.test/api/test",
      { headers: { "X-CAIL-Identity-JWT": token, Cookie: "site-studio-session=anon-cookie-1" } },
      env
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
    // Nothing migrated, no marker written, anon data untouched.
    expect([...kv.store.keys()].filter((k) => k.startsWith("migration"))).toEqual([]);
    expect(bucket.store.get(`projects/${ANON}/blog/index.html`)).toBe("<h1>anon blog</h1>");
  });

  it("SS-46: migration failure before the pending marker exists fails 503 rather than being swallowed", async () => {
    const kv = createLiveKV();
    const bucket = createLiveBucket();
    seedLegacySession(bucket, "anon-cookie-1", ANON);
    bucket.store.set(`projects/${ANON}/blog/index.html`, "<h1>anon blog</h1>");

    // Writes to the migration claim/marker keys fail (pre-marker outage window);
    // everything else works.
    const put = kv.put as ReturnType<typeof vi.fn>;
    put.mockImplementation(async (key: string, value: string) => {
      if (key.startsWith("migration")) {
        throw new Error("KV write failure");
      }
      kv.store.set(key, String(value));
    });

    const env = createEnv({
      CAIL_IDENTITY_JWKS: identityJwks,
      SESSION_KV: kv,
      SITE_STUDIO_BUCKET: bucket
    });

    const token = await mintIdentityJwt(SUBJECT);
    const response = await buildApp().request(
      "http://site-studio.test/api/test",
      { headers: { "X-CAIL-Identity-JWT": token, Cookie: "site-studio-session=anon-cookie-1" } },
      env
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(bucket.store.get(`projects/${ANON}/blog/index.html`)).toBe("<h1>anon blog</h1>");
  });

});
