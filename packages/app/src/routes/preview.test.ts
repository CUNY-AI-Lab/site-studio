import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../types";
import { R2ProjectStorage } from "../storage/r2";
import { createPreviewRouter } from "./preview";
import { createPublishRouter } from "./publish";

/**
 * Dedicated coverage for the editor preview route's file resolution. preview.ts
 * previously had NO dedicated tests, so this suite first CHARACTERIZES its
 * current extensionless-resolution behavior — the point of divergence from the
 * publisher/publish paths — so the sanctioned alignment change (preview → try
 * `{path}.html` before `{path}/index.html`, matching publish) is explicit in
 * the diff that follows.
 */

function createMockBucket() {
  const store = new Map<string, { data: ArrayBuffer | string; httpMetadata?: unknown }>();
  return {
    store,
    head: vi.fn(async (key: string) => (store.has(key) ? { key, size: 0 } : null)),
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      const data = entry.data;
      return {
        key,
        size: typeof data === "string" ? data.length : data.byteLength,
        httpMetadata: entry.httpMetadata || {},
        text: async () => (typeof data === "string" ? data : new TextDecoder().decode(data)),
        arrayBuffer: async () =>
          typeof data === "string" ? new TextEncoder().encode(data).buffer : data
      };
    }),
    put: vi.fn(async (key: string, data: string, options?: { httpMetadata?: unknown }) => {
      store.set(key, { data, httpMetadata: options?.httpMetadata });
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async ({ prefix }: { prefix?: string } = {}) => {
      const objects: Array<{ key: string; size: number }> = [];
      for (const key of store.keys()) {
        if (prefix && !key.startsWith(prefix)) continue;
        objects.push({ key, size: 0 });
      }
      return { objects, truncated: false, delimitedPrefixes: [] };
    })
  } as unknown as R2Bucket & { store: Map<string, { data: ArrayBuffer | string }> };
}

function createEnv(bucket: R2Bucket): Env {
  return {
    SESSION_KV: {} as KVNamespace,
    SITE_STUDIO_BUCKET: bucket,
    SITE_BUILDER_AGENT: {} as DurableObjectNamespace<any>,
    MIGRATION_COORDINATOR: {} as DurableObjectNamespace<any>,
    LOADER: {} as WorkerLoader,
    ASSETS: undefined
  };
}

function createTestApp() {
  const app = new Hono<{ Bindings: Env; Variables: { user: { id: string } } }>();
  app.use("*", async (c, next) => {
    c.set("user", { id: "user_test123" });
    await next();
  });
  app.route("/", createPreviewRouter());
  app.route("/", createPublishRouter());
  return app;
}

/** Give an owner a claimed public handle (both mapping records). */
function seedHandle(bucket: ReturnType<typeof createMockBucket>, ownerId: string, handle: string) {
  const claimedAt = "2026-01-01T00:00:00.000Z";
  bucket.store.set(`handles/${handle}.json`, { data: JSON.stringify({ ownerId, claimedAt }) });
  bucket.store.set(`userhandles/${ownerId}.json`, { data: JSON.stringify({ handle, claimedAt }) });
}

