import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../types";
import { R2ProjectStorage } from "../storage/r2";
import { createPreviewRouter } from "./preview";

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
  return app;
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

  // CHARACTERIZATION of the CURRENT (pre-alignment) behavior. preview.ts today
  // never probes `{path}.html` for an extensionless request — it only tries
  // `{path}/index.html`. The two tests below therefore capture the divergence
  // from publish/publisher; the sanctioned change flips them to match publish.
  describe("[current behavior, pre-alignment]", () => {
    it("does NOT resolve extensionless /about to a flat about.html (404)", async () => {
      await storage.writeFile(userId, "proj", "about.html", "<h1>Flat About</h1>");
      const res = await get("about", "text/html");
      // No about/index.html exists and preview never tries about.html, so 404.
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("Page not found");
    });

    it("prefers {path}/index.html over a flat {path}.html when both exist", async () => {
      await storage.writeFile(userId, "proj", "blog.html", "<h1>Flat Blog</h1>");
      await storage.writeFile(userId, "proj", "blog/index.html", "<h1>Nested Blog</h1>");
      const res = await get("blog", "text/html");
      expect(res.status).toBe(200);
      // Current preview only tries the nested form, so it wins.
      expect(await res.text()).toContain("Nested Blog");
    });
  });
});
