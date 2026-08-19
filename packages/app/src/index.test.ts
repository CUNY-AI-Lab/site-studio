import { describe, expect, it, vi } from "vitest";
import type { Env } from "./types";

import worker from "./worker";

const BASE = "https://site-studio.example";
function createExecutionContext(): ExecutionContext {
  const fixture = {
    passThroughOnException() {},
    waitUntil(_promise: Promise<unknown>) {},
    exports: {},
    props: {},
    // SAFETY: Fetch dispatch never opens tracing spans in these tests.
    tracing: {} as Tracing,
    abort() {},
  };
  // SAFETY: Worker tests exercise only fetch dispatch; lifecycle methods and
  // runtime tracing are inert test doubles.
  return fixture as ExecutionContext;
}

function createTestBucket(): R2Bucket {
  const fixture = {
    head: vi.fn(async () => null),
    get: vi.fn(async () => null),
    put: vi.fn(async () => { throw new Error("R2 writes are not part of this fixture"); }),
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ objects: [], truncated: false, delimitedPrefixes: [] })),
    createMultipartUpload: vi.fn(async () => { throw new Error("multipart upload is not part of this fixture"); }),
    resumeMultipartUpload: vi.fn(() => { throw new Error("multipart upload is not part of this fixture"); }),
  };
  // SAFETY: Worker tests reach only the null metadata lookup and asset paths.
  return fixture as R2Bucket;
}

function asTestFetcher(fetch: Fetcher["fetch"]): Fetcher {
  const fixture = { fetch };
  // SAFETY: Worker asset dispatch only invokes the binding's fetch method.
  return fixture as Fetcher;
}

function createEnv(assetFetch?: Fetcher): Env {
  // SAFETY: Worker tests exercise only the listed health/asset bindings.
  return {
    CAIL_LOG_ENV: "test",
    CSRF_COOKIE_PATH: "/site-studio",
    SITE_STUDIO_BUCKET: createTestBucket(),
    ASSETS: assetFetch,
  } as Env;
}

describe("mounted Worker dispatch", () => {
  it("normalizes a mounted API path before route matching", async () => {
    const response = await worker.fetch(
      new Request(`${BASE}/site-studio/api/health`),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok" });

    const rootResponse = await worker.fetch(
      new Request(`${BASE}/api/health`),
      createEnv(),
      createExecutionContext(),
    );
    expect(rootResponse.status).toBe(200);
  });

  it.each([
    ["preview", "/site-studio/preview/project-id/index.html", 401],
    ["published", "/site-studio/u/unknown/site/", 404],
  ])("keeps a mounted %s path out of the SPA fallback", async (_label, path, status) => {
    const assetFetch = vi.fn(async () => new Response("SPA", { status: 200 }));
    const response = await worker.fetch(
      new Request(`${BASE}${path}`),
      createEnv(asTestFetcher(assetFetch)),
      createExecutionContext(),
    );

    expect(response.status).toBe(status);
    expect(assetFetch).not.toHaveBeenCalled();
  });

  it("keeps the mounted retired /sites path out of the SPA fallback", async () => {
    const assetFetch = vi.fn(async () => new Response("SPA", { status: 200 }));
    const response = await worker.fetch(
      new Request(`${BASE}/site-studio/sites/legacy-owner/site/`),
      createEnv(asTestFetcher(assetFetch)),
      createExecutionContext(),
    );

    expect(response.status).toBe(404);
    expect(assetFetch).not.toHaveBeenCalled();
  });

  it("forwards a mounted root to the asset binding as the root path", async () => {
    const assetFetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/");
      return new Response("<html>Site Studio</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });
    const response = await worker.fetch(
      new Request(`${BASE}/site-studio/`),
      createEnv(asTestFetcher(assetFetch)),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(assetFetch).toHaveBeenCalledOnce();
  });
});
