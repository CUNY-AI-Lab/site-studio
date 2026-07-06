import { describe, it, expect, beforeEach, vi } from "vitest";
import worker, {
  sanitizeFilePath,
  fileKey,
  getContentType,
  parsePublishedRequest,
  loadMigrationPointer,
  findPublishedProject,
  siteRootPath,
  looksLikePageNavigation,
  type Env
} from "./index";

/**
 * Minimal in-memory R2 bucket, mirroring the mock in
 * packages/app/src/storage/r2.test.ts but returning the extra fields the
 * publisher reads from an object body (`body`, `etag`, `uploaded`).
 */
function createMockBucket() {
  const store = new Map<string, { data: ArrayBuffer | string; httpMetadata?: unknown }>();

  const makeObject = (key: string, entry: { data: ArrayBuffer | string; httpMetadata?: unknown }) => {
    const data = entry.data;
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
    return {
      key,
      size: bytes.byteLength,
      etag: `etag-${key}`,
      uploaded: new Date("2026-01-01T00:00:00.000Z"),
      httpMetadata: entry.httpMetadata || {},
      body: new Blob([bytes]),
      text: async () => (typeof data === "string" ? data : new TextDecoder().decode(data)),
      arrayBuffer: async () =>
        typeof data === "string" ? new TextEncoder().encode(data).buffer : data
    };
  };

  return {
    store,
    head: vi.fn(async (key: string) => (store.has(key) ? { key, size: 0 } : null)),
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      return entry ? makeObject(key, entry) : null;
    }),
    put: vi.fn(async (key: string, data: string, options?: { httpMetadata?: unknown }) => {
      store.set(key, { data, httpMetadata: options?.httpMetadata });
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(
      async ({ prefix, delimiter }: { prefix?: string; delimiter?: string; cursor?: string } = {}) => {
        const objects: Array<{ key: string; size: number; uploaded: Date }> = [];
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

          objects.push({ key, size: 0, uploaded: new Date() });
        }

        return { objects, truncated: false, delimitedPrefixes };
      }
    )
  } as unknown as R2Bucket & { store: Map<string, { data: ArrayBuffer | string; httpMetadata?: unknown }> };
}

function createEnv(bucket: R2Bucket): Env {
  return { SITE_STUDIO_BUCKET: bucket };
}

