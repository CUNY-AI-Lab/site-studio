import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../types";
import { R2ProjectStorage } from "../storage/r2";
import { createPreviewRouter } from "./preview";
import { createPublishRouter } from "./publish";
import { authMiddleware } from "../lib/session";
import { mintPreviewToken, previewTokenAuth } from "../lib/preview-token";
import { createMockKV, createTestR2Object, type MockKV } from "../lib/test-utils";
import { z } from "zod";

/**
 * Dedicated coverage for the editor preview route's file resolution. preview.ts
 * previously had NO dedicated tests, so this suite first CHARACTERIZES its
 * current extensionless-resolution behavior — the point of divergence from the
 * publisher/publish paths — so the sanctioned alignment change (preview → try
 * `{path}.html` before `{path}/index.html`, matching publish) is explicit in
 * the diff that follows.
 */

function createMockBucket() {
  type MockData = string | ArrayBuffer;
  type MockEntry = { data: MockData; httpMetadata?: R2HTTPMetadata };
  const dataSchema = z.union([z.string(), z.instanceof(ArrayBuffer)]);
  const store = new Map<string, MockEntry>();
  // SAFETY: The fixture implements every R2 operation exercised by the preview
  // and publish routes; uncalled binding methods are outside this test boundary.
  return {
    store,
    head: vi.fn(async (key: string) => (store.has(key) ? { key, size: 0 } : null)),
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      const data = dataSchema.parse(entry.data);
      return {
        key,
        size: data instanceof ArrayBuffer ? data.byteLength : data.length,
        httpMetadata: entry.httpMetadata || {},
        text: async () => (data instanceof ArrayBuffer ? new TextDecoder().decode(data) : data),
        arrayBuffer: async () =>
          data instanceof ArrayBuffer ? data : new TextEncoder().encode(data).buffer
      };
    }),
    put: vi.fn(async (key: string, data: MockData, options?: { httpMetadata?: R2HTTPMetadata }) => {
      store.set(key, { data, httpMetadata: options?.httpMetadata });
      return createTestR2Object(key, `${key}:1`, data instanceof ArrayBuffer ? data.byteLength : data.length);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async ({ prefix }: { prefix?: string } = {}) => {
      const objects: R2Object[] = [];
      for (const key of store.keys()) {
        if (prefix && !key.startsWith(prefix)) continue;
        objects.push(createTestR2Object(key));
      }
      return { objects, truncated: false, delimitedPrefixes: [] };
    }),
    createMultipartUpload: vi.fn(async () => { throw new Error("multipart upload is not part of this fixture"); }),
    resumeMultipartUpload: vi.fn(() => { throw new Error("multipart upload is not part of this fixture"); })
  } as R2Bucket & { store: Map<string, MockEntry> };
}

