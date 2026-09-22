import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, ProjectMetadata } from "./types";
import { SiteStudioRecoveryAdmin } from "./recovery-admin";
import {
  findImportedProjectMap,
  migrateAnonymousData,
  migrationClaimKey,
  type MigrationClaim,
} from "./lib/migration";
import {
  loadRecoveryManifest,
  claimRecoveryHandle,
  markRecoveryComplete,
  readRecoveryAuthorization,
  validateStagedRecovery,
  verifyRecoveredDestination,
  writeRecoveryAliases,
} from "./lib/legacy-recovery";
import { createMockKV, createTestNamespace, createTestR2Object } from "./lib/test-utils";
import { createPublishRouter } from "./routes/publish";
import { MutationCoordinator, SerializedOperationQueue } from "./agents/mutation-coordinator";
import { MigrationCoordinator } from "./agents/migration-coordinator";

type Entry = { bytes: Uint8Array; etag: string; httpMetadata?: R2HTTPMetadata };
type RecoveryProjectFixture = { id: string; published: boolean; slug?: string };

function testConditional(options?: R2PutOptions): R2Conditional | undefined {
  return options?.onlyIf instanceof Headers ? undefined : options?.onlyIf;
}

function createBucket() {
  let revision = 0;
  const store = new Map<string, Entry>();
  const encode = (value: string | ArrayBuffer | Uint8Array) => {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (value instanceof Uint8Array) return value;
    return new TextEncoder().encode(value);
  };
  const putDirect = (key: string, value: string | Uint8Array) => {
    const bytes = encode(value);
    store.set(key, { bytes, etag: `e${++revision}` });
  };
  const fixture = {
    store,
    putDirect,
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      const body = {
        ...createTestR2Object(key, entry.etag, entry.bytes.byteLength, { httpMetadata: entry.httpMetadata }),
        body: new ReadableStream<Uint8Array>(),
        bodyUsed: false,
        text: async () => new TextDecoder().decode(entry.bytes),
        json: async () => JSON.parse(new TextDecoder().decode(entry.bytes)),
        arrayBuffer: async () => entry.bytes.slice().buffer,
        blob: async () => new Blob([entry.bytes.slice().buffer]),
      };
      // SAFETY: This object implements every R2ObjectBody member consumed by the tests.
      return body as R2ObjectBody;
    }),
    put: vi.fn(async (key: string, value: string | ArrayBuffer | Uint8Array, options?: R2PutOptions) => {
      const conditional = testConditional(options);
      const current = store.get(key);
      if (conditional?.etagDoesNotMatch === "*" && current) return null;
      if (conditional?.etagMatches && current?.etag !== conditional.etagMatches) return null;
      const bytes = encode(value);
      const etag = `e${++revision}`;
      store.set(key, {
        bytes,
        etag,
        httpMetadata: options?.httpMetadata instanceof Headers ? undefined : options?.httpMetadata,
      });
      return createTestR2Object(key, etag, bytes.byteLength);
    }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
    head: vi.fn(async (key: string) => {
      const entry = store.get(key);
      return entry ? createTestR2Object(key, entry.etag, entry.bytes.byteLength) : null;
    }),
    list: vi.fn(async ({ prefix = "", limit }: R2ListOptions = {}) => ({
      objects: [...store.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .slice(0, limit)
        .map(([key, entry]) => createTestR2Object(key, entry.etag, entry.bytes.byteLength)),
      truncated: false,
      delimitedPrefixes: [],
    })),
    createMultipartUpload: vi.fn(async () => { throw new Error("multipart upload is not used"); }),
    resumeMultipartUpload: vi.fn(() => { throw new Error("multipart upload is not used"); }),
  };
  // SAFETY: The fixture supplies every R2 method exercised by this suite.
  const bucket = fixture as R2Bucket & {
    store: Map<string, Entry>;
    putDirect: (key: string, value: string | Uint8Array) => void;
  };
  return bucket;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const RECOVERY_ID = "11111111-1111-4111-8111-111111111111";
const IDEMPOTENCY_KEY = "22222222-2222-4222-8222-222222222222";
const SUBJECT = `cail-${"a".repeat(32)}`;
const OTHER_SUBJECT = `cail-${"b".repeat(32)}`;
const SOURCE = `user_${"c".repeat(32)}`;

async function seedRecovery(bucket: ReturnType<typeof createBucket>) {
  const projects = Array.from({ length: 7 }, (_, index) => {
    const project: RecoveryProjectFixture = {
      id: `project-${index + 1}`,
      published: index === 0,
    };
    if (index === 0) project.slug = "published-lesson";
    return project;
  });
  const objects: Array<{ projectId: string; path: string; size: number; sha256: string }> = [];
  for (const project of projects) {
    const metadataValue: ProjectMetadata = {
      id: project.id,
      name: project.id,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      published: project.published,
    };
    if (project.slug) metadataValue.slug = project.slug;
    const metadata = JSON.stringify(metadataValue);
    const html = `<h1>${project.id}</h1>`;
    for (const [path, content] of [[".metadata.json", metadata], ["index.html", html]] as const) {
      bucket.putDirect(`projects/${SOURCE}/${project.id}/${path}`, content);
      objects.push({ projectId: project.id, path, size: new TextEncoder().encode(content).byteLength, sha256: await sha256(content) });
    }
  }
  const manifest = JSON.stringify({
    version: 1,
    recoveryId: RECOVERY_ID,
    source: { account: "d".repeat(32), bucket: "site-studio", owner: SOURCE, prefix: `projects/${SOURCE}/` },
    projects,
    objects,
  });
  bucket.putDirect(`recoveries/${RECOVERY_ID}/manifest.json`, manifest);
  bucket.putDirect(`imports/${encodeURIComponent(SUBJECT)}`, "");
  return { projects, objects };
}

function createAdmin(bucket: ReturnType<typeof createBucket>) {
  const kv = createMockKV();
  const claim = vi.fn(async () => ({ granted: true, resume: false }));
  const restore = vi.fn(async (recoveryId: string, anonUserId: string, subject: string) => {
    const result = await migrateAnonymousData({ bucket, kv, anonUserId, subject });
    const projectMap = {
      ...await findImportedProjectMap(bucket, subject, anonUserId),
      ...result.projects,
    };
    const { manifest } = await loadRecoveryManifest(bucket, recoveryId);
    const migrationClaim = await kv.get<MigrationClaim>(migrationClaimKey(anonUserId), "json");
    await validateStagedRecovery(bucket, manifest, { allowMissing: Boolean(migrationClaim) });
    await verifyRecoveredDestination({ bucket, manifest, targetSubject: subject, projectMap });
    const recovery = await readRecoveryAuthorization(bucket, recoveryId);
    if (!recovery) throw new Error("missing recovery");
    const recoveryHandle = await claimRecoveryHandle(bucket, anonUserId, subject, recovery.value.startedAt);
    await writeRecoveryAliases({ bucket, manifest, targetSubject: subject, projectMap, recoveryHandle });
    await markRecoveryComplete(bucket, recovery, projectMap, recoveryHandle);
    return { ...result, projects: projectMap };
  });
  // SAFETY: Tests use only the stable name/toString identity fields of this inert object id.
  const idFromName = (name: string) => ({ name, toString: () => name }) as DurableObjectId;
  const env: Env = {
    // SAFETY: Recovery unit tests never load a Dynamic Worker.
    LOADER: {} as WorkerLoader,
    // SAFETY: Recovery unit tests never call a SiteBuilderAgent.
    SITE_BUILDER_AGENT: {} as Env["SITE_BUILDER_AGENT"],
    SITE_STUDIO_BUCKET: bucket,
    SESSION_KV: kv,
    PUBLISHED_BASE_URL: "https://tools.example/site-studio",
    MIGRATION_COORDINATOR: createTestNamespace<MigrationCoordinator>({ idFromName, get: () => ({ claim }) }),
    MUTATION_COORDINATOR: createTestNamespace<MutationCoordinator>({ idFromName, get: () => ({ restoreLegacyProjects: restore }) }),
  };
  // SAFETY: The WorkerEntrypoint shim has no constructor; assigning env creates the test instance.
  const admin = Object.assign(Object.create(SiteStudioRecoveryAdmin.prototype), { env }) as SiteStudioRecoveryAdmin;
  return { admin, claim, restore, env };
}

function createActualCoordinatorAdmin(bucket: ReturnType<typeof createBucket>) {
  const kv = createMockKV();
  const claim = vi.fn(async () => ({ granted: true, resume: false }));
  // SAFETY: Tests use only the stable name/toString identity fields of this inert object id.
  const ids = (name: string) => ({ name, toString: () => name }) as DurableObjectId;
  const coordinators = new Map<string, MutationCoordinator>();
  let env: Env;
  const namespace = {
    idFromName: ids,
    get(id: DurableObjectId) {
      const name = id.toString();
      let coordinator = coordinators.get(name);
      if (!coordinator) {
        const values = new Map<string, unknown>();
        const storage = {
          // SAFETY: Each journal key is read with the same type used for its write.
          get: async <T>(key: string) => values.get(key) as T | undefined,
          put: async <T>(key: string, value: T) => { values.set(key, value); },
          delete: async (key: string) => values.delete(key),
        };
        // SAFETY: The DO shim has no constructor; these are the fields used by the real methods.
        coordinator = Object.assign(Object.create(MutationCoordinator.prototype), {
          env,
          ctx: { storage },
          mutations: new SerializedOperationQueue(),
        }) as MutationCoordinator;
        coordinators.set(name, coordinator);
      }
      return coordinator;
    },
  };
  env = {
    // SAFETY: Recovery unit tests never load a Dynamic Worker.
    LOADER: {} as WorkerLoader,
    // SAFETY: Recovery unit tests never call a SiteBuilderAgent.
    SITE_BUILDER_AGENT: {} as Env["SITE_BUILDER_AGENT"],
    SITE_STUDIO_BUCKET: bucket,
    SESSION_KV: kv,
    PUBLISHED_BASE_URL: "https://tools.example/site-studio",
    MIGRATION_COORDINATOR: createTestNamespace<MigrationCoordinator>({ idFromName: ids, get: () => ({ claim }) }),
    MUTATION_COORDINATOR: createTestNamespace<MutationCoordinator>(namespace),
  };
  // SAFETY: The WorkerEntrypoint shim has no constructor; assigning env creates the test instance.
  const admin = Object.assign(Object.create(SiteStudioRecoveryAdmin.prototype), { env }) as SiteStudioRecoveryAdmin;
  return { admin, env };
}

describe("SiteStudioRecoveryAdmin", () => {
  let bucket: ReturnType<typeof createBucket>;

  beforeEach(() => { bucket = createBucket(); });

  it("lists only bounded canonical import candidates", async () => {
    bucket.putDirect(`imports/${encodeURIComponent(SUBJECT)}`, "");
    const { admin } = createAdmin(bucket);
    await expect(admin.listLegacyRecoveryCandidates({})).resolves.toEqual({
      ok: true,
      subjects: [SUBJECT],
      nextCursor: null,
    });
  });

  it("fails closed on an incomplete or hash-mismatched source before claiming", async () => {
    const { objects } = await seedRecovery(bucket);
    bucket.store.delete(`projects/${SOURCE}/${objects[0].projectId}/${objects[0].path}`);
    const { admin, claim, restore } = createAdmin(bucket);
    await expect(admin.restoreLegacyProjects({ recoveryId: RECOVERY_ID, targetSubject: SUBJECT, idempotencyKey: IDEMPOTENCY_KEY }))
      .resolves.toEqual({ ok: false, code: "invalid" });
    expect(claim).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it("restores six private and one published project, preserves collisions, and replays after source deletion", async () => {
    await seedRecovery(bucket);
    const unrelated = JSON.stringify({ id: "project-1", name: "existing", createdAt: "x", updatedAt: "x", published: false });
    bucket.putDirect(`projects/${SUBJECT}/project-1/.metadata.json`, unrelated);
    bucket.putDirect(`projects/${SUBJECT}/project-1/index.html`, "<h1>unrelated</h1>");
    const markerBefore = bucket.store.get(`imports/${encodeURIComponent(SUBJECT)}`)?.bytes;
    const { admin, restore, env } = createAdmin(bucket);
    const first = await admin.restoreLegacyProjects({ recoveryId: RECOVERY_ID, targetSubject: SUBJECT, idempotencyKey: IDEMPOTENCY_KEY });
    expect(first).toMatchObject({ ok: true, state: "restored", projectCount: 7, fileCount: 14 });
    expect(bucket.store.has(`projects/${SUBJECT}/project-1-imported/index.html`)).toBe(true);
    expect(new TextDecoder().decode(bucket.store.get(`projects/${SUBJECT}/project-1/index.html`)?.bytes)).toBe("<h1>unrelated</h1>");
    expect([...bucket.store.keys()].some((key) => key.startsWith(`projects/${SOURCE}/`))).toBe(false);
    expect(bucket.store.get(`imports/${encodeURIComponent(SUBJECT)}`)?.bytes).toEqual(markerBefore);
    expect(bucket.store.has(`recovery-aliases/${SOURCE}/published-lesson.json`)).toBe(true);
    expect([...bucket.store.keys()].filter((key) => key.startsWith(`recovery-aliases/${SOURCE}/`))).toHaveLength(1);
    expect(bucket.store.has(`userhandles/${SUBJECT}.json`)).toBe(false);

    const replay = await admin.restoreLegacyProjects({ recoveryId: RECOVERY_ID, targetSubject: SUBJECT, idempotencyKey: IDEMPOTENCY_KEY });
    expect(replay).toMatchObject({ ok: true, state: "already_restored" });
    expect(restore).toHaveBeenCalledTimes(1);
    await expect(admin.restoreLegacyProjects({ recoveryId: RECOVERY_ID, targetSubject: OTHER_SUBJECT, idempotencyKey: IDEMPOTENCY_KEY }))
      .resolves.toEqual({ ok: false, code: "conflict" });

    const app = new Hono<{ Bindings: Env }>();
    app.route("/", createPublishRouter());
    const served = await app.request(`http://local/sites/${SOURCE}/published-lesson/`, {}, env);
    expect(served.status).toBe(302);
    expect(served.headers.get("location")).toBe(`/site-studio/u/legacy-${"c".repeat(25)}/published-lesson/`);
    expect(served.headers.get("cache-control")).toBe("no-store");
    bucket.putDirect("handles/restored-owner.json", JSON.stringify({ ownerId: SUBJECT, claimedAt: "2026-01-01T00:00:00.000Z" }));
    bucket.putDirect(`userhandles/${SUBJECT}.json`, JSON.stringify({ handle: "restored-owner", claimedAt: "2026-01-01T00:00:00.000Z" }));
    const redirected = await app.request(
      `http://local/sites/${SOURCE}/published-lesson/notes.html?view=full`,
      {},
      env,
    );
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get("location")).toBe("/site-studio/u/restored-owner/published-lesson/notes.html?view=full");
    expect(redirected.headers.get("cache-control")).toBe("no-store");
    const importedMetadataKey = `projects/${SUBJECT}/project-1-imported/.metadata.json`;
    // SAFETY: Migration wrote this object from the validated ProjectMetadata fixture.
    const imported = JSON.parse(new TextDecoder().decode(bucket.store.get(importedMetadataKey)?.bytes)) as ProjectMetadata;
    const renamedMetadataKey = `projects/${SUBJECT}/renamed-project/.metadata.json`;
    bucket.putDirect(renamedMetadataKey, JSON.stringify({ ...imported, id: "renamed-project" }));
    bucket.putDirect(`projects/${SUBJECT}/renamed-project/index.html`, "<h1>project-1</h1>");
    bucket.store.delete(importedMetadataKey);
    bucket.store.delete(`projects/${SUBJECT}/project-1-imported/index.html`);
    expect((await app.request(`http://local/sites/${SOURCE}/published-lesson/`, {}, env)).status).toBe(302);
    bucket.putDirect(renamedMetadataKey, JSON.stringify({ ...imported, id: "renamed-project", published: false }));
    expect((await app.request(`http://local/sites/${SOURCE}/published-lesson/`, {}, env)).status).toBe(404);
  });

  it("finishes the durable receipt when a retry starts after staged source deletion", async () => {
    await seedRecovery(bucket);
    const { admin } = createActualCoordinatorAdmin(bucket);
    const putMock = vi.mocked(bucket.put);
    const originalPut = putMock.getMockImplementation();
    if (!originalPut) throw new Error("missing put fixture");
    let failReceipt = true;
    putMock.mockImplementation(async (key, value, options) => {
      const conditional = testConditional(options);
      if (failReceipt && key.endsWith("/authorization.json") && conditional?.etagMatches) {
        failReceipt = false;
        throw new Error("injected failure before receipt");
      }
      return originalPut(key, value, options);
    });
    const input = { recoveryId: RECOVERY_ID, targetSubject: SUBJECT, idempotencyKey: IDEMPOTENCY_KEY };
    await expect(admin.restoreLegacyProjects(input)).resolves.toEqual({ ok: false, code: "unavailable" });
    expect([...bucket.store.keys()].some((key) => key.startsWith(`projects/${SOURCE}/`))).toBe(false);
    await expect(admin.restoreLegacyProjects(input)).resolves.toMatchObject({ ok: true, state: "restored" });
    const receipt = await readRecoveryAuthorization(bucket, RECOVERY_ID);
    expect(receipt?.value.status).toBe("complete");
    expect(Object.keys(receipt?.value.projectMap ?? {})).toHaveLength(7);
  });

  it("resumes after a staged delete fails mid-inventory without duplicating projects", async () => {
    await seedRecovery(bucket);
    const deleteMock = vi.mocked(bucket.delete);
    const originalDelete = deleteMock.getMockImplementation();
    if (!originalDelete) throw new Error("missing delete fixture");
    let projectDeletes = 0;
    deleteMock.mockImplementation(async (key: string | string[]) => {
      if (Array.isArray(key)) return originalDelete(key);
      if (key.startsWith(`projects/${SOURCE}/`) && ++projectDeletes === 2) {
        throw new Error("injected delete failure");
      }
      return originalDelete(key);
    });
    const { admin } = createActualCoordinatorAdmin(bucket);
    const input = { recoveryId: RECOVERY_ID, targetSubject: SUBJECT, idempotencyKey: IDEMPOTENCY_KEY };
    await expect(admin.restoreLegacyProjects(input)).resolves.toEqual({ ok: false, code: "unavailable" });
    deleteMock.mockImplementation(originalDelete);
    await expect(admin.restoreLegacyProjects(input)).resolves.toMatchObject({ ok: true, state: "restored" });
    const importedMetadata = [...bucket.store.keys()].filter(
      (key) => key.startsWith(`projects/${SUBJECT}/`) && key.endsWith("/.metadata.json"),
    );
    expect(importedMetadata).toHaveLength(7);
  });
});
