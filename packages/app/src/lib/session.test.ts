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
    MIGRATION_COORDINATOR: createCoordinatorNamespace().namespace,
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

describe("authMiddleware anonymous-data migration", () => {
  const SUBJECT = "cail-subject-xyz";
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
    kv.store.set(
      "session:anon-cookie-1",
      JSON.stringify({ id: ANON, createdAt: "2026-01-01T00:00:00.000Z" })
    );
    bucket.store.set(
      `projects/${ANON}/blog/.metadata.json`,
      JSON.stringify({ id: "blog", name: "blog", createdAt: "x", updatedAt: "x", published: false })
    );
    bucket.store.set(`projects/${ANON}/blog/index.html`, "<h1>anon blog</h1>");

    const env = createEnv({
      CAIL_IDENTITY_JWT_SECRET: JWT_SECRET,
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

    // Data re-homed to the subject; originals gone; claim recorded complete.
    expect(bucket.store.get(`projects/${SUBJECT}/blog/index.html`)).toBe("<h1>anon blog</h1>");
    expect(bucket.store.has(`projects/${ANON}/blog/index.html`)).toBe(false);
    const claim = JSON.parse(kv.store.get(`migration:${ANON}`)!);
    expect(claim).toMatchObject({ subject: SUBJECT, status: "complete" });
    // The anonymous KV session is retired.
    expect(kv.store.has("session:anon-cookie-1")).toBe(false);
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
      CAIL_IDENTITY_JWT_SECRET: JWT_SECRET,
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
    const OTHER_SUBJECT = "cail-other-owner";

    // A live anon session record still exists (attacker replays this cookie).
    kv.store.set(
      "session:anon-cookie-1",
      JSON.stringify({ id: ANON, createdAt: "2026-01-01T00:00:00.000Z" })
    );
    // Residual anon data that must NOT be re-homed into the new subject.
    bucket.store.set(`projects/${ANON}/blog/index.html`, "<h1>anon blog</h1>");

    const coordinator = createCoordinatorNamespace();
    // The anon namespace was already claimed by OTHER_SUBJECT at the DO gate.
    coordinator.records.set(ANON, { subject: OTHER_SUBJECT, status: "complete" });

    const env = createEnv({
      CAIL_IDENTITY_JWT_SECRET: JWT_SECRET,
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

    expect(response.status).toBe(200);
    const body = (await response.json()) as { user: { id: string } };
    expect(body.user.id).toBe(SUBJECT);

    // Nothing re-homed into SUBJECT; the DO claim still owned by OTHER_SUBJECT.
    expect(bucket.store.has(`projects/${SUBJECT}/blog/index.html`)).toBe(false);
    expect(coordinator.records.get(ANON)?.subject).toBe(OTHER_SUBJECT);
    // No KV claim or pending marker was written for SUBJECT (we bailed at the gate).
    expect(kv.store.has(`migration:${ANON}`)).toBe(false);
    expect(kv.store.has(`migration-pending:${SUBJECT}`)).toBe(false);
  });

  // SS-3: two DIFFERENT subjects presenting the SAME anon cookie — the classic
  // split-brain. The DO gate serializes them to one first-winner; the second is
  // refused and absorbs nothing, so data can never land under two owners.
  it("SS-3: two different subjects racing the same anon cookie — first wins, second refused", async () => {
    const kv = createLiveKV();
    const bucket = createLiveBucket();
    const SUBJECT_A = "cail-first-winner";
    const SUBJECT_B = "cail-second-loser";

    kv.store.set(
      "session:anon-cookie-1",
      JSON.stringify({ id: ANON, createdAt: "2026-01-01T00:00:00.000Z" })
    );
    bucket.store.set(
      `projects/${ANON}/blog/.metadata.json`,
      JSON.stringify({ id: "blog", name: "blog", createdAt: "x", updatedAt: "x", published: false })
    );
    bucket.store.set(`projects/${ANON}/blog/index.html`, "<h1>anon blog</h1>");

    // One shared coordinator across both requests (models the single DO instance
    // that all claimants of this anonId reach).
    const coordinator = createCoordinatorNamespace();
    const env = createEnv({
      CAIL_IDENTITY_JWT_SECRET: JWT_SECRET,
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

    // B now presents the same anon cookie (the session was deleted on A's
    // completion, but re-seed it to model a replay/concurrent presentation).
    kv.store.set(
      "session:anon-cookie-1",
      JSON.stringify({ id: ANON, createdAt: "2026-01-01T00:00:00.000Z" })
    );
    const tokenB = await mintIdentityJwt(SUBJECT_B);
    const respB = await buildApp().request(
      "http://site-studio.test/api/test",
      { headers: { "X-CAIL-Identity-JWT": tokenB, Cookie: "site-studio-session=anon-cookie-1" } },
      env
    );
    expect(respB.status).toBe(200);

    // B was refused — nothing landed under SUBJECT_B; the anon namespace stays
    // bound to SUBJECT_A. No split brain.
    expect(bucket.store.has(`projects/${SUBJECT_B}/blog/index.html`)).toBe(false);
    expect(coordinator.records.get(ANON)?.subject).toBe(SUBJECT_A);
  });

  it("pure anonymous flow is untouched: no migration traces, data stays put", async () => {
    const kv = createLiveKV();
    const bucket = createLiveBucket();
    bucket.store.set(`projects/${ANON}/blog/index.html`, "<h1>anon blog</h1>");
    kv.store.set(
      "session:anon-cookie-1",
      JSON.stringify({ id: ANON, createdAt: "2026-01-01T00:00:00.000Z" })
    );

    const env = createEnv({
      CAIL_IDENTITY_JWT_SECRET: JWT_SECRET, // secret set, but no JWT on the request
      SESSION_KV: kv,
      SITE_STUDIO_BUCKET: bucket
    });

    const response = await buildApp().request(
      "http://site-studio.test/api/test",
      { headers: { Cookie: "site-studio-session=anon-cookie-1" } },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { user: { id: string } };
    expect(body.user.id).toBe(ANON); // same anonymous identity as before

    // No claim, no pointer, nothing moved or deleted.
    expect([...kv.store.keys()].filter((k) => k.startsWith("migration"))).toEqual([]);
    expect(bucket.store.get(`projects/${ANON}/blog/index.html`)).toBe("<h1>anon blog</h1>");
    expect([...bucket.store.keys()].some((k) => k.includes("cail-"))).toBe(false);
  });
});
