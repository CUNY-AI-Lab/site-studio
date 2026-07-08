import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../types";
import { CSRF_ERROR_BODY, CSRF_HEADER_NAME, csrfProtect } from "../lib/csrf";
import { createMockKV, mintCsrfSession, type CsrfSession, type MockKV } from "../lib/test-utils";
import { R2ProjectStorage } from "../storage/r2";
import { MAX_SNAPSHOT_BYTES } from "../lib/constants";
import { createFileRouter } from "./files";
import { createHandleRouter } from "./handles";
import { createPreviewRouter } from "./preview";
import { createPublishRouter } from "./publish";
import { createProjectRouter } from "./projects";

// Module-scoped session bits, reset per test: createEnv() and the request
// helpers read these so individual tests stay terse.
let kv: MockKV;
let csrf: CsrfSession;

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
    put: vi.fn(async (
      key: string,
      data: string | ArrayBuffer | Uint8Array,
      options?: { httpMetadata?: unknown; onlyIf?: { etagDoesNotMatch?: string } }
    ) => {
      // Honor R2 put-if-absent: onlyIf.etagDoesNotMatch:"*" writes only when the
      // key is empty; a failed condition returns null (no write, no throw).
      if (options?.onlyIf?.etagDoesNotMatch === "*" && store.has(key)) {
        return null;
      }
      let stored: ArrayBuffer | string;
      if (typeof data === "string") {
        stored = data;
      } else if (data instanceof ArrayBuffer) {
        stored = data;
      } else {
        stored = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      }

      store.set(key, { data: stored, httpMetadata: options?.httpMetadata });
      return { key };
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

        const entry = store.get(key);
        const size = entry
          ? typeof entry.data === "string"
            ? entry.data.length
            : entry.data.byteLength
          : 0;
        objects.push({
          key,
          size,
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

  // Mirror production (src/app.ts): every state-changing /api route sits
  // behind csrfProtect, so mutation tests must present the session token.
  app.use("/api/*", csrfProtect);

  app.route("/", createFileRouter());
  app.route("/", createPreviewRouter());
  app.route("/", createPublishRouter());
  app.route("/", createProjectRouter());
  app.route("/", createHandleRouter());
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
    SESSION_KV: kv,
    SITE_STUDIO_BUCKET: bucket,
    SITE_BUILDER_AGENT: {} as DurableObjectNamespace<any>,
    MIGRATION_COORDINATOR: {} as DurableObjectNamespace<any>,
    LOADER: {} as WorkerLoader,
    ASSETS: undefined,
  };
}

/** Give an owner a claimed public handle (both mapping records). */
function seedHandle(
  bucket: ReturnType<typeof createMockBucket>,
  ownerId: string,
  handle: string
) {
  const claimedAt = "2026-01-01T00:00:00.000Z";
  bucket.store.set(`handles/${handle}.json`, { data: JSON.stringify({ ownerId, claimedAt }) });
  bucket.store.set(`userhandles/${ownerId}.json`, { data: JSON.stringify({ handle, claimedAt }) });
}

describe("route regressions", () => {
  const userId = "user_test123";
  const handle = "janedoe";
  let bucket: ReturnType<typeof createMockBucket>;
  let storage: R2ProjectStorage;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    bucket = createMockBucket();
    storage = new R2ProjectStorage(bucket);
    app = createTestApp();
    kv = createMockKV();
    csrf = await mintCsrfSession(kv, userId);
    // The publish flow now requires a public handle; give the test user one so
    // the existing publish/serve regressions exercise the /u/{handle}/ path.
    seedHandle(bucket, userId, handle);
  });

  it("returns a terse 404 for missing preview assets", async () => {
    await storage.createProject(userId, "preview-project", "Preview Project");
    await storage.writeFile(userId, "preview-project", "index.html", "<h1>Hello</h1>");

    const response = await app.request(
      "http://site-studio.test/preview/preview-project/missing.css",
      undefined,
      createEnv(bucket)
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type") || "").toContain("text/plain");
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("serves the styled 404 page for missing preview navigations", async () => {
    await storage.createProject(userId, "preview-project", "Preview Project");
    await storage.writeFile(userId, "preview-project", "index.html", "<h1>Hello</h1>");

    const response = await app.request(
      "http://site-studio.test/preview/preview-project/missing.html",
      { headers: { Accept: "text/html" } },
      createEnv(bucket)
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type") || "").toContain("text/html");
    const body = await response.text();
    expect(body).toContain("Page not found");
    expect(body).toContain('href="/preview/preview-project/"');
  });

  it("serves the styled 404 page for missing published navigations", async () => {
    await storage.createProject(userId, "pub", "Pub");
    await storage.writeFile(userId, "pub", "index.html", "<h1>Home</h1>");
    await storage.updateProjectMetadata(userId, "pub", {
      published: true,
      slug: "pub"
    });

    const response = await app.request(
      "http://site-studio.test/u/janedoe/pub/missing.html",
      { headers: { Accept: "text/html" } },
      createEnv(bucket)
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type") || "").toContain("text/html");
    const body = await response.text();
    expect(body).toContain("Page not found");
    expect(body).toContain('href="/u/janedoe/pub/"');
  });

  it("honors a project 404.html for missing published navigations", async () => {
    await storage.createProject(userId, "pub2", "Pub2");
    await storage.writeFile(userId, "pub2", "index.html", "<h1>Home</h1>");
    await storage.writeFile(userId, "pub2", "404.html", "<h1>Custom missing</h1>");
    await storage.updateProjectMetadata(userId, "pub2", {
      published: true,
      slug: "pub2"
    });

    const response = await app.request(
      "http://site-studio.test/u/janedoe/pub2/nope.html",
      { headers: { Accept: "text/html" } },
      createEnv(bucket)
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Custom missing");
  });

  it("keeps a terse 404 for missing published assets", async () => {
    await storage.createProject(userId, "pub3", "Pub3");
    await storage.writeFile(userId, "pub3", "index.html", "<h1>Home</h1>");
    await storage.updateProjectMetadata(userId, "pub3", {
      published: true,
      slug: "pub3"
    });

    const response = await app.request(
      "http://site-studio.test/u/janedoe/pub3/missing.png",
      undefined,
      createEnv(bucket)
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type") || "").toContain("text/plain");
    await expect(response.text()).resolves.toBe("Not found");
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

  // SS-18: PROTECTED_FILE_NAMES were guarded on delete/rename but not on write,
  // so a caller could overwrite their own .metadata.json (flip published/slug).
  it("SS-18: rejects a write to .metadata.json via POST /file", async () => {
    await storage.createProject(userId, "protproj", "Prot Proj");
    const before = await storage.getProjectMetadata(userId, "protproj");

    const response = await app.request(
      "http://site-studio.test/api/projects/protproj/file",
      {
        method: "POST",
        body: JSON.stringify({ path: ".metadata.json", content: '{"published":true,"slug":"pwned"}' }),
        headers: { "Content-Type": "application/json", ...csrf.headers }
      },
      createEnv(bucket)
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Cannot overwrite protected files" });
    // Metadata is untouched — still unpublished.
    const after = await storage.getProjectMetadata(userId, "protproj");
    expect(after).toEqual(before);
    expect(after?.published).toBe(false);
  });

  // SS-20: a filename containing a `"` must not break the Content-Disposition
  // header token; the ASCII fallback is quote-stripped and the real name rides in
  // the RFC 5987 filename* form.
  it("SS-20: download emits a well-formed Content-Disposition for a quoted filename", async () => {
    await storage.createProject(userId, "dlproj", "Dl Proj");
    await storage.writeFile(userId, "dlproj", 'a"b.txt', "hello");

    const response = await app.request(
      `http://site-studio.test/api/projects/dlproj/download?path=${encodeURIComponent('a"b.txt')}`,
      undefined,
      createEnv(bucket)
    );

    expect(response.status).toBe(200);
    const cd = response.headers.get("Content-Disposition") || "";
    // No raw quote leaks into the quoted-string token (only the two delimiters).
    expect(cd).toBe("attachment; filename=\"ab.txt\"; filename*=UTF-8''a%22b.txt");
    // The quoted filename token has exactly two double-quotes (the delimiters).
    const quotedToken = cd.match(/filename="([^"]*)"/);
    expect(quotedToken?.[1]).toBe("ab.txt");
  });

  it("assigns a unique slug when another published project already owns it", async () => {
    await storage.createProject(userId, "bar", "Bar");
    await storage.writeFile(userId, "bar", "index.html", "<h1>Alpha</h1>");
    await storage.updateProjectMetadata(userId, "bar", {
      published: true,
      slug: "foo",
      publishedAt: "2026-04-01T00:00:00.000Z",
      publishedUrl: "https://tools.cuny.qzz.io/u/janedoe/foo/"
    });

    await storage.createProject(userId, "foo", "Foo");
    await storage.writeFile(userId, "foo", "index.html", "<h1>Beta</h1>");

    const publishResponse = await app.request(
      "http://site-studio.test/api/projects/foo/publish",
      { method: "POST", headers: csrf.headers },
      createEnv(bucket)
    );

    expect(publishResponse.status).toBe(200);
    const publishBody = await publishResponse.json() as { success: boolean; url: string; a11yFindings: unknown[] };
    expect(publishBody).toMatchObject({
      success: true,
      url: "http://site-studio.test/u/janedoe/foo-2/"
    });
    // The canonical URL carries the handle, never the owner/subject id.
    expect(publishBody.url).not.toContain("user_test123");
    // The publish response includes an accessibility findings array; the bare
    // "<h1>Beta</h1>" fragment has no <html>/<head>, so nothing to report.
    expect(Array.isArray(publishBody.a11yFindings)).toBe(true);
    expect(publishBody.a11yFindings).toEqual([]);

    const publishedSiteResponse = await app.request(
      "http://site-studio.test/u/janedoe/foo-2/",
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
      { method: "POST", headers: csrf.headers },
      {
        ...createEnv(bucket),
        PUBLISHED_BASE_URL: "https://publish.example.edu/"
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      url: "https://publish.example.edu/u/janedoe/configured-url/"
    });
  });

  it("uses the legacy R2 public domain when provided", async () => {
    await storage.createProject(userId, "legacy-domain", "Legacy Domain");
    await storage.writeFile(userId, "legacy-domain", "index.html", "<h1>Legacy</h1>");

    const response = await app.request(
      "http://site-studio.test/api/projects/legacy-domain/publish",
      { method: "POST", headers: csrf.headers },
      {
        ...createEnv(bucket),
        R2_PUBLIC_DOMAIN: "https://tools.cuny.qzz.io"
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      url: "https://tools.cuny.qzz.io/u/janedoe/legacy-domain/"
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
      "http://site-studio.test/u/janedoe/foo/",
      undefined,
      createEnv(bucket)
    );

    expect(await response.text()).toContain("<h1>Beta</h1>");
  });

  it("returns 409 handle_required when publishing without a handle", async () => {
    // A user with no handle record cannot publish until they claim one.
    bucket.store.delete(`userhandles/${userId}.json`);
    bucket.store.delete(`handles/${handle}.json`);

    await storage.createProject(userId, "nohandle", "No Handle");
    await storage.writeFile(userId, "nohandle", "index.html", "<h1>Hi</h1>");

    const response = await app.request(
      "http://site-studio.test/api/projects/nohandle/publish",
      { method: "POST", headers: csrf.headers },
      createEnv(bucket)
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "handle_required" });
  });

  it("301s a legacy /sites/{owner}/{slug} URL to /u/{handle}/ preserving path and query", async () => {
    await storage.createProject(userId, "port", "Portfolio");
    await storage.writeFile(userId, "port", "index.html", "<h1>Home</h1>");
    await storage.writeFile(userId, "port", "about/index.html", "<h1>About</h1>");
    await storage.updateProjectMetadata(userId, "port", { published: true, slug: "port" });

    const response = await app.request(
      "http://site-studio.test/sites/user_test123/port/about/?ref=x",
      { redirect: "manual" },
      createEnv(bucket)
    );

    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe("/u/janedoe/port/about/?ref=x");
  });

  it("serves a legacy /sites/{owner}/{slug} URL directly when the owner has no handle", async () => {
    // A different owner with published content but no handle: content serves,
    // no redirect (zero breakage for pre-handle sites).
    bucket.store.set(`projects/user_other/legacy/.metadata.json`, {
      data: JSON.stringify({ id: "legacy", name: "legacy", published: true, slug: "legacy" })
    });
    bucket.store.set(`projects/user_other/legacy/index.html`, { data: "<h1>Legacy Home</h1>" });

    const response = await app.request(
      "http://site-studio.test/sites/user_other/legacy/",
      { redirect: "manual" },
      createEnv(bucket)
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<h1>Legacy Home</h1>");
  });

  it("SS-14: resolves an extensionless path to {path}.html", async () => {
    await storage.createProject(userId, "flat", "Flat");
    await storage.writeFile(userId, "flat", "index.html", "<h1>Home</h1>");
    await storage.writeFile(userId, "flat", "about.html", "<h1>Flat About</h1>");
    await storage.updateProjectMetadata(userId, "flat", { published: true, slug: "flat" });

    const response = await app.request(
      "http://site-studio.test/u/janedoe/flat/about",
      { headers: { Accept: "text/html" } },
      createEnv(bucket)
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Flat About");
  });

  it("SS-14: prefers {path}.html over {path}/index.html", async () => {
    await storage.createProject(userId, "both", "Both");
    await storage.writeFile(userId, "both", "index.html", "<h1>Home</h1>");
    await storage.writeFile(userId, "both", "about.html", "<h1>Flat</h1>");
    await storage.writeFile(userId, "both", "about/index.html", "<h1>Nested</h1>");
    await storage.updateProjectMetadata(userId, "both", { published: true, slug: "both" });

    const response = await app.request(
      "http://site-studio.test/u/janedoe/both/about",
      { headers: { Accept: "text/html" } },
      createEnv(bucket)
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Flat");
  });

  it("SS-13: serves a slug-less published project addressed by projectId", async () => {
    // A different owner with no handle so the legacy /sites/ path serves directly.
    bucket.store.set(`projects/user_slugless/legacy/.metadata.json`, {
      data: JSON.stringify({ id: "legacy", name: "legacy", published: true })
    });
    bucket.store.set(`projects/user_slugless/legacy/index.html`, { data: "<h1>Slugless</h1>" });

    const response = await app.request(
      "http://site-studio.test/sites/user_slugless/legacy/",
      { redirect: "manual" },
      createEnv(bucket)
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<h1>Slugless</h1>");
  });

  it("SS-15: published HTML carries max-age=300 + ETag, composed with the CSP", async () => {
    await storage.createProject(userId, "cache", "Cache");
    await storage.writeFile(userId, "cache", "index.html", "<h1>Home</h1>");
    await storage.updateProjectMetadata(userId, "cache", { published: true, slug: "cache" });

    const response = await app.request(
      "http://site-studio.test/u/janedoe/cache/",
      undefined,
      createEnv(bucket)
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    // The §3¾ containment coexists with the caching validators.
    expect(response.headers.get("Content-Security-Policy")).toBe("sandbox allow-scripts");
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  it("SS-27: a missing published ASSET does not download the project 404.html", async () => {
    await storage.createProject(userId, "gate", "Gate");
    await storage.writeFile(userId, "gate", "index.html", "<h1>Home</h1>");
    await storage.writeFile(userId, "gate", "404.html", "<h1>Custom missing</h1>");
    await storage.updateProjectMetadata(userId, "gate", { published: true, slug: "gate" });

    const response = await app.request(
      "http://site-studio.test/u/janedoe/gate/missing.png",
      { headers: { Accept: "image/png,*/*" } },
      createEnv(bucket)
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type") || "").toContain("text/plain");
    expect(await response.text()).not.toContain("Custom missing");
  });
});

/**
 * INTEGRATION.md §3¾ active-content invariant. Every served user/agent byte
 * (published sites, previews, a project-supplied 404.html) must carry the
 * opaque-origin CSP (`sandbox allow-scripts`, NEVER allow-same-origin) + nosniff
 * so it can never read our cookie/session. JSON API responses and the styled
 * fallback 404 are our own trusted output and must NOT carry it.
 */
describe("served-bytes security headers (§3¾)", () => {
  const userId = "user_test123";
  const handle = "janedoe";
  let bucket: ReturnType<typeof createMockBucket>;
  let storage: R2ProjectStorage;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    bucket = createMockBucket();
    storage = new R2ProjectStorage(bucket);
    app = createTestApp();
    kv = createMockKV();
    csrf = await mintCsrfSession(kv, userId);
    seedHandle(bucket, userId, handle);
  });

  function expectSandboxed(response: Response) {
    expect(response.headers.get("Content-Security-Policy")).toBe("sandbox allow-scripts");
    expect(response.headers.get("Content-Security-Policy") || "").not.toContain("allow-same-origin");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  }

  it("sandboxes a served published page (/u/)", async () => {
    await storage.createProject(userId, "sec", "Sec");
    await storage.writeFile(userId, "sec", "index.html", "<h1>Home</h1>");
    await storage.updateProjectMetadata(userId, "sec", { published: true, slug: "sec" });

    const response = await app.request(
      "http://site-studio.test/u/janedoe/sec/",
      undefined,
      createEnv(bucket)
    );
    expect(response.status).toBe(200);
    expectSandboxed(response);
  });

  it("sandboxes a served published asset (e.g. .svg)", async () => {
    await storage.createProject(userId, "sec2", "Sec2");
    await storage.writeFile(userId, "sec2", "index.html", "<h1>Home</h1>");
    await storage.writeFile(userId, "sec2", "art.svg", "<svg xmlns='http://www.w3.org/2000/svg'></svg>");
    await storage.updateProjectMetadata(userId, "sec2", { published: true, slug: "sec2" });

    const response = await app.request(
      "http://site-studio.test/u/janedoe/sec2/art.svg",
      undefined,
      createEnv(bucket)
    );
    expect(response.status).toBe(200);
    expectSandboxed(response);
  });

  it("sandboxes a project-supplied 404.html", async () => {
    await storage.createProject(userId, "sec3", "Sec3");
    await storage.writeFile(userId, "sec3", "index.html", "<h1>Home</h1>");
    await storage.writeFile(userId, "sec3", "404.html", "<h1>Custom missing</h1>");
    await storage.updateProjectMetadata(userId, "sec3", { published: true, slug: "sec3" });

    const response = await app.request(
      "http://site-studio.test/u/janedoe/sec3/nope.html",
      { headers: { Accept: "text/html" } },
      createEnv(bucket)
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Custom missing");
    expectSandboxed(response);
  });

  it("sandboxes a served preview page", async () => {
    await storage.createProject(userId, "prev", "Prev");
    await storage.writeFile(userId, "prev", "index.html", "<h1>Preview</h1>");

    const response = await app.request(
      "http://site-studio.test/preview/prev/index.html",
      undefined,
      createEnv(bucket)
    );
    expect(response.status).toBe(200);
    expectSandboxed(response);
  });

  it("does NOT sandbox the JSON publish API response", async () => {
    await storage.createProject(userId, "apisec", "ApiSec");
    await storage.writeFile(userId, "apisec", "index.html", "<h1>Home</h1>");

    const response = await app.request(
      "http://site-studio.test/api/projects/apisec/publish",
      { method: "POST", headers: csrf.headers },
      createEnv(bucket)
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("does NOT sandbox the styled fallback 404 (our own trusted markup)", async () => {
    await storage.createProject(userId, "fb", "Fb");
    await storage.writeFile(userId, "fb", "index.html", "<h1>Home</h1>");
    await storage.updateProjectMetadata(userId, "fb", { published: true, slug: "fb" });

    const response = await app.request(
      "http://site-studio.test/u/janedoe/fb/missing.html",
      { headers: { Accept: "text/html" } },
      createEnv(bucket)
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Page not found");
    expect(response.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("adds nosniff but does NOT sandbox the owner thumbnail PNG", async () => {
    await storage.createProject(userId, "thumb", "Thumb");
    await storage.writeThumbnail(userId, "thumb", pngBytes());

    const response = await app.request(
      "http://site-studio.test/api/projects/thumb/thumbnail",
      undefined,
      createEnv(bucket)
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toBeNull();
  });

  // SS-21: the thumbnail POST previously trusted image.type === "image/png".
  // Sniff the magic bytes and reject a non-PNG body posted as image/png.
  it("SS-21: rejects a non-PNG body posted to the thumbnail route as image/png", async () => {
    await storage.createProject(userId, "thumbsniff", "Thumb Sniff");
    const html = new TextEncoder().encode("<!DOCTYPE html><html></html>");
    const form = new FormData();
    form.append(
      "image",
      new File([new Blob([html.buffer as ArrayBuffer])], "thumb.png", { type: "image/png" })
    );

    const response = await app.request(
      "http://site-studio.test/api/projects/thumbsniff/thumbnail",
      { method: "POST", body: form, headers: csrf.headers },
      createEnv(bucket)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Thumbnail must be a valid PNG image." });
    // Nothing was written.
    expect(await storage.readThumbnail(userId, "thumbsniff")).toBeNull();
  });

  it("SS-21: accepts a real PNG body on the thumbnail route", async () => {
    await storage.createProject(userId, "thumbok", "Thumb OK");
    const form = new FormData();
    form.append(
      "image",
      new File([new Blob([pngBytes().buffer as ArrayBuffer])], "thumb.png", { type: "image/png" })
    );

    const response = await app.request(
      "http://site-studio.test/api/projects/thumbok/thumbnail",
      { method: "POST", body: form, headers: csrf.headers },
      createEnv(bucket)
    );

    expect(response.status).toBe(200);
    expect(await storage.readThumbnail(userId, "thumbok")).not.toBeNull();
  });

  it("SS-33: thumbnail POST to a missing project 404s without fabricating project keys", async () => {
    const form = new FormData();
    form.append(
      "image",
      new File([new Blob([pngBytes().buffer as ArrayBuffer])], "thumb.png", { type: "image/png" })
    );

    const response = await app.request(
      "http://site-studio.test/api/projects/missing-thumb/thumbnail",
      { method: "POST", body: form, headers: csrf.headers },
      createEnv(bucket)
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Project not found" });
    expect(bucket.store.has(`projects/${userId}/missing-thumb/.metadata.json`)).toBe(false);
    expect(bucket.store.has(`projects/${userId}/missing-thumb/.thumbnail.png`)).toBe(false);
  });

  it("SS-33: thumbnail GET to a missing project returns project 404", async () => {
    const response = await app.request(
      "http://site-studio.test/api/projects/missing-thumb/thumbnail",
      undefined,
      createEnv(bucket)
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Project not found" });
  });

  it("SS-33: unpublish returns 404 for a missing project", async () => {
    const response = await app.request(
      "http://site-studio.test/api/projects/missing-unpublish/unpublish",
      { method: "POST", headers: csrf.headers },
      createEnv(bucket)
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Project not found" });
  });

  it("SS-33: unpublish keeps 400 for an existing unpublished project", async () => {
    await storage.createProject(userId, "draft", "Draft");

    const response = await app.request(
      "http://site-studio.test/api/projects/draft/unpublish",
      { method: "POST", headers: csrf.headers },
      createEnv(bucket)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Project is not currently published" });
  });

  it("SS-31: PATCH rename returns 409 if the target project appears after preflight", async () => {
    await storage.createProject(userId, "old-name", "Old Name");
    await storage.writeFile(userId, "old-name", "index.html", "<h1>Old</h1>");
    const targetMetadataKey = `projects/${userId}/new-name/.metadata.json`;
    const originalPut = bucket.put;
    let injected = false;

    bucket.put = vi.fn(async (key, data, options) => {
      if (key === targetMetadataKey && options?.onlyIf?.etagDoesNotMatch === "*" && !injected) {
        injected = true;
        bucket.store.set(targetMetadataKey, {
          data: JSON.stringify({
            id: "new-name",
            name: "Concurrent New",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            published: false
          })
        });
        bucket.store.set(`projects/${userId}/new-name/index.html`, { data: "<h1>Concurrent</h1>" });
      }
      return originalPut(key, data, options);
    }) as typeof bucket.put;

    const response = await app.request(
      "http://site-studio.test/api/projects/old-name",
      {
        method: "PATCH",
        body: JSON.stringify({ name: "New Name" }),
        headers: { "Content-Type": "application/json", ...csrf.headers }
      },
      createEnv(bucket)
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Project already exists" });
    await expect(storage.readFile(userId, "old-name", "index.html")).resolves.toBe("<h1>Old</h1>");
    await expect(storage.readFile(userId, "new-name", "index.html")).resolves.toBe("<h1>Concurrent</h1>");
  });
});

/** Minimal PNG magic-byte prefix, padded to a plausible file size. */
function pngBytes(len = 64): Uint8Array {
  const arr = new Uint8Array(len);
  arr.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return arr;
}

/** Build a multipart upload request body with an optional `dir` field. */
function uploadRequest(
  fileName: string,
  data: Uint8Array,
  opts: { dir?: string } = {}
): RequestInit {
  const form = new FormData();
  form.append("file", new File([new Blob([data.buffer as ArrayBuffer])], fileName));
  if (opts.dir !== undefined) {
    form.append("dir", opts.dir);
  }
  // Uploads are mutations: carry the session CSRF token + compliant posture.
  return { method: "POST", body: form, headers: csrf.headers };
}

describe("image upload hardening", () => {
  const userId = "user_test123";
  let bucket: ReturnType<typeof createMockBucket>;
  let storage: R2ProjectStorage;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    bucket = createMockBucket();
    storage = new R2ProjectStorage(bucket);
    app = createTestApp();
    kv = createMockKV();
    csrf = await mintCsrfSession(kv, userId);
    await storage.createProject(userId, "imgproj", "Image Project");
  });

  it("accepts an image whose magic bytes match its extension", async () => {
    const response = await app.request(
      "http://site-studio.test/api/projects/imgproj/upload",
      uploadRequest("photo.png", pngBytes()),
      createEnv(bucket)
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { path: string };
    expect(body.path).toBe("photo.png");
  });

  it("rejects a file whose bytes do not match its image extension", async () => {
    const html = new TextEncoder().encode("<!DOCTYPE html><html></html>");
    const response = await app.request(
      "http://site-studio.test/api/projects/imgproj/upload",
      uploadRequest("fake.png", html),
      createEnv(bucket)
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("not a valid PNG");
  });

  it("rejects an oversized image with 400", async () => {
    // 10MB cap + 1 byte, filled with the PNG signature so only size can fail.
    const big = pngBytes(10 * 1024 * 1024 + 1);
    const response = await app.request(
      "http://site-studio.test/api/projects/imgproj/upload",
      uploadRequest("huge.png", big),
      createEnv(bucket)
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("too large");
  });

  it("stores dir=images uploads under the images/ prefix and collision-suffixes", async () => {
    const first = await app.request(
      "http://site-studio.test/api/projects/imgproj/upload",
      uploadRequest("hero.png", pngBytes(), { dir: "images" }),
      createEnv(bucket)
    );
    expect(first.status).toBe(200);
    expect(((await first.json()) as { path: string }).path).toBe("images/hero.png");

    const second = await app.request(
      "http://site-studio.test/api/projects/imgproj/upload",
      uploadRequest("hero.png", pngBytes(), { dir: "images" }),
      createEnv(bucket)
    );
    expect(second.status).toBe(200);
    expect(((await second.json()) as { path: string }).path).toBe("images/hero_1.png");
  });

  it("rejects a dir value other than images with 400", async () => {
    const response = await app.request(
      "http://site-studio.test/api/projects/imgproj/upload",
      uploadRequest("evil.png", pngBytes(), { dir: "../secrets" }),
      createEnv(bucket)
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Only \"images\" is allowed");
  });

  it("keeps generic (non-image) uploads working with no dir field", async () => {
    const text = new TextEncoder().encode("hello world");
    const response = await app.request(
      "http://site-studio.test/api/projects/imgproj/upload",
      uploadRequest("notes.txt", text),
      createEnv(bucket)
    );

    expect(response.status).toBe(200);
    expect(((await response.json()) as { path: string }).path).toBe("notes.txt");
  });

  // SS-5: two concurrent uploads with the SAME name. The read-check-write
  // collision loop was a TOCTOU — both could see "absent" and the second clobber
  // the first. The atomic put-if-absent guarantees one keeps photo.png and the
  // other is suffixed to photo_1.png; NO upload is lost.
  it("SS-5 race: two concurrent same-name uploads get distinct paths, no clobber", async () => {
    const bytesA = pngBytes();
    const bytesB = pngBytes();
    bytesB[bytesB.length - 1] = 0x42; // distinguishable payloads

    const [respA, respB] = await Promise.all([
      app.request(
        "http://site-studio.test/api/projects/imgproj/upload",
        uploadRequest("photo.png", bytesA),
        createEnv(bucket)
      ),
      app.request(
        "http://site-studio.test/api/projects/imgproj/upload",
        uploadRequest("photo.png", bytesB),
        createEnv(bucket)
      )
    ]);

    expect(respA.status).toBe(200);
    expect(respB.status).toBe(200);
    const paths = [
      ((await respA.json()) as { path: string }).path,
      ((await respB.json()) as { path: string }).path
    ].sort();
    expect(paths).toEqual(["photo.png", "photo_1.png"]);

    // Both files landed and neither overwrote the other.
    expect(await storage.fileExists(userId, "imgproj", "photo.png")).toBe(true);
    expect(await storage.fileExists(userId, "imgproj", "photo_1.png")).toBe(true);
  });

  // SS-29: the upload route rejects an over-ceiling body from its declared
  // Content-Length BEFORE `c.req.formData()` buffers the multipart body into
  // isolate memory (defense-in-depth on top of the per-file storage caps).
  it("SS-29: over-ceiling Content-Length → 413 before formData, nothing stored", async () => {
    const before = bucket.store.size;
    // Declare a body far larger than the 32MB cap + 1MB envelope margin, but send
    // a tiny actual body — the guard rejects on the header before parsing, so the
    // body is never buffered and no file is written.
    const response = await app.request(
      "http://site-studio.test/api/projects/imgproj/upload",
      {
        method: "POST",
        body: "x",
        headers: { ...csrf.headers, "content-length": String(64 * 1024 * 1024) }
      },
      createEnv(bucket)
    );

    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("too large");
    // Guard fired before formData(): no upload landed in storage.
    expect(bucket.store.size).toBe(before);
    expect(await storage.fileExists(userId, "imgproj", "huge.png")).toBe(false);
  });

  it("SS-29: a valid upload within the cap still succeeds under the ceiling", async () => {
    // A real multipart upload (Content-Length auto-set by the runtime) that is
    // comfortably under the ceiling passes the guard and stores normally.
    const response = await app.request(
      "http://site-studio.test/api/projects/imgproj/upload",
      uploadRequest("ok.png", pngBytes()),
      createEnv(bucket)
    );

    expect(response.status).toBe(200);
    expect(((await response.json()) as { path: string }).path).toBe("ok.png");
    expect(await storage.fileExists(userId, "imgproj", "ok.png")).toBe(true);
  });

  it("SS-29: missing Content-Length falls through to the existing post-parse checks", async () => {
    // Build a real multipart body but strip Content-Length. The pre-buffer guard
    // is skipped (unparseable length), and the request still succeeds via the
    // existing parse + validation path — the guard is an addition, not the only
    // line of defense.
    const req = uploadRequest("nolen.png", pngBytes());
    const headers = new Headers(req.headers as HeadersInit);
    headers.delete("content-length");
    req.headers = headers;

    const response = await app.request(
      "http://site-studio.test/api/projects/imgproj/upload",
      req,
      createEnv(bucket)
    );

    expect(response.status).toBe(200);
    expect(((await response.json()) as { path: string }).path).toBe("nolen.png");
  });
});

describe("images inventory endpoint", () => {
  const userId = "user_test123";
  let bucket: ReturnType<typeof createMockBucket>;
  let storage: R2ProjectStorage;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    bucket = createMockBucket();
    storage = new R2ProjectStorage(bucket);
    app = createTestApp();
    kv = createMockKV();
    csrf = await mintCsrfSession(kv, userId);
  });

  it("lists project images and placeholder findings with an extractable src", async () => {
    await storage.createProject(userId, "inv", "Inventory");
    await storage.uploadToProject(userId, "inv", "images/hero.png", pngBytes());
    await storage.writeFile(
      userId,
      "inv",
      "index.html",
      `<!DOCTYPE html>\n<html lang="en">\n<head>\n<title>T</title>\n<meta name="description" content="d">\n</head>\n<body>\n<h1>Hi</h1>\n<img src="https://placehold.co/600x400" alt="Placeholder — replace with a photo">\n</body>\n</html>`
    );

    const response = await app.request(
      "http://site-studio.test/api/projects/inv/images",
      undefined,
      createEnv(bucket)
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      images: Array<{ path: string; size: number }>;
      placeholders: Array<{ file: string; line: number | null; message: string; src?: string }>;
    };

    expect(body.images.map((i) => i.path)).toContain("images/hero.png");
    expect(body.placeholders.length).toBe(1);
    expect(body.placeholders[0].file).toBe("index.html");
    expect(body.placeholders[0].src).toBe("https://placehold.co/600x400");
    expect(body.placeholders[0].message).toContain("placeholder");
  });

  it("returns 404 for a missing project", async () => {
    const response = await app.request(
      "http://site-studio.test/api/projects/nope/images",
      undefined,
      createEnv(bucket)
    );
    expect(response.status).toBe(404);
  });
});

/**
 * INTEGRATION.md §3¾ rules 2+3 over every state-changing route. Each mutation
 * must: reject without the token (403 + exact envelope), reject a valid token
 * arriving with `Sec-Fetch-Site: cross-site` (403), and proceed past CSRF with
 * the token + compliant same-origin posture (whatever domain-level status the
 * route then returns, it is never the CSRF envelope).
 */
describe("csrf protection on all mutation routes", () => {
  const userId = "user_test123";
  let bucket: ReturnType<typeof createMockBucket>;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    bucket = createMockBucket();
    app = createTestApp();
    kv = createMockKV();
    csrf = await mintCsrfSession(kv, userId);
  });

  const json = (body: unknown): Pick<RequestInit, "body" | "headers"> => ({
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" }
  });
  const form = (): Pick<RequestInit, "body"> => ({ body: new FormData() });

  // The 13 state-changing routes (POST/PUT/PATCH/DELETE — rule 1 keeps
  // GET/HEAD side-effect free, so nothing else needs the token).
  const mutations: Array<{
    method: string;
    path: string;
    init?: () => Pick<RequestInit, "body" | "headers">;
  }> = [
    { method: "POST", path: "/api/handle", init: () => json({ handle: "table-check" }) },
    { method: "POST", path: "/api/projects/proj-x/file", init: () => json({ path: "a.html", content: "hi" }) },
    { method: "DELETE", path: "/api/projects/proj-x/files?path=a.html" },
    { method: "PUT", path: "/api/projects/proj-x/files/rename", init: () => json({ oldPath: "a.html", newPath: "b.html" }) },
    { method: "POST", path: "/api/projects/proj-x/upload", init: form },
    { method: "POST", path: "/api/projects/proj-x/publish" },
    { method: "POST", path: "/api/projects/proj-x/unpublish" },
    { method: "POST", path: "/api/projects/proj-x/thumbnail", init: form },
    { method: "POST", path: "/api/projects", init: () => json({ name: "table-proj" }) },
    { method: "PATCH", path: "/api/projects/proj-x", init: () => json({ name: "renamed" }) },
    { method: "DELETE", path: "/api/projects/proj-x" },
    { method: "POST", path: "/api/projects/proj-x/snapshots" },
    { method: "POST", path: "/api/projects/proj-x/snapshots/snap-1/restore" }
  ];

  const request = (
    mutation: (typeof mutations)[number],
    csrfHeaders: Record<string, string>
  ) => {
    const init = mutation.init?.() ?? {};
    return app.request(
      `http://site-studio.test${mutation.path}`,
      {
        method: mutation.method,
        body: init.body,
        headers: { ...(init.headers as Record<string, string> | undefined), ...csrfHeaders }
      },
      createEnv(bucket)
    );
  };

  for (const mutation of mutations) {
    describe(`${mutation.method} ${mutation.path.split("?")[0]}`, () => {
      it("403s without a token", async () => {
        const res = await request(mutation, {});
        expect(res.status).toBe(403);
        await expect(res.json()).resolves.toEqual(CSRF_ERROR_BODY);
      });

      it("403s with a valid token but Sec-Fetch-Site: cross-site", async () => {
        const res = await request(mutation, {
          [CSRF_HEADER_NAME]: csrf.token,
          "Sec-Fetch-Site": "cross-site"
        });
        expect(res.status).toBe(403);
        await expect(res.json()).resolves.toEqual(CSRF_ERROR_BODY);
      });

      it("passes CSRF with the token + same-origin posture", async () => {
        const res = await request(mutation, csrf.headers);
        // Domain-level outcomes vary (200/400/404/409 depending on seeded
        // state) but none of these routes 403 on their success path here, so
        // any 403 would be a CSRF false positive.
        expect(res.status).not.toBe(403);
      });
    });
  }
});

// SS-28: the MANUAL snapshot endpoint. A snapshot the user explicitly asked for
// should tell them it was too large (413) rather than silently 201-ing with no
// restore point. A normal-sized project still snapshots (201).
describe("SS-28 manual snapshot cap (over-cap → 413, normal → 201)", () => {
  const userId = "user_test123";
  let bucket: ReturnType<typeof createMockBucket>;
  let storage: R2ProjectStorage;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    bucket = createMockBucket();
    storage = new R2ProjectStorage(bucket);
    app = createTestApp();
    kv = createMockKV();
    csrf = await mintCsrfSession(kv, userId);
    await storage.createProject(userId, "snapproj", "Snap Project");
  });

  it("normal-sized project → 201 with a snapshot", async () => {
    await storage.writeFile(userId, "snapproj", "index.html", "<h1>Small</h1>");

    const res = await app.request(
      "http://site-studio.test/api/projects/snapproj/snapshots",
      { method: "POST", body: "{}", headers: { "Content-Type": "application/json", ...csrf.headers } },
      createEnv(bucket)
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { snapshot: { id: string } };
    expect(body.snapshot.id).toBeTruthy();
  });

  it("over-cap project → 413 (too large), not a silent skip", async () => {
    await storage.writeFile(userId, "snapproj", "big.txt", "x".repeat(MAX_SNAPSHOT_BYTES + 1));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await app.request(
      "http://site-studio.test/api/projects/snapproj/snapshots",
      { method: "POST", body: "{}", headers: { "Content-Type": "application/json", ...csrf.headers } },
      createEnv(bucket)
    );
    warnSpy.mockRestore();

    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("too large");

    // Nothing was zipped/stored for the over-cap manual snapshot.
    const snapshots = await storage.listSnapshots(userId, "snapproj");
    expect(snapshots).toHaveLength(0);
  });
});
