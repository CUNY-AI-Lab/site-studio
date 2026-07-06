import { describe, it, expect, beforeEach, vi } from "vitest";
import worker, {
  getContentType as workerGetContentType,
  findPublishedProject as workerFindPublishedProject,
  type Env
} from "./index";
// The app worker's authoritative serving copies. The publisher CANNOT import
// from packages/app at runtime (separate deploy), so its serving logic is a
// hand-maintained duplicate. This test imports BOTH copies and asserts they
// agree across a matrix — it is the anti-drift mechanism: if a future edit
// touches one copy and not the other, one of these assertions fails.
import {
  getServedContentType as appGetServedContentType,
  SERVED_CONTENT_TYPES as APP_SERVED_CONTENT_TYPES
} from "../../app/src/lib/constants";
import { servedContentHeaders as workerServedContentHeaders } from "./serving-headers";
import { servedContentHeaders as appServedContentHeaders } from "../../app/src/lib/serving-headers";

/**
 * Minimal in-memory R2 bucket (same shape the two suites already use), returning
 * the extra fields the serving paths read (`body`, `etag`, `uploaded`).
 */
function createMockBucket() {
  const store = new Map<string, { data: ArrayBuffer | string; httpMetadata?: unknown }>();

  const makeObject = (key: string, entry: { data: ArrayBuffer | string }) => {
    const data = entry.data;
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
    return {
      key,
      size: bytes.byteLength,
      etag: `etag-${key}`,
      uploaded: new Date("2026-01-01T00:00:00.000Z"),
      httpMetadata: {},
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

/**
 * SS-8 — content-type parity. Both workers resolve a file's served Content-Type
 * from an authoritative table; those tables must be byte-identical. The matrix
 * covers every extension that ever differed (mjs, md, csv, avif, eot, media) and
 * confirms both fall through to octet-stream identically.
 */
describe("SS-8 content-type parity (app vs publisher)", () => {
  const EXTENSION_MATRIX = [
    "index.html",
    "page.htm",
    "styles.css",
    "app.js",
    "module.mjs",
    "data.json",
    "sitemap.xml",
    "notes.txt",
    "readme.md",
    "table.csv",
    "logo.png",
    "photo.jpg",
    "photo.jpeg",
    "anim.gif",
    "art.svg",
    "hero.webp",
    "hero.avif",
    "favicon.ico",
    "paper.pdf",
    "font.woff",
    "font.woff2",
    "font.ttf",
    "legacy.eot",
    "font.otf",
    "clip.mp4",
    "clip.webm",
    "song.mp3",
    "sound.wav",
    "audio.ogg",
    // unknown / extensionless fall-throughs
    "archive.bin",
    "Makefile",
    "UPPER.PNG"
  ];

  it("returns the SAME Content-Type for every matrix extension", () => {
    for (const file of EXTENSION_MATRIX) {
      expect(
        workerGetContentType(file),
        `content-type disagreement for ${file}`
      ).toBe(appGetServedContentType(file));
    }
  });

  it("both tables enumerate the same extension set with the same values", () => {
    // Rebuild the publisher's table from its lookups over the app's key set:
    // if the app knows an extension the publisher does not (or maps it
    // differently) this fails, catching a one-sided edit.
    for (const [ext, appType] of Object.entries(APP_SERVED_CONTENT_TYPES)) {
      expect(workerGetContentType(`file${ext}`), `publisher missing/mismatched ${ext}`).toBe(appType);
    }
  });

  it("text types carry an explicit charset; binary types do not (SS-8)", () => {
    expect(workerGetContentType("index.html")).toBe("text/html; charset=utf-8");
    expect(appGetServedContentType("index.html")).toBe("text/html; charset=utf-8");
    // ES modules must NOT fall through to octet-stream (that broke module loads).
    expect(workerGetContentType("m.mjs")).toBe("application/javascript; charset=utf-8");
    expect(appGetServedContentType("m.mjs")).toBe("application/javascript; charset=utf-8");
    expect(workerGetContentType("logo.png")).toBe("image/png");
    expect(appGetServedContentType("logo.png")).toBe("image/png");
  });
});

/**
 * SS-13 — slug-less matching + tiebreaker parity. Exercised against the
 * publisher's findPublishedProject directly; the app worker's counterpart
 * (findPublishedProjectBySlug) is exercised through its own route suite. Both
 * must (a) resolve a slug-less project by projectId and (b) break equal-
 * timestamp ties by projectId deterministically.
 */
describe("SS-13 slug-less + tiebreaker parity", () => {
  let bucket: ReturnType<typeof createMockBucket>;
  beforeEach(() => {
    bucket = createMockBucket();
  });

  it("resolves a slug-less published project by projectId", async () => {
    publishProject(bucket, "u", "legacy", { "index.html": "hi" }, { slug: undefined });
    const resolved = await workerFindPublishedProject(bucket, "u", "legacy");
    expect(resolved?.projectId).toBe("legacy");
  });

  it("breaks an equal-timestamp tie deterministically by projectId (desc)", async () => {
    const ts = "2026-03-01T00:00:00.000Z";
    publishProject(bucket, "u", "alpha", { "index.html": "A" }, { slug: "dup", publishedAt: ts });
    publishProject(bucket, "u", "omega", { "index.html": "O" }, { slug: "dup", publishedAt: ts });
    const resolved = await workerFindPublishedProject(bucket, "u", "dup");
    // right.projectId.localeCompare(left) => "omega" sorts before "alpha".
    expect(resolved?.projectId).toBe("omega");
  });
});

/**
 * SS-14 — extensionless resolution parity. The publisher must try `{path}.html`
 * BEFORE `{path}/index.html`. Both cases are driven end-to-end through fetch.
 */
describe("SS-14 extensionless resolution parity", () => {
  let bucket: ReturnType<typeof createMockBucket>;
  beforeEach(() => {
    bucket = createMockBucket();
  });

  it("prefers {path}.html over {path}/index.html", async () => {
    publishProject(bucket, "u", "blog", {
      "index.html": "<h1>Home</h1>",
      "about.html": "<h1>Flat About</h1>",
      "about/index.html": "<h1>Nested About</h1>"
    });
    const res = await worker.fetch(
      new Request("https://x.test/sites/u/blog/about", { headers: { Accept: "text/html" } }),
      createEnv(bucket)
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Flat About");
  });

  it("falls back to {path}/index.html when no {path}.html exists", async () => {
    publishProject(bucket, "u", "blog", {
      "index.html": "<h1>Home</h1>",
      "docs/index.html": "<h1>Docs</h1>"
    });
    const res = await worker.fetch(
      new Request("https://x.test/sites/u/blog/docs", { headers: { Accept: "text/html" } }),
      createEnv(bucket)
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Docs");
  });
});

/**
 * SS-15 — caching + §3¾ CSP composition parity. HTML gets max-age=300 +
 * ETag/Last-Modified; other assets get immutable long-cache; BOTH also carry
 * the opaque-origin sandbox CSP + nosniff (they compose, neither clobbers).
 */
describe("SS-15 caching composes with the CSP (publisher)", () => {
  let bucket: ReturnType<typeof createMockBucket>;
  beforeEach(() => {
    bucket = createMockBucket();
  });

  it("HTML: max-age=300 + validators + CSP together", async () => {
    publishProject(bucket, "u", "blog", { "index.html": "<h1>Home</h1>" });
    const res = await worker.fetch(
      new Request("https://x.test/sites/u/blog/", { headers: { Accept: "text/html" } }),
      createEnv(bucket)
    );
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(res.headers.get("ETag")).toBeTruthy();
    expect(res.headers.get("Last-Modified")).toBeTruthy();
    expect(res.headers.get("Content-Security-Policy")).toBe("sandbox allow-scripts");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("asset: immutable long-cache + CSP together", async () => {
    publishProject(bucket, "u", "blog", { "index.html": "x", "app.mjs": "export const a=1;" });
    const res = await worker.fetch(
      new Request("https://x.test/sites/u/blog/app.mjs", { headers: { Accept: "*/*" } }),
      createEnv(bucket)
    );
    expect(res.headers.get("Content-Type")).toBe("application/javascript; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("Content-Security-Policy")).toBe("sandbox allow-scripts");
  });
});

/**
 * SS-16 — no bare owner-id fallback. A ≥2-segment path that is neither /u/ nor
 * /sites/ must NOT serve owner-id-addressed content; it returns the styled 404.
 */
describe("SS-16 bare owner-id path never serves", () => {
  it("a bare /{owner}/{slug}/ path returns 404, not the owner's content", async () => {
    const bucket = createMockBucket();
    // Even with a real published project under this owner id, the bare path
    // (no /sites/ prefix) must not reach it.
    publishProject(bucket, "owner", "blog", { "index.html": "<h1>Secret</h1>" });
    const res = await worker.fetch(
      new Request("https://x.test/owner/blog/", { headers: { Accept: "text/html" } }),
      createEnv(bucket)
    );
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("Secret");
  });
});

/**
 * SS-27 — custom-404 gating parity. The project 404.html serves ONLY for page
 * navigations; a missing asset gets a terse text/plain 404 on the publisher,
 * matching the app worker.
 */
describe("SS-27 custom-404 navigation gating (publisher)", () => {
  let bucket: ReturnType<typeof createMockBucket>;
  beforeEach(() => {
    bucket = createMockBucket();
  });

  it("navigation miss serves the project 404.html", async () => {
    publishProject(bucket, "u", "blog", {
      "index.html": "<h1>Home</h1>",
      "404.html": "<h1>Custom</h1>"
    });
    const res = await worker.fetch(
      new Request("https://x.test/sites/u/blog/missing.html", { headers: { Accept: "text/html" } }),
      createEnv(bucket)
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Custom");
  });

  it("asset miss stays terse even when a 404.html exists", async () => {
    publishProject(bucket, "u", "blog", {
      "index.html": "<h1>Home</h1>",
      "404.html": "<h1>Custom</h1>"
    });
    const res = await worker.fetch(
      new Request("https://x.test/sites/u/blog/missing.png", { headers: { Accept: "image/png,*/*" } }),
      createEnv(bucket)
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(await res.text()).toBe("Not found");
  });

  // The §3¾ security headers are ALSO a hand-maintained app+publisher duplicate
  // (packages/{app/src/lib,worker/src}/serving-headers.ts). They are
  // security-critical — a silent divergence could drop the opaque-origin CSP on
  // one worker — so the anti-drift test covers them too.
  describe("servedContentHeaders parity (security headers must not drift)", () => {
    for (const ct of ["text/html; charset=utf-8", "image/svg+xml", "text/css", "application/octet-stream"]) {
      it(`app and publisher emit identical security headers for ${ct}`, () => {
        expect(workerServedContentHeaders(ct)).toEqual(appServedContentHeaders(ct));
      });
    }

    it("both keep the load-bearing opaque-origin CSP (sandbox, no allow-same-origin)", () => {
      for (const headers of [appServedContentHeaders("text/html"), workerServedContentHeaders("text/html")]) {
        expect(headers["Content-Security-Policy"]).toBe("sandbox allow-scripts");
        expect(headers["Content-Security-Policy"]).not.toContain("allow-same-origin");
        expect(headers["X-Content-Type-Options"]).toBe("nosniff");
      }
    });
  });
});
