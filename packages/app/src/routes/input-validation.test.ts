import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../types";
import { createMockMutationCoordinator, createTestNamespace, createTestR2Object } from "../lib/test-utils";
import type { MutationCoordinator } from "../agents/mutation-coordinator";
import { csrfProtect } from "../lib/csrf";
import { createMockKV, mintCsrfSession, type CsrfSession, type MockKV } from "../lib/test-utils";
import { R2ProjectStorage } from "../storage/r2";
import { createFileRouter } from "./files";
import { createProjectRouter } from "./projects";
import { requireProject } from "../lib/require-project";
import { z } from "zod";

/**
 * SS-6: malformed / schema-invalid JSON bodies on the four mutation routes must
 * return 400 (a bad request), not 500. Before the fix, `await c.req.json()`
 * threw a SyntaxError on non-JSON and `schema.parse()` threw a ZodError on
 * schema-invalid input; neither is an HTTPException, so the generic onError
 * fell through to 500. The routes now parse the body safely (catch → {}) and
 * `safeParse`, returning a 400 via jsonError.
 *
 * Setup mirrors regressions.test.ts: in-memory KV + R2 mocks, a session
 * middleware stub, and csrfProtect so mutations carry the session token.
 */

// Module-scoped session bits, reset per test.
let kv: MockKV;
let csrf: CsrfSession;

function createMockBucket() {
  type MockData = string | ArrayBuffer;
  type MockEntry = { data: MockData; httpMetadata?: R2HTTPMetadata };
  const dataSchema = z.union([z.string(), z.instanceof(ArrayBuffer)]);
  const store = new Map<string, MockEntry>();

  // SAFETY: The fixture implements the R2 methods exercised by the mutation
  // routes; uncalled binding methods are outside this test boundary.
  return {
    store,
    head: vi.fn(async (key: string) => {
      return store.has(key) ? { key, size: 0 } : null;
    }),
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;

      const data = dataSchema.parse(entry.data);
      return {
        key,
        size: data instanceof ArrayBuffer ? data.byteLength : data.length,
        httpMetadata: entry.httpMetadata || {},
        text: async () => (data instanceof ArrayBuffer ? new TextDecoder().decode(data) : data),
        arrayBuffer: async () => (data instanceof ArrayBuffer ? data : new TextEncoder().encode(data).buffer)
      };
    }),
    put: vi.fn(async (
      key: string,
      data: string | ArrayBuffer | Uint8Array,
      options?: { httpMetadata?: R2HTTPMetadata; onlyIf?: { etagDoesNotMatch?: string } }
    ) => {
      if (options?.onlyIf?.etagDoesNotMatch === "*" && store.has(key)) {
        return null;
      }
      let stored: ArrayBuffer | string;
      if (data instanceof ArrayBuffer) {
        stored = data;
      } else if (data instanceof Uint8Array) {
        const copy = new Uint8Array(data.byteLength);
        copy.set(data);
        stored = copy.buffer;
      } else {
        stored = data;
      }

      store.set(key, { data: stored, httpMetadata: options?.httpMetadata });
      return createTestR2Object(key, `${key}:etag`, stored instanceof ArrayBuffer ? stored.byteLength : stored.length);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async ({ prefix, delimiter, limit }: { prefix?: string; delimiter?: string; limit?: number } = {}) => {
      const objects: R2Object[] = [];
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

        objects.push(createTestR2Object(key));
      }

      return {
        objects: limit ? objects.slice(0, limit) : objects,
        truncated: false,
        delimitedPrefixes
      };
    }),
    createMultipartUpload: vi.fn(async () => { throw new Error("multipart upload is not part of this fixture"); }),
    resumeMultipartUpload: vi.fn(() => { throw new Error("multipart upload is not part of this fixture"); })
  } as R2Bucket & { store: Map<string, MockEntry> };
}

function createTestApp() {
  const app = new Hono<{ Bindings: Env; Variables: { user: { id: string; createdAt: string } } }>();

  app.use("*", async (c, next) => {
    c.set("user", { id: "user_test123", createdAt: "2026-04-01T00:00:00.000Z" });
    await next();
  });

  app.use("/api/*", csrfProtect);
  app.use("/api/projects/:id", requireProject());
  app.use("/api/projects/:id/*", requireProject());

  app.route("/", createFileRouter());
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
    CAIL_LOG_ENV: "test",
    SESSION_KV: kv,
    SITE_STUDIO_BUCKET: bucket,
    // SAFETY: Input-validation routes never connect to these namespaces.
    SITE_BUILDER_AGENT: {} as DurableObjectNamespace<any>,
    // SAFETY: Input-validation routes never invoke migration coordination.
    MIGRATION_COORDINATOR: {} as DurableObjectNamespace<any>,
    MUTATION_COORDINATOR: createTestNamespace<MutationCoordinator>(createMockMutationCoordinator(bucket)),
    // SAFETY: This suite does not load template modules through WorkerLoader.
    LOADER: {} as WorkerLoader,
    ASSETS: undefined
  };
}

/** A mutation request carrying the session CSRF token + same-origin posture. */
function jsonBody(raw: string): RequestInit {
  return {
    method: "POST",
    body: raw,
    headers: { "Content-Type": "application/json", ...csrf.headers }
  };
}

