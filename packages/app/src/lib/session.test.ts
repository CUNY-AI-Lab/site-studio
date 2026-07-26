import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
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

beforeAll(async () => {
  // Kit default issuer is the canonical production issuer this suite configures.
  identityIssuer = await createTestIdentityIssuer({ kid: "session-test" });
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
  const now = Date.now();
  const env: Env = {
    APP_PUBLIC_DOMAIN: "https://tools.ailab.gc.cuny.edu",
    LOADER: {} as WorkerLoader,
    CAIL_API_BASE: "https://cail.example/proxy",
    CAIL_IDENTITY_ISSUER: "https://tools.ailab.gc.cuny.edu/cail-sso",
    CAIL_MODEL: "test-model",
    CAIL_SSO_SWITCHED_AT: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    CAIL_ACCOUNT_IMPORT_UNTIL: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
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
          anonSessionId
        })
    })
  } as unknown as Env["MUTATION_COORDINATOR"];
  return env;
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
        })),
        put: vi.fn(async (key: string) => ({ key }))
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
    // Session is bound to the subject, not a random cookie id.
    expect(response.headers.get("set-cookie")).toContain(`site-studio-session=${subject}`);
  });

  it("returns the authentication_required envelope when identity is required but absent", async () => {
    const app = new Hono<{ Bindings: Env; Variables: { user: { id: string; createdAt: string } } }>();
    app.use("*", authMiddleware);
    app.get("/api/test", (c) => c.json({ user: c.get("user") }));

    const env = createEnv({
      CAIL_IDENTITY_JWKS: identityJwks,
      CAIL_REQUIRE_IDENTITY: "true"
    });

    const response = await app.request("http://site-studio.test/api/test", {}, env);
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("authentication_required");
  });

  it.each([
    {
      name: "missing",
      config: { CAIL_SSO_SWITCHED_AT: undefined },
    },
    {
      name: "longer than 30 days",
      config: {
        CAIL_SSO_SWITCHED_AT: "2026-07-01T00:00:00.000Z",
        CAIL_ACCOUNT_IMPORT_UNTIL: "2026-08-01T00:00:00.001Z",
      },
    },
  ])("fails loudly when enforced identity has $name import-window configuration", async ({ config }) => {
    const app = new Hono<{ Bindings: Env; Variables: { user: { id: string; createdAt: string } } }>();
    app.use("*", authMiddleware);
    app.get("/api/test", (c) => c.json({ user: c.get("user") }));

    const response = await app.request(
      "http://site-studio.test/api/test",
      {},
      createEnv({ CAIL_REQUIRE_IDENTITY: "true", ...config })
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_account_import_configuration",
    });
  });

  it("rejects a presented invalid identity token even when identity is optional", async () => {
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

  it("ignores a bare X-CAIL-Subject header and falls back to anonymous", async () => {
    const app = new Hono<{ Bindings: Env; Variables: { user: { id: string; createdAt: string } } }>();
    app.use("*", authMiddleware);
    app.get("/api/test", (c) => c.json({ user: c.get("user") }));

    const env = createEnv({ CAIL_IDENTITY_JWKS: identityJwks });
    const response = await app.request(
      "http://site-studio.test/api/test",
      { headers: { "X-CAIL-Subject": canonicalTestSubject("forged-header") } },
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

    // Data re-homed to the subject; originals gone; claim recorded complete.
    expect(bucket.store.get(`projects/${SUBJECT}/blog/index.html`)).toBe("<h1>anon blog</h1>");
    expect(bucket.store.has(`projects/${ANON}/blog/index.html`)).toBe(false);
    const claim = JSON.parse(kv.store.get(`migration:${ANON}`)!);
    expect(claim).toMatchObject({ subject: SUBJECT, status: "complete" });
    // The anonymous KV session is retired.
    expect(kv.store.has("session:anon-cookie-1")).toBe(false);
  });

  it("emits completion telemetry without legacy account identifiers", async () => {
    const kv = createLiveKV();
    const bucket = createLiveBucket();
    kv.store.set(
      "session:anon-cookie-telemetry",
      JSON.stringify({ id: ANON, createdAt: "2026-01-01T00:00:00.000Z" })
    );
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

  it("refuses an expired import without reading legacy session material and clears resume state", async () => {
    const kv = createLiveKV();
    const bucket = createLiveBucket();
    const now = Date.now();
    kv.store.set(
      "session:anon-cookie-1",
      JSON.stringify({ id: ANON, createdAt: "2026-01-01T00:00:00.000Z" })
    );
    kv.store.set(`migration-pending:${SUBJECT}`, ANON);
    bucket.store.set(`projects/${ANON}/blog/index.html`, "<h1>anon blog</h1>");
    const coordinator = createCoordinatorNamespace();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const env = createEnv({
        CAIL_IDENTITY_JWKS: identityJwks,
        CAIL_REQUIRE_IDENTITY: "true",
        CAIL_SSO_SWITCHED_AT: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
        CAIL_ACCOUNT_IMPORT_UNTIL: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
        SESSION_KV: kv,
        SITE_STUDIO_BUCKET: bucket,
        MIGRATION_COORDINATOR: coordinator.namespace,
      });
      const token = await mintIdentityJwt(SUBJECT);
      const response = await buildApp().request(
        "http://site-studio.test/api/test",
        { headers: { "X-CAIL-Identity-JWT": token, Cookie: "site-studio-session=anon-cookie-1" } },
        env
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toContain(`site-studio-session=${SUBJECT}`);
      expect(kv.store.has(`migration-pending:${SUBJECT}`)).toBe(false);
      expect(kv.store.has("session:anon-cookie-1")).toBe(true);
      expect(bucket.store.get(`projects/${ANON}/blog/index.html`)).toBe("<h1>anon blog</h1>");
      expect(coordinator.records.size).toBe(0);
      expect(kv.get).not.toHaveBeenCalledWith("session:anon-cookie-1", "text");

      const events = warn.mock.calls.map(([event]) => event as Record<string, unknown>);
      expect(events).toContainEqual(
        expect.objectContaining({
          "event.name": "site_studio.diagnostic.warning",
          "error.type": "account_import_expired",
        })
      );
    } finally {
      warn.mockRestore();
    }
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
    const SUBJECT_A = canonicalTestSubject("race-subject-a");
    const SUBJECT_B = canonicalTestSubject("race-subject-b");

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

  // ---- SS-46: storage outage must never read as "record absent" ----
  // An outage while resolving the anon cookie (or while establishing migration
  // resumability) must fail loud with a 503 and leave the anon cookie intact.
  // The old behavior swallowed the outage, skipped migration, and overwrote the
  // anon cookie with the subject cookie — permanently orphaning the pre-SSO
  // namespace in R2.

  it("SS-46: KV outage during SSO first login fails 503 and does not orphan the anon namespace", async () => {
    const bucket = createLiveBucket();
    bucket.store.set(`projects/${ANON}/blog/index.html`, "<h1>anon blog</h1>");

    const kvPut = vi.fn(async () => undefined);
    const env = createEnv({
      CAIL_IDENTITY_JWKS: identityJwks,
      SESSION_KV: {
        // Transient outage: reads fail, writes would succeed.
        get: vi.fn(async () => {
          throw new Error("KV transport failure");
        }),
        put: kvPut
      } as unknown as KVNamespace,
      SITE_STUDIO_BUCKET: bucket
    });

    const token = await mintIdentityJwt(SUBJECT);
    const response = await buildApp().request(
      "http://site-studio.test/api/test",
      { headers: { "X-CAIL-Identity-JWT": token, Cookie: "site-studio-session=anon-cookie-1" } },
      env
    );

    // Fail loud and retryable — NOT a 200 that overwrites the anon cookie.
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("session_store_unavailable");
    // The anon cookie is NOT replaced by the subject cookie.
    expect(response.headers.get("set-cookie")).toBeNull();
    // The anonymous data is untouched.
    expect(bucket.store.get(`projects/${ANON}/blog/index.html`)).toBe("<h1>anon blog</h1>");
  });

  it("SS-46: coordinator outage during SSO first login fails 503 instead of skipping migration and overwriting the cookie", async () => {
    const kv = createLiveKV();
    const bucket = createLiveBucket();
    kv.store.set(
      "session:anon-cookie-1",
      JSON.stringify({ id: ANON, createdAt: "2026-01-01T00:00:00.000Z" })
    );
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
    kv.store.set(
      "session:anon-cookie-1",
      JSON.stringify({ id: ANON, createdAt: "2026-01-01T00:00:00.000Z" })
    );
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

  it("SS-46: KV outage on the pure anonymous path fails 503 instead of minting a fresh identity", async () => {
    const kvPut = vi.fn(async () => undefined);
    const env = createEnv({
      CAIL_IDENTITY_JWKS: identityJwks,
      SESSION_KV: {
        get: vi.fn(async () => {
          throw new Error("KV transport failure");
        }),
        put: kvPut
      } as unknown as KVNamespace
    });

    const response = await buildApp().request(
      "http://site-studio.test/api/test",
      { headers: { Cookie: "site-studio-session=anon-cookie-1" } },
      env
    );

    // Old behavior: 200 with a FRESH user_/session cookie, orphaning the
    // previous workspace. New behavior: loud, retryable failure.
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("session_store_unavailable");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(kvPut).not.toHaveBeenCalled();
  });

  it("SS-46: an invalid stored KV session (not an outage) still falls through to a fresh anonymous session", async () => {
    const kv = createLiveKV();
    kv.store.set("session:anon-cookie-1", "{corrupt json");

    const env = createEnv({ SESSION_KV: kv });
    const response = await buildApp().request(
      "http://site-studio.test/api/test",
      { headers: { Cookie: "site-studio-session=anon-cookie-1" } },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { user: { id: string } };
    expect(body.user.id).toMatch(/^user_/);
    expect(response.headers.get("set-cookie")).toContain("site-studio-session=");
  });

  it("keeps a new anonymous identity when the next colo cannot see its KV write", async () => {
    const kv = createLiveKV();
    const bucket = createLiveBucket();
    const testEnv = createEnv({ SESSION_KV: kv, SITE_STUDIO_BUCKET: bucket });

    const first = await buildApp().request("http://site-studio.test/api/test", {}, testEnv);
    expect(first.status).toBe(200);
    const original = (await first.json()) as { user: { id: string } };
    const cookie = first.headers.get("set-cookie")?.match(/site-studio-session=([^;]+)/)?.[1];
    expect(cookie).toBeTruthy();

    // Simulate a read in a colo where the just-written KV value has not arrived.
    kv.store.delete(`session:${cookie}`);
    const second = await buildApp().request(
      "http://site-studio.test/api/test",
      { headers: { Cookie: `site-studio-session=${cookie}` } },
      testEnv
    );

    expect(second.status).toBe(200);
    expect(((await second.json()) as { user: { id: string } }).user.id).toBe(original.user.id);
    expect(second.headers.get("set-cookie")).toBeNull();
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
      CAIL_IDENTITY_JWKS: identityJwks,
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
