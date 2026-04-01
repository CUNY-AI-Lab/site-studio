import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../types";
import { R2ProjectStorage } from "../storage/r2";
import { createFileRouter } from "./files";
import { createPreviewRouter } from "./preview";
import { createPublishRouter } from "./publish";
import { createProjectRouter } from "./projects";

function createMockBucket() {
  const store = new Map<string, { data: ArrayBuffer | string; httpMetadata?: unknown }>();

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
        size: typeof data === "string" ? data.length : data.byteLength,
        httpMetadata: entry.httpMetadata || {},
        text: async () => typeof data === "string" ? data : new TextDecoder().decode(data),
        arrayBuffer: async () => typeof data === "string" ? new TextEncoder().encode(data).buffer : data,
      };
    }),
    put: vi.fn(async (key: string, data: string | ArrayBuffer | Uint8Array, options?: { httpMetadata?: unknown }) => {
      let stored: ArrayBuffer | string;
      if (typeof data === "string") {
        stored = data;
      } else if (data instanceof ArrayBuffer) {
        stored = data;
      } else {
        stored = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      }

      store.set(key, { data: stored, httpMetadata: options?.httpMetadata });
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async ({ prefix, delimiter, limit }: { prefix?: string; delimiter?: string; limit?: number } = {}) => {
      const objects: Array<{ key: string; size: number; uploaded: Date; httpMetadata: Record<string, never> }> = [];
      const delimitedPrefixes: string[] = [];

      for (const key of store.keys()) {
        if (prefix && !key.startsWith(prefix)) continue;

        if (delimiter) {
          const rest = key.slice(prefix?.length || 0);
          const delimiterIndex = rest.indexOf(delimiter);
          if (delimiterIndex >= 0) {
            const delimitedPrefix = `${prefix || ""}${rest.slice(0, delimiterIndex + 1)}`;
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
          httpMetadata: {},
        });
      }

      return {
        objects: limit ? objects.slice(0, limit) : objects,
        truncated: false,
        delimitedPrefixes,
      };
    }),
  } as unknown as R2Bucket & { store: Map<string, { data: ArrayBuffer | string; httpMetadata?: unknown }> };
}

function createTestApp() {
  const app = new Hono<{ Bindings: Env; Variables: { user: { id: string; createdAt: string } } }>();

  app.use("*", async (c, next) => {
    c.set("user", {
      id: "user_test123",
      createdAt: "2026-04-01T00:00:00.000Z"
    });
    await next();
  });

  app.route("/", createFileRouter());
  app.route("/", createPreviewRouter());
  app.route("/", createPublishRouter());
  app.route("/", createProjectRouter());
  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json({ error: error.message }, error.status);
    }

    throw error;
  });

  return app;
}

function createEnv(bucket: R2Bucket): Env {
  return {
    SESSION_KV: {} as KVNamespace,
    SITE_STUDIO_BUCKET: bucket,
    SITE_BUILDER_AGENT: {} as DurableObjectNamespace<any>,
    LOADER: {} as WorkerLoader,
    ASSETS: undefined,
  };
}

