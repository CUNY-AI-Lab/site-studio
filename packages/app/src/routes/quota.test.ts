import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { quotaSnapshotResponse } from "@cuny-ai-lab/cail-client/testing";
import type { Env } from "../types";
import { createQuotaRouter } from "./quota";

describe("quota route", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("proxies the verified JWT Cloudflare estimate without changing the wire shape", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Request(input).url).toBe("https://cail.example/v1/quota");
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer verified-jwt");
      expect(headers.get("X-CAIL-App")).toBe("site-studio");
      expect(headers.has("X-CAIL-Identity-JWT")).toBe(false);
      return quotaSnapshotResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = new Hono<{ Bindings: Env; Variables: { cailGatewayJwt: string } }>();
    app.use("*", async (c, next) => {
      c.set("cailGatewayJwt", "verified-jwt");
      await next();
    });
    app.route("/", createQuotaRouter());
    // SAFETY: This fixture supplies the bindings used by the quota route.
    const response = await app.request("http://site-studio.test/api/quota", {}, {
      CAIL_API_BASE: "https://cail.example"
    } as Env);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    // SAFETY: quotaSnapshotResponse() supplies the route's documented JSON shape.
    const body = await response.json() as ReturnType<typeof quotaSnapshotResponse>;
    expect(body).toEqual({
      object: "quota",
      managed_by: "cloudflare",
      state: "estimated",
      unit: "microdollar",
      currency: "USD",
      limit: 10000000,
      estimated_used: 630000,
      estimated_remaining: 9370000,
      used_percent: 6,
      remaining_percent: 94,
      window_seconds: 2592000,
      window_technique: "sliding",
      calculated_at: 1720600000,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("maps a transport failure to a valid unavailable response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("private transport detail");
    }));

    const app = new Hono<{ Bindings: Env; Variables: { cailGatewayJwt: string } }>();
    app.use("*", async (c, next) => {
      c.set("cailGatewayJwt", "verified-jwt");
      await next();
    });
    app.route("/", createQuotaRouter());
    // SAFETY: This fixture supplies the bindings used by the quota route.
    const response = await app.request("http://site-studio.test/api/quota", {}, {
      CAIL_API_BASE: "https://cail.example"
    } as Env);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "network_error",
      message: "Couldn't check your remaining AI time."
    });
  });
});
