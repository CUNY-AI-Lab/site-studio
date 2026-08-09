import { describe, expect, it, vi } from "vitest";
import type { Env } from "./types";

vi.mock("agents", () => ({
  getAgentByName: vi.fn(),
}));
vi.mock("./agents/site-builder", () => ({ SiteBuilderAgent: class {} }));
vi.mock("./agents/migration-coordinator", () => ({ MigrationCoordinator: class {} }));
vi.mock("./agents/mutation-coordinator", () => ({ MutationCoordinator: class {} }));

import worker from "./index";

const BASE = "https://site-studio.example";
const executionContext = {
  passThroughOnException() {},
  waitUntil() {},
} as unknown as ExecutionContext;

function createEnv(assetFetch?: Fetcher): Env {
  return {
    CAIL_LOG_ENV: "test",
    CSRF_COOKIE_PATH: "/site-studio",
    SITE_STUDIO_BUCKET: {
      get: vi.fn(async () => null),
    } as unknown as R2Bucket,
    ASSETS: assetFetch,
  } as Env;
}

describe("mounted Worker dispatch", () => {
  it("normalizes a mounted API path before route matching", async () => {
    const response = await worker.fetch(
      new Request(`${BASE}/site-studio/api/health`),
      createEnv(),
      executionContext,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok" });

    const rootResponse = await worker.fetch(
      new Request(`${BASE}/api/health`),
      createEnv(),
      executionContext,
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
      createEnv({ fetch: assetFetch } as unknown as Fetcher),
      executionContext,
    );

    expect(response.status).toBe(status);
    expect(assetFetch).not.toHaveBeenCalled();
  });

  it("keeps the mounted retired /sites path out of the SPA fallback", async () => {
    const assetFetch = vi.fn(async () => new Response("SPA", { status: 200 }));
    const response = await worker.fetch(
      new Request(`${BASE}/site-studio/sites/legacy-owner/site/`),
      createEnv({ fetch: assetFetch } as unknown as Fetcher),
      executionContext,
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
      createEnv({ fetch: assetFetch } as unknown as Fetcher),
      executionContext,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(assetFetch).toHaveBeenCalledOnce();
  });
});