describe("route regressions", () => {
  const userId = "user_test123";
  let bucket: ReturnType<typeof createMockBucket>;
  let storage: R2ProjectStorage;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    bucket = createMockBucket();
    storage = new R2ProjectStorage(bucket);
    app = createTestApp();
  });

  it("returns 404 for missing preview assets", async () => {
    await storage.createProject(userId, "preview-project", "Preview Project");
    await storage.writeFile(userId, "preview-project", "index.html", "<h1>Hello</h1>");

    const response = await app.request(
      "http://site-studio.test/preview/preview-project/missing.css",
      undefined,
      createEnv(bucket)
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });

  it("returns 404 for missing project file reads and downloads", async () => {
    await storage.createProject(userId, "files-project", "Files Project");

    const fileResponse = await app.request(
      "http://site-studio.test/api/projects/files-project/file?path=missing.txt",
      undefined,
      createEnv(bucket)
    );
    expect(fileResponse.status).toBe(404);
    await expect(fileResponse.json()).resolves.toEqual({ error: "File not found" });

    const downloadResponse = await app.request(
      "http://site-studio.test/api/projects/files-project/download?path=missing.txt",
      undefined,
      createEnv(bucket)
    );
    expect(downloadResponse.status).toBe(404);
    await expect(downloadResponse.json()).resolves.toEqual({ error: "File not found" });
  });

  it("assigns a unique slug when another published project already owns it", async () => {
    await storage.createProject(userId, "bar", "Bar");
    await storage.writeFile(userId, "bar", "index.html", "<h1>Alpha</h1>");
    await storage.updateProjectMetadata(userId, "bar", {
      published: true,
      slug: "foo",
      publishedAt: "2026-04-01T00:00:00.000Z",
      publishedUrl: "https://tools.cuny.qzz.io/sites/user_test123/foo/"
    });

    await storage.createProject(userId, "foo", "Foo");
    await storage.writeFile(userId, "foo", "index.html", "<h1>Beta</h1>");

    const publishResponse = await app.request(
      "http://site-studio.test/api/projects/foo/publish",
      { method: "POST" },
      createEnv(bucket)
    );

    expect(publishResponse.status).toBe(200);
    await expect(publishResponse.json()).resolves.toMatchObject({
      success: true,
      url: "http://site-studio.test/sites/user_test123/foo-2/"
    });

    const publishedSiteResponse = await app.request(
      "http://site-studio.test/sites/user_test123/foo-2/",
      undefined,
      createEnv(bucket)
    );

    expect(await publishedSiteResponse.text()).toContain("<h1>Beta</h1>");
  });

  it("uses the configured published base URL when provided", async () => {
    await storage.createProject(userId, "configured-url", "Configured Url");
    await storage.writeFile(userId, "configured-url", "index.html", "<h1>Configured</h1>");

    const response = await app.request(
      "http://site-studio.test/api/projects/configured-url/publish",
      { method: "POST" },
      {
        ...createEnv(bucket),
        PUBLISHED_BASE_URL: "https://publish.example.edu/"
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      url: "https://publish.example.edu/sites/user_test123/configured-url/"
    });
  });

  it("uses the legacy R2 public domain when provided", async () => {
    await storage.createProject(userId, "legacy-domain", "Legacy Domain");
    await storage.writeFile(userId, "legacy-domain", "index.html", "<h1>Legacy</h1>");

    const response = await app.request(
      "http://site-studio.test/api/projects/legacy-domain/publish",
      { method: "POST" },
      {
        ...createEnv(bucket),
        R2_PUBLIC_DOMAIN: "https://tools.cuny.qzz.io"
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      url: "https://tools.cuny.qzz.io/sites/user_test123/legacy-domain/"
    });
  });

  it("skips malformed project metadata instead of failing the projects list", async () => {
    await bucket.put(`projects/${userId}/broken-project/.metadata.json`, "{not valid json");
    await storage.createProject(userId, "healthy-project", "Healthy Project");

    const response = await app.request(
      "http://site-studio.test/api/projects",
      undefined,
      createEnv(bucket)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      projects: [
        {
          id: "broken-project",
          name: "broken-project",
          published: false,
          publishedUrl: undefined,
          thumbnailUrl: undefined
        },
        {
          id: "healthy-project",
          name: "Healthy Project",
          published: false,
          publishedUrl: undefined,
          thumbnailUrl: undefined
        }
      ]
    });
  });

  it("serves the most recently published project when legacy duplicate slugs exist", async () => {
    await storage.createProject(userId, "bar", "Bar");
    await storage.writeFile(userId, "bar", "index.html", "<h1>Alpha</h1>");
    await storage.updateProjectMetadata(userId, "bar", {
      published: true,
      slug: "foo",
      publishedAt: "2026-04-01T00:00:00.000Z"
    });

    await storage.createProject(userId, "foo", "Foo");
    await storage.writeFile(userId, "foo", "index.html", "<h1>Beta</h1>");
    await storage.updateProjectMetadata(userId, "foo", {
      published: true,
      slug: "foo",
      publishedAt: "2026-04-02T00:00:00.000Z"
    });

    const response = await app.request(
      "http://site-studio.test/sites/user_test123/foo/",
      undefined,
      createEnv(bucket)
    );

    expect(await response.text()).toContain("<h1>Beta</h1>");
  });
});
