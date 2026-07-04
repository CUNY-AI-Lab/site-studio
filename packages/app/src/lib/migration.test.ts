import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import type { Env, ProjectMetadata } from "../types";
import {
  migrateAnonymousData,
  migrationClaimKey,
  migrationPendingKey,
  migrationPointerKey,
  loadMigrationPointer,
  type ChatHistoryPorter,
  type MigrationClaim,
  type MigrationPointer
} from "./migration";
import { createPublishRouter } from "../routes/publish";

// Mock R2 bucket (same shape as storage/r2.test.ts).
function createMockBucket() {
  const store = new Map<string, { data: ArrayBuffer | string; httpMetadata?: any }>();

  return {
    store,
    head: vi.fn(async (key: string) => {
      return store.has(key) ? { key, size: 0 } : null;
    }),
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      const data = entry.data;
      return {
        key,
        size: typeof data === "string" ? data.length : (data as ArrayBuffer).byteLength,
        httpMetadata: entry.httpMetadata || {},
        text: async () => (typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer)),
        arrayBuffer: async () => (typeof data === "string" ? new TextEncoder().encode(data).buffer : data)
      };
    }),
    put: vi.fn(async (key: string, data: any, options?: any) => {
      let stored: ArrayBuffer | string;
      if (typeof data === "string") {
        stored = data;
      } else if (data instanceof ArrayBuffer) {
        stored = data;
      } else if (data instanceof Uint8Array) {
        stored = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      } else {
        stored = String(data);
      }
      store.set(key, { data: stored, httpMetadata: options?.httpMetadata });
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async ({ prefix, delimiter, cursor, limit }: any = {}) => {
      const objects: any[] = [];
      const delimitedPrefixes: string[] = [];

      for (const key of store.keys()) {
        if (prefix && !key.startsWith(prefix)) continue;

        if (delimiter) {
          const rest = key.slice(prefix?.length || 0);
          const delimIndex = rest.indexOf(delimiter);
          if (delimIndex >= 0) {
            const delimitedPrefix = (prefix || "") + rest.slice(0, delimIndex + 1);
            if (!delimitedPrefixes.includes(delimitedPrefix)) {
              delimitedPrefixes.push(delimitedPrefix);
            }
            continue;
          }
        }

        objects.push({
          key,
          size: 0,
          uploaded: new Date(),
          httpMetadata: {}
        });
      }

      return {
        objects: limit ? objects.slice(0, limit) : objects,
        truncated: false,
        delimitedPrefixes
      };
    })
  } as unknown as R2Bucket & { store: Map<string, any> };
}

