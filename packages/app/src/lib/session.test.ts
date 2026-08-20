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
import type { MigrationResult } from "./migration";
import { createMockKV, createTestNamespace, createTestR2Object, DURABLE_OBJECT_BRAND } from "./test-utils";
import type { MigrationCoordinator } from "../agents/migration-coordinator";
import type { MutationCoordinator } from "../agents/mutation-coordinator";

let identityIssuer: TestIdentityIssuer;
let identityJwks: string;
const PUBLISHED_BASE_URL = "https://tools.ailab.gc.cuny.edu/site-studio";

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
type SessionBody = { user: { id: string; cail?: boolean; email?: string }; error?: string };
type DiagnosticEvent = { [key: string]: string | number | boolean | null | undefined };
type MockCoordinator = {
  /** The DO namespace, ready to drop into Env["MIGRATION_COORDINATOR"]. */
  namespace: Env["MIGRATION_COORDINATOR"];
  /** The shared per-anonId claim map, for direct assertions/seeding in tests. */
  records: Map<string, CoordinatorRecord>;
};

function testDurableObjectId(name: string): DurableObjectId {
  // SAFETY: The in-memory fixture exposes the stable name/equality behavior
  // consumed by these tests; Cloudflare supplies the opaque implementation.
  return {
    name,
    toString: () => name,
    equals: (other: DurableObjectId) => other.toString() === name,
  } as DurableObjectId;
}

type MigrationRpc = (anonUserId: string, subject: string, anonSessionId?: string) => Promise<MigrationResult>;

function createMutationCoordinatorNamespace(migrateAnonymous: MigrationRpc): Env["MUTATION_COORDINATOR"] {
  const rpc = {
    id: testDurableObjectId("rpc"),
    fetch: async (_request: Request) => new Response(null, { status: 404 }),
    execute: async () => { throw new Error("execute is not part of this session fixture"); },
    migrateAnonymous,
    // SAFETY: Cloudflare's RPC brand is nominal type metadata; this fixture
    // implements the methods exposed over the migration RPC boundary.
    [DURABLE_OBJECT_BRAND]: undefined as never,
  };
  const namespace = {
    newUniqueId: () => testDurableObjectId("new"),
    idFromName: testDurableObjectId,
    idFromString: testDurableObjectId,
    get: () => rpc,
    getByName: () => rpc,
    jurisdiction: () => namespace,
  };
  // SAFETY: Session tests exercise only migrateAnonymous; the other namespace
  // methods are inert binding-contract stubs.
  return createTestNamespace<MutationCoordinator>(namespace);
}

function createStubBucket(): R2Bucket {
  const fixture = {
    head: vi.fn(async () => null),
    get: vi.fn(async () => null),
    put: vi.fn(async (key: string) => createTestR2Object(key)),
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ objects: [], truncated: false, delimitedPrefixes: [] })),
    createMultipartUpload: vi.fn(async () => { throw new Error("multipart upload is not part of this fixture"); }),
    resumeMultipartUpload: vi.fn(() => { throw new Error("multipart upload is not part of this fixture"); }),
  };
  // SAFETY: Auth tests touch only get/put; the remaining methods are inert
  // implementations required by the R2 binding contract.
  return fixture as R2Bucket;
}

function createCoordinatorNamespace(): MockCoordinator {
  const records = new Map<string, CoordinatorRecord>();
  // SAFETY: The namespace fixture models the claim/markComplete RPCs used by
  // authMiddleware; Cloudflare adds only transport metadata around them.
  const namespace = {
    newUniqueId: () => testDurableObjectId("new"),
    idFromName: testDurableObjectId,
    idFromString: testDurableObjectId,
    get: (id: DurableObjectId) => ({
      id: testDurableObjectId(id.toString()),
      fetch: async (_request: Request) => new Response(null, { status: 404 }),
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
      },
      // SAFETY: Cloudflare's RPC brand is nominal type metadata; this fixture
      // implements the claim/markComplete methods used by authMiddleware.
      [DURABLE_OBJECT_BRAND]: undefined as never,
    }),
    getByName: (name: string) => namespace.get(testDurableObjectId(name)),
    jurisdiction: () => namespace,
  };
  // SAFETY: The fixture implements the migration claim RPC; Cloudflare adds
  // namespace transport and placement metadata around the stub.
  const typedNamespace = createTestNamespace<MigrationCoordinator>(namespace);
  return { namespace: typedNamespace, records };
}

