import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../types";
import { R2ProjectStorage } from "../storage/r2";
import { createPreviewRouter } from "./preview";
import { createPublishRouter } from "./publish";
import { authMiddleware } from "../lib/session";
import { mintPreviewToken, previewTokenAuth } from "../lib/preview-token";
import { createMockKV, type MockKV } from "../lib/test-utils";

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
      return { key, etag: `${key}:1` };
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

function createEnv(bucket: R2Bucket, kv: KVNamespace = createMockKV(), overrides: Partial<Env> = {}): Env {
  const now = Date.now();
  return {
    CAIL_LOG_ENV: "test",
    SESSION_KV: kv,
    SITE_STUDIO_BUCKET: bucket,
    SITE_BUILDER_AGENT: {} as DurableObjectNamespace<any>,
    MIGRATION_COORDINATOR: {} as DurableObjectNamespace<any>,
    LOADER: {} as WorkerLoader,
    CAIL_SSO_SWITCHED_AT: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    CAIL_ACCOUNT_IMPORT_UNTIL: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
    ASSETS: undefined,
    ...overrides
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

function createAuthenticatedPreviewApp() {
  const app = new Hono<{
    Bindings: Env;
    Variables: { sessionId: string; user: { id: string; createdAt: string } };
  }>();
  app.use("/preview/*", previewTokenAuth);
  app.use("/preview/:id", previewTokenAuth);
  app.use("/preview/*", authMiddleware);
  app.use("/preview/:id", authMiddleware);
  app.use("/api/private", authMiddleware);
  app.get("/api/private", (c) => c.json({ userId: c.get("user").id }));
  app.route("/", createPreviewRouter());
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
  let kv: MockKV;

  beforeEach(async () => {
    bucket = createMockBucket();
    storage = new R2ProjectStorage(bucket);
    app = createTestApp();
    kv = createMockKV();
    await storage.createProject(userId, "proj", "Proj");
    await storage.writeFile(userId, "proj", "index.html", "<h1>Home</h1>");
  });

  async function get(path: string, accept = "*/*") {
    return app.request(
      `http://site-studio.test/preview/proj/${path}`,
      { headers: { Accept: accept } },
      createEnv(bucket, kv)
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

  it("embeds cache-buster and preview-token params on relative HTML URLs", async () => {
    await storage.writeFile(userId, "proj", "index.html", [
      '<link rel="stylesheet" href="styles.css">',
      '<script src="app.js"></script>',
      '<img src="photo.png">',
      '<a href="about.html">About</a>'
    ].join(""));

    const res = await get("index.html?v=42", "text/html");
    const html = await res.text();
    const token = /styles\.css\?v=42&amp;pt=([0-9a-f]{64})/.exec(html)?.[1]
      ?? /styles\.css\?v=42&pt=([0-9a-f]{64})/.exec(html)?.[1];

    expect(res.status).toBe(200);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(html).toContain(`app.js?v=42&pt=${token}`);
    expect(html).toContain(`photo.png?v=42&pt=${token}`);
    expect(html).toContain(`about.html?v=42&pt=${token}`);
    const stored = JSON.parse(kv.store.get(`preview-token:${token}`) || "{}");
    expect(stored.allowedPaths).toEqual(["about.html", "app.js", "photo.png", "styles.css"]);
  });

  it("does not disclose a preview bearer to protocol-relative authored URLs", async () => {
    await storage.writeFile(
      userId,
      "proj",
      "index.html",
      '<img src="//attacker.example/pixel.png"><script src="app.js"></script>'
    );
    const res = await get("index.html?v=42", "text/html");
    const html = await res.text();
    expect(html).toContain('src="//attacker.example/pixel.png"');
    expect(html).not.toMatch(/attacker\.example[^"']*pt=/);
    expect(html).toMatch(/app\.js\?v=42&pt=[0-9a-f]{64}/);
  });

  it("does not serve protected project bookkeeping files", async () => {
    const res = await get(".metadata.json");
    expect(res.status).toBe(404);
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

describe("preview token authentication", () => {
  const userId = "user_test123";
  let bucket: ReturnType<typeof createMockBucket>;
  let storage: R2ProjectStorage;
  let kv: MockKV;
  let app: ReturnType<typeof createAuthenticatedPreviewApp>;

  beforeEach(async () => {
    bucket = createMockBucket();
    storage = new R2ProjectStorage(bucket);
    kv = createMockKV();
    app = createAuthenticatedPreviewApp();
    await storage.createProject(userId, "proj", "Proj");
    await storage.writeFile(userId, "proj", "styles.css", "body { color: red; }");
    await storage.createProject(userId, "other", "Other");
    await storage.writeFile(userId, "other", "styles.css", "body { color: blue; }");
  });

  it("serves a project asset without a session cookie when its preview token is valid", async () => {
    const token = await mintPreviewToken(kv, userId, "proj", ["styles.css"]);
    const res = await app.request(
      `http://site-studio.test/preview/proj/styles.css?pt=${token}`,
      {},
      createEnv(bucket, kv)
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("color: red");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("does not authorize a different project with a valid token", async () => {
    const token = await mintPreviewToken(kv, userId, "proj", ["styles.css"]);
    const res = await app.request(
      `http://site-studio.test/preview/other/styles.css?pt=${token}`,
      {},
      createEnv(bucket, kv)
    );

    expect(res.status).toBe(404);
  });

  it("falls through to normal anonymous auth for a garbage token", async () => {
    const res = await app.request(
      "http://site-studio.test/preview/proj/styles.css?pt=garbage",
      {},
      createEnv(bucket, kv)
    );

    expect(res.status).toBe(404);
  });

  it("never authorizes an API route", async () => {
    const token = await mintPreviewToken(kv, userId, "proj", ["styles.css"]);
    const res = await app.request(
      `http://site-studio.test/api/private?pt=${token}`,
      {},
      createEnv(bucket, kv, { CAIL_REQUIRE_IDENTITY: "true" })
    );

    expect(res.status).toBe(401);
  });

  it("does not authorize an unlinked file with a leaked resource token", async () => {
    await storage.writeFile(userId, "proj", "private.txt", "not linked");
    const token = await mintPreviewToken(kv, userId, "proj", ["styles.css"]);
    const res = await app.request(
      `http://site-studio.test/preview/proj/private.txt?pt=${token}`,
      {},
      createEnv(bucket, kv, { CAIL_REQUIRE_IDENTITY: "true" })
    );
    expect(res.status).toBe(401);
  });

  it("caps child preview grants at the parent capability's absolute expiry", async () => {
    await storage.writeFile(
      userId,
      "proj",
      "about.html",
      '<script src="app.js"></script>'
    );
    await storage.writeFile(userId, "proj", "app.js", "console.log('ok')");
    const expiresAt = Date.now() + 90_000;
    const parent = await mintPreviewToken(
      kv,
      userId,
      "proj",
      ["about.html"],
      expiresAt
    );
    const res = await app.request(
      `http://site-studio.test/preview/proj/about.html?pt=${parent}`,
      { headers: { Accept: "text/html" } },
      createEnv(bucket, kv, { CAIL_REQUIRE_IDENTITY: "true" })
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    const child = /app\.js\?v=\d+&pt=([0-9a-f]{64})/.exec(html)?.[1];
    expect(child).toMatch(/^[0-9a-f]{64}$/);
    const stored = JSON.parse(kv.store.get(`preview-token:${child}`) || "{}");
    expect(stored.expiresAt).toBe(expiresAt);
    expect(stored.allowedPaths).toEqual(["app.js"]);
  });
});

/**
 * Preview-vs-publish extensionless PARITY. Post-alignment the two routes share
 * one app-local resolver, so they must resolve the same extensionless request
 * to the same body. This test is the anti-drift guard: it drives the SAME
 * seeded project through both /preview/ and the published /u/{handle}/{slug}/
 * path and asserts the served bytes match, across all three resolution cases
 * (flat sibling wins, flat-preferred-over-nested, nested fallback).
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