describe("SS-6 input validation (bad body → 400, not 500)", () => {
  const userId = "user_test123";
  let bucket: ReturnType<typeof createMockBucket>;
  let storage: R2ProjectStorage;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    bucket = createMockBucket();
    storage = new R2ProjectStorage(bucket);
    app = createTestApp();
    kv = createMockKV();
    csrf = await mintCsrfSession(bucket, userId);
  });

  describe("POST /api/projects", () => {
    const url = "http://site-studio.test/api/projects";

    it("non-JSON body → 400", async () => {
      const res = await app.request(url, { ...jsonBody("not json at all"), method: "POST" }, createEnv(bucket));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "Invalid project payload" });
    });

    it("schema-invalid body (missing name) → 400", async () => {
      const res = await app.request(url, jsonBody(JSON.stringify({ template: "blank" })), createEnv(bucket));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "Invalid project payload" });
    });

    it("schema-invalid body (over-long name) → 400", async () => {
      const res = await app.request(url, jsonBody(JSON.stringify({ name: "x".repeat(101) })), createEnv(bucket));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "Invalid project payload" });
    });

    it("valid body → still succeeds", async () => {
      const res = await app.request(url, jsonBody(JSON.stringify({ name: "My Project" })), createEnv(bucket));
      expect(res.status).toBe(200);
      // SAFETY: The successful project route returns the documented object shape.
      const body = (await res.json()) as { id: string; name: string };
      expect(body.name).toBe("My Project");
    });
  });

  describe("PATCH /api/projects/:id", () => {
    const url = "http://site-studio.test/api/projects/proj-x";
    const patch = (raw: string): RequestInit => ({ ...jsonBody(raw), method: "PATCH" });

    beforeEach(async () => {
      await storage.createProject(userId, "proj-x", "Proj X");
    });

    it("non-JSON body → 400", async () => {
      const res = await app.request(url, patch("}{ broken"), createEnv(bucket));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "Invalid project payload" });
    });

    it("schema-invalid body (empty name) → 400", async () => {
      const res = await app.request(url, patch(JSON.stringify({ name: "" })), createEnv(bucket));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "Invalid project payload" });
    });

    it("schema-invalid body (over-long name) → 400", async () => {
      const res = await app.request(url, patch(JSON.stringify({ name: "y".repeat(101) })), createEnv(bucket));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "Invalid project payload" });
    });

    it("valid body → still succeeds", async () => {
      const res = await app.request(url, patch(JSON.stringify({ name: "Renamed" })), createEnv(bucket));
      expect(res.status).toBe(200);
      // SAFETY: The successful project patch returns the documented object shape.
      const body = (await res.json()) as { name: string };
      expect(body.name).toBe("Renamed");
    });
  });

  describe("POST /api/projects/:id/file", () => {
    const url = "http://site-studio.test/api/projects/proj-x/file";

    beforeEach(async () => {
      await storage.createProject(userId, "proj-x", "Proj X");
    });

    it("non-JSON body → 400", async () => {
      const res = await app.request(url, jsonBody("<<<not json>>>"), createEnv(bucket));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "Invalid file payload" });
    });

    it("schema-invalid body (missing content) → 400", async () => {
      const res = await app.request(url, jsonBody(JSON.stringify({ path: "a.html" })), createEnv(bucket));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "Invalid file payload" });
    });

    it("schema-invalid body (empty path) → 400", async () => {
      const res = await app.request(url, jsonBody(JSON.stringify({ path: "", content: "hi" })), createEnv(bucket));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "Invalid file payload" });
    });

    it("valid body → still succeeds", async () => {
      const res = await app.request(
        url,
        jsonBody(JSON.stringify({ path: "page.html", content: "<h1>Hi</h1>" })),
        createEnv(bucket)
      );
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ success: true, path: "page.html" });
    });
  });

  describe("PUT /api/projects/:id/files/rename", () => {
    const url = "http://site-studio.test/api/projects/proj-x/files/rename";
    const put = (raw: string): RequestInit => ({ ...jsonBody(raw), method: "PUT" });

    beforeEach(async () => {
      await storage.createProject(userId, "proj-x", "Proj X");
      await storage.writeFile(userId, "proj-x", "a.html", "<h1>A</h1>");
    });

    it("non-JSON body → 400", async () => {
      const res = await app.request(url, put("nope"), createEnv(bucket));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "Invalid rename payload" });
    });

    it("schema-invalid body (missing newPath) → 400", async () => {
      const res = await app.request(url, put(JSON.stringify({ oldPath: "a.html" })), createEnv(bucket));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "Invalid rename payload" });
    });

    it("schema-invalid body (empty oldPath) → 400", async () => {
      const res = await app.request(url, put(JSON.stringify({ oldPath: "", newPath: "b.html" })), createEnv(bucket));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "Invalid rename payload" });
    });

    it("valid body → still succeeds", async () => {
      const res = await app.request(url, put(JSON.stringify({ oldPath: "a.html", newPath: "b.html" })), createEnv(bucket));
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ success: true, oldPath: "a.html", newPath: "b.html" });
    });
  });
});