function createEnv(overrides?: Partial<Env>): Env {
  const env: Env = {
    CAIL_LOG_ENV: "test",
    APP_PUBLIC_DOMAIN: "https://tools.ailab.gc.cuny.edu",
    PUBLISHED_BASE_URL,
    // SAFETY: Session tests never load a Worker module through this binding.
    LOADER: {} as WorkerLoader,
    CAIL_API_BASE: "https://cail.example/proxy",
    CAIL_IDENTITY_ISSUER: CAIL_CANONICAL_ISSUER,
    CAIL_MODEL: "test-model",
    // SAFETY: Auth tests exercise only KV get/put for this binding.
    SESSION_KV: createMockKV(),
    // SAFETY: Auth tests exercise only R2 get/put for this binding.
    SITE_STUDIO_BUCKET: createStubBucket(),
    // SAFETY: Auth tests never connect to the SiteBuilderAgent namespace.
    SITE_BUILDER_AGENT: {} as DurableObjectNamespace<any>,
    MIGRATION_COORDINATOR: createCoordinatorNamespace().namespace,
    ASSETS: undefined,
    ...overrides
  };
  // SAFETY: The migration coordinator fixture exposes the RPC used by auth;
  // Cloudflare adds only transport metadata around this test stub.
  const mutationNamespace = {
    newUniqueId: () => testDurableObjectId("new"),
    idFromName: testDurableObjectId,
    idFromString: testDurableObjectId,
    get: () => ({
      id: testDurableObjectId("rpc"),
      fetch: async (_request: Request) => new Response(null, { status: 404 }),
      migrateAnonymous: (anonUserId: string, subject: string, anonSessionId?: string) =>
        migrateAnonymousData({
          bucket: env.SITE_STUDIO_BUCKET,
          kv: env.SESSION_KV,
          anonUserId,
          subject,
          publishedBaseUrl: env.PUBLISHED_BASE_URL!,
          anonSessionId
        }),
      // SAFETY: Cloudflare's RPC brand is nominal type metadata; this fixture
      // implements the migration method used by authMiddleware.
      [DURABLE_OBJECT_BRAND]: undefined as never,
    }),
    getByName: () => ({
      id: testDurableObjectId("rpc"),
      fetch: async (_request: Request) => new Response(null, { status: 404 }),
      execute: async () => { throw new Error("execute is not part of this session fixture"); },
      migrateAnonymous: async (anonUserId: string, subject: string, anonSessionId?: string) =>
        migrateAnonymousData({
          bucket: env.SITE_STUDIO_BUCKET,
          kv: env.SESSION_KV,
          anonUserId,
          subject,
          publishedBaseUrl: env.PUBLISHED_BASE_URL!,
          anonSessionId,
        }),
      [DURABLE_OBJECT_BRAND]: undefined as never,
    }),
    jurisdiction: () => mutationNamespace,
  };
  env.MUTATION_COORDINATOR ??= createTestNamespace<MutationCoordinator>(mutationNamespace);
  return env;
}