function createMockKV() {
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

const ANON = "user_anon123";
const SUBJECT = "cail-abc123";

/** Copied objects are stored as ArrayBuffers by the mock; decode for asserts. */
function textOf(entry: { data: ArrayBuffer | string } | undefined): string | undefined {
  if (!entry) return undefined;
  return typeof entry.data === "string" ? entry.data : new TextDecoder().decode(entry.data);
}

function metadataFor(id: string, extra: Partial<ProjectMetadata> = {}): string {
  return JSON.stringify({
    id,
    name: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    published: false,
    ...extra
  } satisfies ProjectMetadata);
}

function seedAnonProject(
  bucket: ReturnType<typeof createMockBucket>,
  projectId: string,
  extra: Partial<ProjectMetadata> = {},
  content = `<h1>${projectId} (anon)</h1>`
) {
  bucket.store.set(`projects/${ANON}/${projectId}/.metadata.json`, { data: metadataFor(projectId, extra) });
  bucket.store.set(`projects/${ANON}/${projectId}/index.html`, { data: content });
}

describe("migrateAnonymousData", () => {
  let bucket: ReturnType<typeof createMockBucket>;
  let kv: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    bucket = createMockBucket();
    kv = createMockKV();
  });

  const run = (overrides: Partial<Parameters<typeof migrateAnonymousData>[0]> = {}) =>
    migrateAnonymousData({
      bucket,
      kv,
      anonUserId: ANON,
      subject: SUBJECT,
      anonSessionId: "anon-session-id",
      ...overrides
    });

  it("migrates projects, snapshots, and uploads into the subject namespace (happy path)", async () => {
    seedAnonProject(bucket, "portfolio");
    bucket.store.set(`projects/${ANON}/portfolio/styles.css`, { data: "body{}" });
    bucket.store.set(`snapshots/${ANON}/portfolio/snap1.zip`, { data: "zipbytes" });
    bucket.store.set(`snapshots/${ANON}/portfolio/snap1.json`, {
      data: JSON.stringify({ id: "snap1", createdAt: "2026-01-02T00:00:00.000Z", projectId: "portfolio", trigger: "manual", fileCount: 2 })
    });
    bucket.store.set(`uploads/${ANON}/paper.pdf`, { data: "pdfbytes" });
    kv.store.set("session:anon-session-id", JSON.stringify({ id: ANON, createdAt: "2026-01-01T00:00:00.000Z" }));

    const ported: string[] = [];
    const porter: ChatHistoryPorter = {
      port: async (fromOwner, fromId, toOwner, toId) => {
        ported.push(`${fromOwner}:${fromId}->${toOwner}:${toId}`);
      }
    };

    const result = await run({ porter });
    expect(result.status).toBe("migrated");
    expect(result.projects).toEqual({ portfolio: "portfolio" });

    // Subject now owns the data.
    const meta = JSON.parse(bucket.store.get(`projects/${SUBJECT}/portfolio/.metadata.json`).data);
    expect(meta.id).toBe("portfolio");
    expect(meta.importedFrom).toBe(ANON);
    expect(meta.importedOriginalId).toBe("portfolio");
    expect(textOf(bucket.store.get(`projects/${SUBJECT}/portfolio/index.html`))).toContain("(anon)");
    expect(bucket.store.get(`projects/${SUBJECT}/portfolio/styles.css`)).toBeTruthy();
    expect(bucket.store.get(`snapshots/${SUBJECT}/portfolio/snap1.zip`)).toBeTruthy();
    const snapRecord = JSON.parse(bucket.store.get(`snapshots/${SUBJECT}/portfolio/snap1.json`).data);
    expect(snapRecord.projectId).toBe("portfolio");
    expect(bucket.store.get(`uploads/${SUBJECT}/paper.pdf`)).toBeTruthy();

    // Chat history ported with mapped ids.
    expect(ported).toEqual([`${ANON}:portfolio->${SUBJECT}:portfolio`]);

    // Originals deleted; the forwarding pointer remains.
    expect(bucket.store.get(`projects/${ANON}/portfolio/index.html`)).toBeUndefined();
    expect(bucket.store.get(`snapshots/${ANON}/portfolio/snap1.zip`)).toBeUndefined();
    expect(bucket.store.get(`uploads/${ANON}/paper.pdf`)).toBeUndefined();
    const pointer = (await loadMigrationPointer(bucket, ANON)) as MigrationPointer;
    expect(pointer.subject).toBe(SUBJECT);
    expect(pointer.projects).toEqual({ portfolio: "portfolio" });

    // Claim recorded complete; anon session and pending marker cleared.
    const claim = JSON.parse(kv.store.get(migrationClaimKey(ANON))!) as MigrationClaim;
    expect(claim).toMatchObject({ subject: SUBJECT, status: "complete" });
    expect(kv.store.has("session:anon-session-id")).toBe(false);
    expect(kv.store.has(migrationPendingKey(SUBJECT))).toBe(false);
  });

  it("is idempotent: a second run is a no-op that changes nothing", async () => {
    seedAnonProject(bucket, "portfolio");
    await run();

    const snapshotBefore = new Map(
      [...bucket.store.entries()].map(([k, v]) => [k, v.data])
    );
    const second = await run();

    expect(second.status).toBe("already-complete");
    expect(bucket.store.size).toBe(snapshotBefore.size);
    for (const [key, data] of snapshotBefore) {
      expect(bucket.store.get(key)?.data).toBe(data);
    }
  });

  it("merges without overwriting: colliding project ids are suffixed, subject data untouched", async () => {
    // Subject already owns "site" with its own content.
    bucket.store.set(`projects/${SUBJECT}/site/.metadata.json`, { data: metadataFor("site") });
    bucket.store.set(`projects/${SUBJECT}/site/index.html`, { data: "<h1>subject original</h1>" });

    // Anonymous namespace has a colliding "site" and a non-colliding "blog".
    seedAnonProject(bucket, "site");
    seedAnonProject(bucket, "blog");

    const result = await run();
    expect(result.status).toBe("migrated");
    expect(result.projects).toEqual({ site: "site-imported", blog: "blog" });

    // Subject's original is byte-identical.
    expect(bucket.store.get(`projects/${SUBJECT}/site/index.html`).data).toBe("<h1>subject original</h1>");
    // Incoming copy lives under the suffixed id with its own content.
    const imported = JSON.parse(bucket.store.get(`projects/${SUBJECT}/site-imported/.metadata.json`).data);
    expect(imported.id).toBe("site-imported");
    expect(imported.importedOriginalId).toBe("site");
    expect(textOf(bucket.store.get(`projects/${SUBJECT}/site-imported/index.html`))).toContain("(anon)");
    // Non-colliding project keeps its id.
    expect(bucket.store.get(`projects/${SUBJECT}/blog/index.html`)).toBeTruthy();
  });

  it("claims once: a second subject is refused and receives nothing", async () => {
    seedAnonProject(bucket, "portfolio");
    await run(); // SUBJECT claims and completes

    const otherSubject = "cail-intruder";
    const result = await run({ subject: otherSubject, anonSessionId: undefined });

    expect(result.status).toBe("refused");
    const claim = JSON.parse(kv.store.get(migrationClaimKey(ANON))!) as MigrationClaim;
    expect(claim.subject).toBe(SUBJECT); // original claim untouched
    const otherKeys = [...bucket.store.keys()].filter((k) => k.includes(otherSubject));
    expect(otherKeys).toEqual([]);
  });

  it("refuses non-anonymous ids (never migrates a subject namespace)", async () => {
    const result = await run({ anonUserId: "cail-other" });
    expect(result.status).toBe("refused");
    expect(kv.store.size).toBe(0);
  });

  it("completes with nothing-to-migrate when the anonymous namespace is empty", async () => {
    kv.store.set("session:anon-session-id", JSON.stringify({ id: ANON, createdAt: "2026-01-01T00:00:00.000Z" }));
    const result = await run();

    expect(result.status).toBe("nothing-to-migrate");
    const claim = JSON.parse(kv.store.get(migrationClaimKey(ANON))!) as MigrationClaim;
    expect(claim.status).toBe("complete");
    expect(kv.store.has("session:anon-session-id")).toBe(false);
    // No pointer needed when nothing moved.
    expect(bucket.store.get(migrationPointerKey(ANON))).toBeUndefined();
  });

  it("porter failures are non-fatal: files still migrate", async () => {
    seedAnonProject(bucket, "portfolio");
    const porter: ChatHistoryPorter = {
      port: async () => {
        throw new Error("DO unavailable");
      }
    };

    const result = await run({ porter });
    expect(result.status).toBe("migrated");
    expect(bucket.store.get(`projects/${SUBJECT}/portfolio/index.html`)).toBeTruthy();
  });
});