function createEnv(bucket: R2Bucket, kv: KVNamespace = createMockKV(), overrides: Partial<Env> = {}): Env {
  return {
    CAIL_LOG_ENV: "test",
    SESSION_KV: kv,
    SITE_STUDIO_BUCKET: bucket,
    // SAFETY: Preview tests do not connect to either Durable Object namespace.
    SITE_BUILDER_AGENT: {} as DurableObjectNamespace<any>,
    // SAFETY: Preview tests do not invoke migration coordination.
    MIGRATION_COORDINATOR: {} as DurableObjectNamespace<any>,
    // SAFETY: The app does not load templates through the WorkerLoader in this suite.
    LOADER: {} as WorkerLoader,
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
    await storage.writeFile(userId, "proj", "docs/index.html", '<a href="./?x">Directory</a><h1>Docs</h1>');
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

  it("rewrites root-relative HTML URLs to the project preview mount", async () => {
    await storage.writeFile(userId, "proj", "index.html", [
      '<link rel="stylesheet" href="/styles.css">',
      '<script src="/app.js"></script>',
      '<a href="/docs/">Docs</a>'
    ].join(""));
    await storage.writeFile(userId, "proj", "styles.css", "body { color: red; }");
    await storage.writeFile(userId, "proj", "app.js", "console.log('ok');");
    await storage.writeFile(userId, "proj", "docs/index.html", "<h1>Docs</h1>");

    const res = await get("index.html?v=42", "text/html");
    const html = await res.text();
    const token = /\/preview\/proj\/styles\.css\?v=42&pt=([0-9a-f]{64})/.exec(html)?.[1];
    const directoryToken = /\/preview\/proj\/docs\/\?v=42&pt=([0-9a-f]{64})/.exec(html)?.[1];

    expect(res.status).toBe(200);
    expect(html).toContain(`/preview/proj/app.js?v=42&pt=${token}`);
    expect(html).toContain(`/preview/proj/docs/?v=42&pt=${directoryToken}`);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(directoryToken).toMatch(/^[0-9a-f]{64}$/);
    const stored = JSON.parse(kv.store.get(`preview-token:${token}`) || "{}");
    expect(stored.allowedPaths).toEqual(["app.js", "docs/", "styles.css"]);

    const directory = await app.request(
      `http://site-studio.test/preview/proj/docs/?pt=${directoryToken}`,
      { headers: { Accept: "text/html" } },
      createEnv(bucket, kv)
    );
    expect(directory.status).toBe(200);
    const directoryHtml = await directory.text();
    expect(directoryHtml).toContain("Docs");
  });

  it("does not leak a preview token through an external base URL", async () => {
    await storage.writeFile(userId, "proj", "index.html", [
      '<base href="https://outside.example/">',
      '<script src="app.js"></script>',
      '<img src="/logo.png">'
    ].join(""));
    await storage.writeFile(userId, "proj", "logo.png", "logo");

    const response = await get("index.html", "text/html");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('<script src="app.js"></script>');
    const token = /\/preview\/proj\/logo\.png\?v=\d+&pt=([0-9a-f]{64})/.exec(html)?.[1];
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(kv.store.get(`preview-token:${token}`) || "{}").allowedPaths).toEqual(["logo.png"]);
  });

  it("keeps the configured ingress mount on rewritten preview URLs", async () => {
    await storage.writeFile(userId, "proj", "index.html", '<script src="/app.js"></script>');
    await storage.writeFile(userId, "proj", "app.js", "console.log('ok');");

    const res = await app.request(
      "http://site-studio.test/preview/proj/index.html",
      { headers: { Accept: "text/html" } },
      createEnv(bucket, kv, { CSRF_COOKIE_PATH: "/site-studio" })
    );
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toMatch(/\/site-studio\/preview\/proj\/app\.js\?v=\d+&pt=[0-9a-f]{64}/);
  });

  it("does not add the production mount to loopback preview URLs", async () => {
    await storage.writeFile(userId, "proj", "index.html", '<script src="/app.js"></script>');
    await storage.writeFile(userId, "proj", "app.js", "console.log('ok');");

    const res = await app.request(
      "http://localhost:8792/preview/proj/index.html",
      { headers: { Accept: "text/html" } },
      createEnv(bucket, kv, { CSRF_COOKIE_PATH: "/site-studio" })
    );
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toMatch(/\/preview\/proj\/app\.js\?v=\d+&pt=[0-9a-f]{64}/);
    expect(html).not.toContain("/site-studio/preview/");
  });

  it("propagates scoped preview access through nested CSS URLs", async () => {
    await storage.writeFile(userId, "proj", "index.html", '<link rel="stylesheet" href="styles/main.css">');
    await storage.writeFile(userId, "proj", "styles/main.css", [
      '@import "/theme.css";',
      ".hero { background: url(/images/hero.png); }",
      "@font-face { src: url(../fonts/body.woff2); }"
    ].join("\n"));
    await storage.writeFile(userId, "proj", "images/hero.png", "hero");
    await storage.writeFile(userId, "proj", "fonts/body.woff2", "font");
    await storage.writeFile(userId, "proj", "theme.css", "body { color: blue; }");

    const page = await get("index.html", "text/html");
    const pageHtml = await page.text();
    const pageToken = /styles\/main\.css\?v=\d+&pt=([0-9a-f]{64})/.exec(pageHtml)?.[1];
    expect(pageToken).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(kv.store.get(`preview-token:${pageToken}`) || "{}").allowedPaths).toEqual([
      "styles/main.css"
    ]);

    const css = await get(`styles/main.css?pt=${pageToken}`, "text/css");
    const cssText = await css.text();
    const cssToken = /\/preview\/proj\/images\/hero\.png\?v=\d+&pt=([0-9a-f]{64})/.exec(cssText)?.[1];
    expect(cssToken).toMatch(/^[0-9a-f]{64}$/);
    expect(cssText).toContain(`/preview/proj/theme.css?v=`);
    expect(cssText).toContain(`../fonts/body.woff2?v=`);
    expect(JSON.parse(kv.store.get(`preview-token:${cssToken}`) || "{}").allowedPaths).toEqual([
      "fonts/body.woff2",
      "images/hero.png",
      "theme.css"
    ]);
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

  it("scopes query-only and dot-directory links to their actual preview paths", async () => {
    await storage.writeFile(userId, "proj", "docs/index.html", '<a href="?x">Current</a><a href="./?x">Directory</a>');
    const parent = await mintPreviewToken(kv, userId, "proj", ["docs/index.html"]);
    const page = await app.request(
      `http://site-studio.test/preview/proj/docs/index.html?pt=${parent}`,
      { headers: { Accept: "text/html" } },
      createEnv(bucket, kv)
    );

    expect(page.status).toBe(200);
    const html = await page.text();
    const child = /[?&]v=\d+&pt=([0-9a-f]{64})/.exec(html)?.[1];
    expect(child).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(kv.store.get(`preview-token:${child}`) || "{}").allowedPaths).toEqual([
      "docs/",
      "docs/index.html"
    ]);

    const current = await app.request(
      `http://site-studio.test/preview/proj/docs/index.html?pt=${child}`,
      {},
      createEnv(bucket, kv)
    );
    const directory = await app.request(
      `http://site-studio.test/preview/proj/docs/?pt=${child}`,
      {},
      createEnv(bucket, kv)
    );
    expect(current.status).toBe(200);
    expect(directory.status).toBe(200);
  });

  it("does not authorize a different project with a valid token", async () => {
    const token = await mintPreviewToken(kv, userId, "proj", ["styles.css"]);
    const res = await app.request(
      `http://site-studio.test/preview/other/styles.css?pt=${token}`,
      {},
      createEnv(bucket, kv)
    );

    expect(res.status).toBe(401);
  });

  it("requires verified identity for a garbage preview token", async () => {
    const res = await app.request(
      "http://site-studio.test/preview/proj/styles.css?pt=garbage",
      {},
      createEnv(bucket, kv)
    );

    expect(res.status).toBe(401);
  });

  it("never authorizes an API route", async () => {
    const token = await mintPreviewToken(kv, userId, "proj", ["styles.css"]);
    const res = await app.request(
      `http://site-studio.test/api/private?pt=${token}`,
      {},
      createEnv(bucket, kv)
    );

    expect(res.status).toBe(401);
  });

  it("does not authorize an unlinked file with a leaked resource token", async () => {
    await storage.writeFile(userId, "proj", "private.txt", "not linked");
    const token = await mintPreviewToken(kv, userId, "proj", ["styles.css"]);
    const res = await app.request(
      `http://site-studio.test/preview/proj/private.txt?pt=${token}`,
      {},
      createEnv(bucket, kv)
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
      createEnv(bucket, kv)
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    const child = /app\.js\?v=\d+&pt=([0-9a-f]{64})/.exec(html)?.[1];
    expect(child).toMatch(/^[0-9a-f]{64}$/);
    const stored = JSON.parse(kv.store.get(`preview-token:${child}`) || "{}");
    expect(stored.expiresAt).toBe(expiresAt);
    expect(stored.allowedPaths).toEqual(["app.js"]);
  });

  it("serves a root-relative asset through its scoped child preview grant", async () => {
    await storage.writeFile(
      userId,
      "proj",
      "index.html",
      '<link rel="stylesheet" href="/styles.css"><script src="/app.js"></script>'
    );
    await storage.writeFile(userId, "proj", "app.js", "console.log('ok')");
    const parent = await mintPreviewToken(kv, userId, "proj", ["index.html"]);
    const page = await app.request(
      `http://site-studio.test/preview/proj/index.html?pt=${parent}`,
      { headers: { Accept: "text/html" } },
      createEnv(bucket, kv)
    );

    expect(page.status).toBe(200);
    const html = await page.text();
    const child = /\/preview\/proj\/app\.js\?v=\d+&pt=([0-9a-f]{64})/.exec(html)?.[1];
    expect(child).toMatch(/^[0-9a-f]{64}$/);

    const asset = await app.request(
      `http://site-studio.test/preview/proj/app.js?pt=${child}`,
      {},
      createEnv(bucket, kv)
    );
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("console.log('ok')");
  });

  it("serves nested CSS assets through a scoped child preview grant", async () => {
    await storage.writeFile(userId, "proj", "styles/main.css", [
      ".hero { background: url(/images/hero.png); }",
      "@font-face { src: url(../fonts/body.woff2); }"
    ].join("\n"));
    await storage.writeFile(userId, "proj", "images/hero.png", "hero");
    await storage.writeFile(userId, "proj", "fonts/body.woff2", "font");
    const parent = await mintPreviewToken(kv, userId, "proj", ["styles/main.css"]);

    const page = await app.request(
      `http://site-studio.test/preview/proj/styles/main.css?pt=${parent}`,
      { headers: { Accept: "text/css" } },
      createEnv(bucket, kv)
    );
    expect(page.status).toBe(200);
    const css = await page.text();
    const child = /\/preview\/proj\/images\/hero\.png\?v=\d+&pt=([0-9a-f]{64})/.exec(css)?.[1];
    expect(child).toMatch(/^[0-9a-f]{64}$/);

    const asset = await app.request(
      `http://site-studio.test/preview/proj/images/hero.png?pt=${child}`,
      {},
      createEnv(bucket, kv)
    );
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe("hero");
  });

  it("rewrites standalone SVG URLs with a scoped child preview grant", async () => {
    await storage.writeFile(userId, "proj", "icon.svg", [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">',
      '<image href="/images/icon.png" xlink:href="/images/icon.png" />',
      "</svg>"
    ].join(""));
    await storage.writeFile(userId, "proj", "images/icon.png", "icon");
    const parent = await mintPreviewToken(kv, userId, "proj", ["icon.svg"]);

    const response = await app.request(
      `http://site-studio.test/preview/proj/icon.svg?pt=${parent}`,
      { headers: { Accept: "image/svg+xml" } },
      createEnv(bucket, kv)
    );
    const svg = await response.text();
    const token = /\/preview\/proj\/images\/icon\.png\?v=\d+&pt=([0-9a-f]{64})/.exec(svg)?.[1];

    expect(response.status).toBe(200);
    expect(svg).toContain(`/preview/proj/images/icon.png?v=`);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(kv.store.get(`preview-token:${token}`) || "{}").allowedPaths).toEqual([
      "images/icon.png"
    ]);
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

  it("rewrites root-relative assets on preview and published HTML", async () => {
    await storage.writeFile(userId, slug, "index.html", [
      '<link rel="stylesheet" href="/styles.css">',
      '<script src="/app.js"></script>',
      '<a href="/docs/">Docs</a>'
    ].join(""));
    await storage.writeFile(userId, slug, "styles.css", "body { color: red; }");
    await storage.writeFile(userId, slug, "app.js", "console.log('ok');");
    await storage.writeFile(userId, slug, "docs/index.html", "<h1>Docs</h1>");

    const preview = await previewBody("index.html");
    const publish = await publishBody("index.html");
    expect(preview.status).toBe(200);
    expect(publish.status).toBe(200);
    expect(preview.body).toMatch(/\/preview\/site\/styles\.css\?v=\d+&pt=[0-9a-f]{64}/);
    expect(preview.body).toMatch(/\/preview\/site\/app\.js\?v=\d+&pt=[0-9a-f]{64}/);
    expect(publish.body).toContain('href="/u/janedoe/site/styles.css"');
    expect(publish.body).toContain('src="/u/janedoe/site/app.js"');
    expect(publish.body).toContain('href="/u/janedoe/site/docs/"');

    const publishedPage = await app.request(
      "http://site-studio.test/u/janedoe/site/index.html",
      {},
      createEnv(bucket)
    );
    expect(publishedPage.headers.get("ETag")).toBeNull();

    const asset = await app.request(
      "http://site-studio.test/u/janedoe/site/styles.css",
      {},
      createEnv(bucket)
    );
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("color: red");

    const publishedDirectory = await app.request(
      "http://site-studio.test/u/janedoe/site/docs/",
      {},
      createEnv(bucket)
    );
    expect(publishedDirectory.status).toBe(200);
    expect(await publishedDirectory.text()).toContain("Docs");
  });

  it("rewrites root-relative URLs in published CSS", async () => {
    await storage.writeFile(userId, slug, "styles/main.css", [
      '@import "/theme.css";',
      ".hero { background: url(/images/hero.png); }"
    ].join("\n"));
    await storage.writeFile(userId, slug, "images/hero.png", "hero");
    await storage.writeFile(userId, slug, "theme.css", "body { color: blue; }");

    const response = await app.request(
      "http://site-studio.test/u/janedoe/site/styles/main.css",
      {},
      createEnv(bucket)
    );
    expect(response.status).toBe(200);
    const css = await response.text();
    expect(css).toContain("url(/u/janedoe/site/images/hero.png)");
    expect(css).toContain('@import "/u/janedoe/site/theme.css";');
  });

  it("rewrites root-relative URLs in published SVG", async () => {
    await storage.writeFile(userId, slug, "icon.svg", '<svg><image href="/images/icon.png" /></svg>');
    await storage.writeFile(userId, slug, "images/icon.png", "icon");

    const response = await app.request(
      "http://site-studio.test/u/janedoe/site/icon.svg",
      {},
      createEnv(bucket)
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('href="/u/janedoe/site/images/icon.png"');
  });

  it("preserves published HTML bytes when no mount rewrite is needed", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x3c, 0x68, 0x31, 0x3e, 0xff, 0x3c, 0x2f, 0x68, 0x31, 0x3e]);
    bucket.store.set(`projects/${userId}/${slug}/index.html`, {
      data: bytes.buffer
    });

    const response = await app.request(
      "http://site-studio.test/u/janedoe/site/index.html",
      {},
      createEnv(bucket)
    );
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });
});