describe("authMiddleware", () => {
  it("keys the user by the CAIL subject when a verified identity JWT is present", async () => {
    const app = new Hono<{ Bindings: Env; Variables: { user: { id: string; createdAt: string } } }>();
    app.use("*", authMiddleware);
    app.get("/api/test", (c) => c.json({ user: c.get("user") }));

    const kvPut = vi.fn(async () => undefined);
    const requestKv = createMockKV();
    // SAFETY: createMockKV exposes get as a Vitest spy for this request.
    const requestKvGet = requestKv.get as ReturnType<typeof vi.fn>;
    requestKvGet.mockResolvedValue(null);
    // SAFETY: createMockKV exposes put as a Vitest spy for this request.
    const requestKvPut = requestKv.put as ReturnType<typeof vi.fn>;
    requestKvPut.mockImplementation(kvPut);
    const env = createEnv({
      CAIL_IDENTITY_JWKS: identityJwks,
      SESSION_KV: requestKv
    });

    const subject = TEST_SUBJECTS.alice;
    const token = await mintIdentityJwt(subject);
    const response = await app.request(
      "http://site-studio.test/api/test",
      { headers: { "X-CAIL-Identity-JWT": token } },
      env
    );

    expect(response.status).toBe(200);
    // SAFETY: The test endpoint returns the documented authenticated user body.
    const body = (await response.json()) as SessionBody;
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
    const requestBucket = createStubBucket();
    // SAFETY: createStubBucket exposes get as a Vitest spy for this request.
    const bucketGet = requestBucket.get as ReturnType<typeof vi.fn>;
    bucketGet.mockResolvedValue(null);
    const requestKv = createMockKV();
    // SAFETY: createMockKV exposes get as a Vitest spy for this request.
    const kvGet = requestKv.get as ReturnType<typeof vi.fn>;
    kvGet.mockResolvedValue(null);
    const env = createEnv({
      CAIL_IDENTITY_JWKS: identityJwks,
      SITE_STUDIO_BUCKET: requestBucket,
      SESSION_KV: requestKv
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
    // SAFETY: The authentication error response has a string error field.
    const body = (await response.json()) as { error: string };
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
  // SAFETY: The live KV fixture handles the single-key text/json overloads used
  // by migration tests; unsupported KV overloads are outside this boundary.
  const get = (async (key: string, type?: string) => {
    const value = store.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
  }) as KVNamespace["get"];
  // SAFETY: Migration writes strings in this fixture; the binding accepts a
  // wider value union outside this test boundary.
  const put = (async (key: string, value: string) => {
    store.set(key, String(value));
  }) as KVNamespace["put"];
  // SAFETY: Migration deletes one key at a time in this fixture.
  const remove = (async (key: string) => {
    store.delete(key);
  }) as KVNamespace["delete"];
  const getWithMetadata = async <Metadata = never>(
    _key: string,
  ): Promise<KVNamespaceGetWithMetadataResult<string, Metadata>> => ({ value: null, metadata: null, cacheStatus: null });
  // SAFETY: Migration tests do not enumerate KV keys in this fixture.
  const list = (async () => ({ keys: [], list_complete: true, cacheStatus: null })) as KVNamespace["list"];
  // SAFETY: The migration fixture implements the KV methods used by the
  // import path and retains its backing map for assertions.
  const fixture = {
    store,
    get,
    put,
    delete: remove,
    getWithMetadata,
    list
  } as KVNamespace & { store: Map<string, string> };
  vi.spyOn(fixture, "get");
  vi.spyOn(fixture, "put");
  return fixture;
}

function createLiveBucket() {
  type LiveData = string | ArrayBuffer | Uint8Array;
  const store = new Map<string, string>();
  // SAFETY: The migration fixture implements the R2 methods used by import and
  // keeps all stored values as decoded text for deterministic assertions.
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
    put: vi.fn(async (key: string, value: LiveData) => {
      const text = value instanceof ArrayBuffer
        ? new TextDecoder().decode(value)
        : value instanceof Uint8Array
          ? new TextDecoder().decode(value)
          : value;
      store.set(key, text);
      return createTestR2Object(key, `${key}:etag`, text.length);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async ({ prefix, limit }: R2ListOptions = {}) => {
      const objects: R2Object[] = [...store.keys()]
        .filter((key) => !prefix || key.startsWith(prefix))
        .map((key) => createTestR2Object(key));
      return {
        objects: limit ? objects.slice(0, limit) : objects,
        truncated: false,
        delimitedPrefixes: []
      };
    }),
    createMultipartUpload: vi.fn(async () => { throw new Error("multipart upload is not part of this fixture"); }),
    resumeMultipartUpload: vi.fn(() => { throw new Error("multipart upload is not part of this fixture"); })
  } as R2Bucket & { store: Map<string, string> };
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
    // SAFETY: The migration endpoint returns the documented user envelope.
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
      // SAFETY: The fixture exposes only the migration RPC used by authMiddleware.
      MUTATION_COORDINATOR: createMutationCoordinatorNamespace(migrateAnonymous),
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
    // SAFETY: The fixture exposes only the migration RPC used by authMiddleware.
    env.MUTATION_COORDINATOR = createMutationCoordinatorNamespace(async (anonUserId: string, subject: string, anonSessionId?: string) => {
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
        });
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
    // SAFETY: This replacement preserves the R2 delete signature while
    // injecting one retirement failure for retry coverage.
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
      // SAFETY: The logging boundary emits concrete scalar diagnostic fields.
      const events = info.mock.calls.map(([event]) => event as DiagnosticEvent);
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

    // SAFETY: createLiveBucket exposes get as a Vitest mock for this outage test.
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
    // SAFETY: The migration failure response has a string error field.
    const body = (await response.json()) as { error: string };
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
      // SAFETY: This fixture deliberately fails the coordinator claim RPC.
      MIGRATION_COORDINATOR: createTestNamespace<MigrationCoordinator>({
        newUniqueId: () => testDurableObjectId("new"),
        idFromName: testDurableObjectId,
        idFromString: testDurableObjectId,
        get: (id: DurableObjectId) => ({
          id,
          fetch: async (_request: Request) => new Response(null, { status: 404 }),
          claim: async () => {
            throw new Error("DO unreachable");
          },
          markComplete: async () => undefined,
          // SAFETY: Cloudflare's RPC brand is nominal type metadata; this
          // fixture deliberately fails the claim RPC above.
          [DURABLE_OBJECT_BRAND]: undefined as never,
        }),
        getByName: (name: string) => ({
          id: testDurableObjectId(name),
          fetch: async (_request: Request) => new Response(null, { status: 404 }),
          claim: async () => { throw new Error("DO unreachable"); },
          markComplete: async () => undefined,
          [DURABLE_OBJECT_BRAND]: undefined as never,
        }),
        jurisdiction: () => undefined,
      })
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
    // SAFETY: createLiveKV exposes put as a Vitest mock for this outage test.
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
