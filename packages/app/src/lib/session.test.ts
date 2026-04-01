import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../types";
import { authMiddleware } from "./session";

function createEnv(overrides?: Partial<Env>): Env {
  return {
    APP_PUBLIC_DOMAIN: "https://tools.ailab.gc.cuny.edu",
    LEGACY_PUBLIC_DOMAIN: "https://tools.cuny.qzz.io",
    LOADER: {} as WorkerLoader,
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_MODEL: "test-model",
    SESSION_KV: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined)
    } as unknown as KVNamespace,
    SITE_STUDIO_BUCKET: {
      get: vi.fn(async () => null)
    } as unknown as R2Bucket,
    SITE_BUILDER_AGENT: {} as DurableObjectNamespace<any>,
    ASSETS: undefined,
    ...overrides
  };
}

describe("authMiddleware", () => {
  it("creates a new anonymous session when a legacy session blob is malformed", async () => {
    const app = new Hono<{ Bindings: Env; Variables: { user: { id: string; createdAt: string } } }>();
    app.use("*", authMiddleware);
    app.get("/api/test", (c) => c.json({ user: c.get("user") }));

    const kvPut = vi.fn(async () => undefined);
    const env = createEnv({
      SESSION_KV: {
        get: vi.fn(async () => null),
        put: kvPut
      } as unknown as KVNamespace,
      SITE_STUDIO_BUCKET: {
        get: vi.fn(async () => ({
          text: async () => "{not valid json"
        }))
      } as unknown as R2Bucket
    });

    const response = await app.request("http://site-studio.test/api/test", {
      headers: {
        Cookie: "site-studio-session=broken-session"
      }
    }, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      user: {
        id: expect.stringMatching(/^user_/),
        createdAt: expect.any(String)
      }
    });
    expect(kvPut).toHaveBeenCalledTimes(1);
    expect(response.headers.get("set-cookie")).toContain("site-studio-session=");
  });
});