/** Seed a published project with the given files (relative paths). */
function publishProject(
  bucket: ReturnType<typeof createMockBucket>,
  userId: string,
  projectId: string,
  files: Record<string, string>,
  metadata: Record<string, unknown> = {}
) {
  bucket.store.set(`projects/${userId}/${projectId}/.metadata.json`, {
    data: JSON.stringify({
      id: projectId,
      name: projectId,
      published: true,
      slug: projectId,
      publishedAt: "2026-01-01T00:00:00.000Z",
      ...metadata
    })
  });
  for (const [path, content] of Object.entries(files)) {
    bucket.store.set(`projects/${userId}/${projectId}/${path}`, { data: content });
  }
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

function navRequest(url: string): Request {
  return new Request(url, { headers: { Accept: "text/html" } });
}

function assetRequest(url: string): Request {
  return new Request(url, { headers: { Accept: "image/png,*/*" } });
}

describe("sanitizeFilePath", () => {
  it("normalizes leading slashes, backslashes, and duplicate separators", () => {
    expect(sanitizeFilePath("/foo//bar")).toBe("foo/bar");
    expect(sanitizeFilePath("foo\\bar")).toBe("foo/bar");
  });

  it("rejects empty paths", () => {
    expect(() => sanitizeFilePath("   ")).toThrow("File path is required");
  });

  it("rejects path traversal and null bytes", () => {
    expect(() => sanitizeFilePath("../secret")).toThrow("Invalid file path");
    expect(() => sanitizeFilePath("foo/../bar")).toThrow("Invalid file path");
    expect(() => sanitizeFilePath("foo\0bar")).toThrow("Invalid file path");
  });

  it("is applied when building R2 file keys", () => {
    expect(fileKey("u", "p", "/a//b")).toBe("projects/u/p/a/b");
    expect(() => fileKey("u", "p", "../../etc")).toThrow("Invalid file path");
  });
});

describe("getContentType", () => {
  it("maps known extensions", () => {
    expect(getContentType("index.html")).toBe("text/html; charset=utf-8");
    expect(getContentType("styles.CSS")).toBe("text/css; charset=utf-8");
    expect(getContentType("app.js")).toBe("application/javascript; charset=utf-8");
    expect(getContentType("logo.png")).toBe("image/png");
    expect(getContentType("photo.jpeg")).toBe("image/jpeg");
  });

  it("falls back to octet-stream for unknown or missing extensions", () => {
    expect(getContentType("data.bin")).toBe("application/octet-stream");
    expect(getContentType("README")).toBe("application/octet-stream");
  });
});

describe("parsePublishedRequest", () => {
  it("parses legacy /sites/:userId/:slug/* URLs", () => {
    expect(parsePublishedRequest(new URL("https://x.test/sites/u/blog/posts/a.html"))).toEqual({
      kind: "legacy",
      userId: "u",
      slug: "blog",
      filePath: "posts/a.html"
    });
  });

  it("defaults to index.html when no file path is given", () => {
    expect(parsePublishedRequest(new URL("https://x.test/sites/u/blog"))).toEqual({
      kind: "legacy",
      userId: "u",
      slug: "blog",
      filePath: "index.html"
    });
  });

  it("parses canonical /u/:handle/:slug/* URLs", () => {
    expect(parsePublishedRequest(new URL("https://x.test/u/jane/blog/style.css"))).toEqual({
      kind: "handle",
      handle: "jane",
      slug: "blog",
      filePath: "style.css"
    });
  });

  it("supports the bare /:userId/:slug legacy shape", () => {
    expect(parsePublishedRequest(new URL("https://x.test/owner/blog/style.css"))).toEqual({
      kind: "legacy",
      userId: "owner",
      slug: "blog",
      filePath: "style.css"
    });
  });

  it("returns null for URLs without enough path segments", () => {
    expect(parsePublishedRequest(new URL("https://x.test/"))).toBeNull();
    expect(parsePublishedRequest(new URL("https://x.test/onlyone"))).toBeNull();
  });
});

describe("looksLikePageNavigation", () => {
  it("treats Accept: text/html as a navigation", () => {
    expect(looksLikePageNavigation(navRequest("https://x.test/a"), "some.css")).toBe(true);
  });

  it("treats trailing-slash and .html paths as navigations", () => {
    const req = new Request("https://x.test/a");
    expect(looksLikePageNavigation(req, "")).toBe(true);
    expect(looksLikePageNavigation(req, "docs/")).toBe(true);
    expect(looksLikePageNavigation(req, "about.html")).toBe(true);
  });

  it("treats asset requests as non-navigations", () => {
    expect(looksLikePageNavigation(assetRequest("https://x.test/logo.png"), "logo.png")).toBe(false);
  });
});

describe("siteRootPath", () => {
  it("builds the /sites root when both parts are known", () => {
    expect(siteRootPath("u", "blog")).toBe("/sites/u/blog/");
  });

  it("returns undefined when a part is missing", () => {
    expect(siteRootPath(undefined, "blog")).toBeUndefined();
    expect(siteRootPath("u", undefined)).toBeUndefined();
  });
});

describe("findPublishedProject", () => {
  let bucket: ReturnType<typeof createMockBucket>;

  beforeEach(() => {
    bucket = createMockBucket();
  });

  it("resolves a project by slug", async () => {
    publishProject(bucket, "u", "my-site", { "index.html": "hi" }, { slug: "cool" });
    const resolved = await findPublishedProject(bucket, "u", "cool");
    expect(resolved?.projectId).toBe("my-site");
  });

  it("matches slug-less projects by project id", async () => {
    publishProject(bucket, "u", "legacy", { "index.html": "hi" }, { slug: undefined });
    const resolved = await findPublishedProject(bucket, "u", "legacy");
    expect(resolved?.projectId).toBe("legacy");
  });

  it("ignores unpublished projects", async () => {
    publishProject(bucket, "u", "draft", { "index.html": "hi" }, { published: false, slug: "draft" });
    expect(await findPublishedProject(bucket, "u", "draft")).toBeNull();
  });

  it("prefers the most recently published project on duplicate slugs", async () => {
    publishProject(bucket, "u", "old", { "index.html": "OLD" }, {
      slug: "dup",
      publishedAt: "2026-01-01T00:00:00.000Z"
    });
    publishProject(bucket, "u", "new", { "index.html": "NEW" }, {
      slug: "dup",
      publishedAt: "2026-06-01T00:00:00.000Z"
    });

    const resolved = await findPublishedProject(bucket, "u", "dup");
    expect(resolved?.projectId).toBe("new");
  });
});

describe("loadMigrationPointer", () => {
  let bucket: ReturnType<typeof createMockBucket>;

  beforeEach(() => {
    bucket = createMockBucket();
  });

  it("returns null when no pointer exists", async () => {
    expect(await loadMigrationPointer(bucket, "anon")).toBeNull();
  });

  it("loads a valid v1 pointer", async () => {
    bucket.store.set("projects/anon/.migrated.json", {
      data: JSON.stringify({ version: 1, subject: "subj", slugs: { old: "new" } })
    });
    const pointer = await loadMigrationPointer(bucket, "anon");
    expect(pointer?.subject).toBe("subj");
    expect(pointer?.slugs?.old).toBe("new");
  });

  it("rejects malformed or wrong-version pointers", async () => {
    bucket.store.set("projects/bad-json/.migrated.json", { data: "{not json" });
    expect(await loadMigrationPointer(bucket, "bad-json")).toBeNull();

    bucket.store.set("projects/bad-version/.migrated.json", {
      data: JSON.stringify({ version: 2, subject: "subj" })
    });
    expect(await loadMigrationPointer(bucket, "bad-version")).toBeNull();
  });
});

describe("worker.fetch (integration)", () => {
  let bucket: ReturnType<typeof createMockBucket>;

  beforeEach(() => {
    bucket = createMockBucket();
  });

  it("serves index.html for a published site root", async () => {
    publishProject(bucket, "u", "blog", { "index.html": "<h1>Home</h1>" });
    const res = await worker.fetch(navRequest("https://x.test/sites/u/blog/"), createEnv(bucket));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toContain("<h1>Home</h1>");
  });

  it("resolves a directory path to its index.html", async () => {
    publishProject(bucket, "u", "blog", {
      "index.html": "<h1>Home</h1>",
      "docs/index.html": "<h1>Docs</h1>"
    });
    const res = await worker.fetch(navRequest("https://x.test/sites/u/blog/docs"), createEnv(bucket));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<h1>Docs</h1>");
  });

  it("resolves an extensionless path to <path>.html", async () => {
    publishProject(bucket, "u", "blog", {
      "index.html": "<h1>Home</h1>",
      "about.html": "<h1>About</h1>"
    });
    const res = await worker.fetch(navRequest("https://x.test/sites/u/blog/about"), createEnv(bucket));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<h1>About</h1>");
  });

  it("maps content types for served assets", async () => {
    publishProject(bucket, "u", "blog", {
      "index.html": "<h1>Home</h1>",
      "styles.css": "body{}"
    });
    const res = await worker.fetch(
      assetRequest("https://x.test/sites/u/blog/styles.css"),
      createEnv(bucket)
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
  });

  it("follows a migration pointer for a re-homed anonymous owner", async () => {
    publishProject(bucket, "subj", "blog", { "index.html": "<h1>Migrated</h1>" }, { slug: "newslug" });
    bucket.store.set("projects/user_anon/.migrated.json", {
      data: JSON.stringify({ version: 1, subject: "subj", slugs: { oldslug: "newslug" } })
    });

    const res = await worker.fetch(
      navRequest("https://x.test/sites/user_anon/oldslug/"),
      createEnv(bucket)
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<h1>Migrated</h1>");
  });

  it("serves a canonical /u/{handle}/{slug}/ URL by resolving the handle", async () => {
    publishProject(bucket, "cail-subj", "blog", { "index.html": "<h1>By Handle</h1>" });
    seedHandle(bucket, "cail-subj", "jane");

    const res = await worker.fetch(navRequest("https://x.test/u/jane/blog/"), createEnv(bucket));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<h1>By Handle</h1>");
  });

  it("404s a /u/{handle}/ URL when the handle resolves to nobody", async () => {
    const res = await worker.fetch(navRequest("https://x.test/u/ghost/blog/"), createEnv(bucket));
    expect(res.status).toBe(404);
  });

  it("301s a legacy /sites/{owner}/{slug} URL to /u/{handle}/ preserving path and query", async () => {
    publishProject(bucket, "cail-subj", "blog", {
      "index.html": "<h1>Home</h1>",
      "posts/a.html": "<h1>A</h1>"
    });
    seedHandle(bucket, "cail-subj", "jane");

    const res = await worker.fetch(
      new Request("https://x.test/sites/cail-subj/blog/posts/a.html?ref=x", {
        headers: { Accept: "text/html" },
        redirect: "manual"
      }),
      createEnv(bucket)
    );
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("https://x.test/u/jane/blog/posts/a.html?ref=x");
  });

  it("301s a legacy root /sites/{owner}/{slug}/ to the /u/ root (no index.html)", async () => {
    publishProject(bucket, "cail-subj", "blog", { "index.html": "<h1>Home</h1>" });
    seedHandle(bucket, "cail-subj", "jane");

    const res = await worker.fetch(
      new Request("https://x.test/sites/cail-subj/blog/", {
        headers: { Accept: "text/html" },
        redirect: "manual"
      }),
      createEnv(bucket)
    );
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("https://x.test/u/jane/blog/");
  });

  it("serves a legacy /sites/{owner}/{slug} URL directly when the owner has no handle", async () => {
    publishProject(bucket, "u", "blog", { "index.html": "<h1>Legacy Home</h1>" });

    const res = await worker.fetch(
      new Request("https://x.test/sites/u/blog/", {
        headers: { Accept: "text/html" },
        redirect: "manual"
      }),
      createEnv(bucket)
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<h1>Legacy Home</h1>");
  });

  it("prefers a project-supplied 404.html for missing navigations", async () => {
    publishProject(bucket, "u", "blog", {
      "index.html": "<h1>Home</h1>",
      "404.html": "<h1>Custom Not Found</h1>"
    });
    const res = await worker.fetch(
      navRequest("https://x.test/sites/u/blog/missing.html"),
      createEnv(bucket)
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toContain("Custom Not Found");
  });

  it("serves the styled fallback 404 for a missing navigation", async () => {
    publishProject(bucket, "u", "blog", { "index.html": "<h1>Home</h1>" });
    const res = await worker.fetch(
      navRequest("https://x.test/sites/u/blog/missing.html"),
      createEnv(bucket)
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Page not found");
    expect(body).toContain('href="/sites/u/blog/"');
  });

  it("keeps a terse 404 for a missing asset", async () => {
    publishProject(bucket, "u", "blog", { "index.html": "<h1>Home</h1>" });
    const res = await worker.fetch(
      assetRequest("https://x.test/sites/u/blog/missing.png"),
      createEnv(bucket)
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(await res.text()).toBe("Not found");
  });

  it("serves the styled 404 for an unknown site navigation without a home link", async () => {
    const res = await worker.fetch(
      navRequest("https://x.test/sites/u/nonexistent/"),
      createEnv(bucket)
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Page not found");
    expect(body).not.toContain("Go to site home");
  });

  it("returns a terse fallback for an unparseable path", async () => {
    const res = await worker.fetch(assetRequest("https://x.test/only-one-segment"), createEnv(bucket));
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
  });

  // §3¾ active-content invariant: every published byte the publisher serves is
  // agent/student-authored active content on our origin, so it must carry the
  // opaque-origin CSP (sandbox allow-scripts, NEVER allow-same-origin) +
  // nosniff. The styled fallback 404 is our own trusted markup and must NOT.
  it("sandboxes a served published page", async () => {
    publishProject(bucket, "u", "blog", { "index.html": "<h1>Home</h1>" });
    const res = await worker.fetch(navRequest("https://x.test/sites/u/blog/"), createEnv(bucket));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toBe("sandbox allow-scripts");
    expect(res.headers.get("Content-Security-Policy") || "").not.toContain("allow-same-origin");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("sandboxes a served published asset", async () => {
    publishProject(bucket, "u", "blog", {
      "index.html": "<h1>Home</h1>",
      "styles.css": "body{}"
    });
    const res = await worker.fetch(
      assetRequest("https://x.test/sites/u/blog/styles.css"),
      createEnv(bucket)
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toBe("sandbox allow-scripts");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("sandboxes a project-supplied 404.html", async () => {
    publishProject(bucket, "u", "blog", {
      "index.html": "<h1>Home</h1>",
      "404.html": "<h1>Custom Not Found</h1>"
    });
    const res = await worker.fetch(
      navRequest("https://x.test/sites/u/blog/missing.html"),
      createEnv(bucket)
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Custom Not Found");
    expect(res.headers.get("Content-Security-Policy")).toBe("sandbox allow-scripts");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("does NOT sandbox the styled fallback 404 (our own trusted markup)", async () => {
    publishProject(bucket, "u", "blog", { "index.html": "<h1>Home</h1>" });
    const res = await worker.fetch(
      navRequest("https://x.test/sites/u/blog/missing.html"),
      createEnv(bucket)
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Page not found");
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });
});