describe("published-site continuity through migration", () => {
  let bucket: ReturnType<typeof createMockBucket>;
  let kv: ReturnType<typeof createMockKV>;
  let app: Hono<{ Bindings: Env; Variables: { user: { id: string } } }>;
  let env: Env;

  beforeEach(() => {
    bucket = createMockBucket();
    kv = createMockKV();
    app = new Hono<{ Bindings: Env; Variables: { user: { id: string } } }>();
    app.route("/", createPublishRouter());
    env = {
      LOADER: {} as WorkerLoader,
      SESSION_KV: kv,
      SITE_STUDIO_BUCKET: bucket,
      SITE_BUILDER_AGENT: {} as DurableObjectNamespace<any>
    } as Env;
  });

  it("keeps an old /sites/<anon>/<slug>/ URL serving before and after migration", async () => {
    seedAnonProject(
      bucket,
      "portfolio",
      { published: true, slug: "portfolio", publishedAt: "2026-01-02T00:00:00.000Z" },
      "<h1>my published site</h1>"
    );

    // Before migration: normal resolution.
    const before = await app.request(`/sites/${ANON}/portfolio/`, {}, env);
    expect(before.status).toBe(200);
    expect(await before.text()).toContain("my published site");

    await migrateAnonymousData({ bucket, kv, anonUserId: ANON, subject: SUBJECT });

    // After migration the originals are gone, but the pointer keeps the old
    // URL serving the (live, migrated) site.
    expect(bucket.store.get(`projects/${ANON}/portfolio/index.html`)).toBeUndefined();
    const after = await app.request(`/sites/${ANON}/portfolio/`, {}, env);
    expect(after.status).toBe(200);
    expect(await after.text()).toContain("my published site");

    // The new canonical URL under the subject works too.
    const canonical = await app.request(`/sites/${SUBJECT}/portfolio/`, {}, env);
    expect(canonical.status).toBe(200);
    expect(await canonical.text()).toContain("my published site");
  });

  it("remaps colliding published slugs without shadowing the subject's own site", async () => {
    // Subject already publishes "portfolio".
    bucket.store.set(`projects/${SUBJECT}/portfolio/.metadata.json`, {
      data: metadataFor("portfolio", { published: true, slug: "portfolio", publishedAt: "2026-01-03T00:00:00.000Z" })
    });
    bucket.store.set(`projects/${SUBJECT}/portfolio/index.html`, { data: "<h1>subject site</h1>" });

    // Anonymous user also published "portfolio".
    seedAnonProject(
      bucket,
      "portfolio",
      { published: true, slug: "portfolio", publishedAt: "2026-01-02T00:00:00.000Z" },
      "<h1>anon site</h1>"
    );

    const result = await migrateAnonymousData({ bucket, kv, anonUserId: ANON, subject: SUBJECT });
    expect(result.projects).toEqual({ portfolio: "portfolio-imported" });

    // Old anon URL serves the anon content via the slug remap in the pointer.
    const old = await app.request(`/sites/${ANON}/portfolio/`, {}, env);
    expect(old.status).toBe(200);
    expect(await old.text()).toContain("anon site");

    // The subject's own published site is not shadowed.
    const subjectSite = await app.request(`/sites/${SUBJECT}/portfolio/`, {}, env);
    expect(subjectSite.status).toBe(200);
    expect(await subjectSite.text()).toContain("subject site");

    // The remapped slug is recorded in the pointer.
    const pointer = (await loadMigrationPointer(bucket, ANON))!;
    expect(pointer.slugs).toEqual({ portfolio: "portfolio-2" });
  });
});