describe("preview file resolution", () => {
  const userId = "user_test123";
  let bucket: ReturnType<typeof createMockBucket>;
  let storage: R2ProjectStorage;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    bucket = createMockBucket();
    storage = new R2ProjectStorage(bucket);
    app = createTestApp();
    await storage.createProject(userId, "proj", "Proj");
    await storage.writeFile(userId, "proj", "index.html", "<h1>Home</h1>");
  });

  async function get(path: string, accept = "*/*") {
    return app.request(
      `http://site-studio.test/preview/proj/${path}`,
      { headers: { Accept: accept } },
      createEnv(bucket)
    );
  }

  it("serves index.html at the project root", async () => {
    const res = await get("");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Home");
  });

  it("serves a directory's index.html for a trailing-slash path", async () => {
    await storage.writeFile(userId, "proj", "docs/index.html", "<h1>Docs</h1>");
    const res = await get("docs/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Docs");
  });

  it("resolves an extensionless path to {path}/index.html", async () => {
    await storage.writeFile(userId, "proj", "docs/index.html", "<h1>Docs</h1>");
    const res = await get("docs");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Docs");
  });

  it("serves an exact file when it exists", async () => {
    await storage.writeFile(userId, "proj", "about.html", "<h1>Flat About</h1>");
    const res = await get("about.html");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Flat About");
  });

  // Post-alignment behavior (the sanctioned S3 change): preview now matches
  // publish/publisher — it tries the flat `{path}.html` FIRST, then
  // `{path}/index.html`. These are the flipped counterparts of the
  // pre-alignment characterization committed just before the change.
  describe("[aligned to publish: extensionless resolution]", () => {
    it("resolves extensionless /about to a flat about.html", async () => {
      await storage.writeFile(userId, "proj", "about.html", "<h1>Flat About</h1>");
      const res = await get("about", "text/html");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Flat About");
    });

    it("prefers a flat {path}.html over {path}/index.html when both exist", async () => {
      await storage.writeFile(userId, "proj", "blog.html", "<h1>Flat Blog</h1>");
      await storage.writeFile(userId, "proj", "blog/index.html", "<h1>Nested Blog</h1>");
      const res = await get("blog", "text/html");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Flat Blog");
    });

    it("still falls back to {path}/index.html when no flat {path}.html exists", async () => {
      await storage.writeFile(userId, "proj", "docs/index.html", "<h1>Docs</h1>");
      const res = await get("docs", "text/html");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Docs");
    });
  });
});

/**
 * Preview-vs-publish extensionless PARITY. Post-alignment the two routes share
 * one resolver (@site-studio/serving-core/extensionless), so they must resolve
 * the same extensionless request to the same body. This test is the anti-drift
 * guard that STAYS after the dedup: it drives the SAME seeded project through
 * both /preview/ and the published /u/{handle}/{slug}/ path and asserts the
 * served bytes match, across all three resolution cases (flat sibling wins,
 * flat-preferred-over-nested, nested fallback).
 */
describe("preview ↔ publish extensionless parity", () => {
  const userId = "user_test123";
  const handle = "janedoe";
  const slug = "site";
  let bucket: ReturnType<typeof createMockBucket>;
  let storage: R2ProjectStorage;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    bucket = createMockBucket();
    storage = new R2ProjectStorage(bucket);
    app = createTestApp();
    seedHandle(bucket, userId, handle);
    await storage.createProject(userId, slug, "Site");
    await storage.writeFile(userId, slug, "index.html", "<h1>Home</h1>");
    // Flat sibling only.
    await storage.writeFile(userId, slug, "about.html", "<h1>Flat About</h1>");
    // Both flat + nested (flat must win on both routes).
    await storage.writeFile(userId, slug, "blog.html", "<h1>Flat Blog</h1>");
    await storage.writeFile(userId, slug, "blog/index.html", "<h1>Nested Blog</h1>");
    // Nested only (fallback).
    await storage.writeFile(userId, slug, "docs/index.html", "<h1>Docs</h1>");
    await storage.updateProjectMetadata(userId, slug, { published: true, slug });
  });

  async function previewBody(subPath: string) {
    const res = await app.request(
      `http://site-studio.test/preview/${slug}/${subPath}`,
      { headers: { Accept: "text/html" } },
      createEnv(bucket)
    );
    return { status: res.status, body: await res.text() };
  }

  async function publishBody(subPath: string) {
    const res = await app.request(
      `http://site-studio.test/u/${handle}/${slug}/${subPath}`,
      { headers: { Accept: "text/html" } },
      createEnv(bucket)
    );
    return { status: res.status, body: await res.text() };
  }

  for (const subPath of ["about", "blog", "docs"]) {
    it(`resolves "${subPath}" identically on preview and publish`, async () => {
      const preview = await previewBody(subPath);
      const publish = await publishBody(subPath);
      expect(preview.status).toBe(200);
      expect(publish.status).toBe(200);
      // Both routes cache-bust HTML; compare the marker heading, which is stable.
      const marker = (html: string) => html.match(/<h1>[^<]*<\/h1>/)?.[0];
      expect(marker(preview.body)).toBe(marker(publish.body));
    });
  }
});
