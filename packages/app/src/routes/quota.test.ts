import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { quotaSnapshotResponse } from "@cuny-ai-lab/cail-client/testing";
import type { Env } from "../types";
import { createQuotaRouter } from "./quota";

describe("quota route", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the verified JWT wire contract and never exposes the subject", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
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
    const response = await app.request("http://site-studio.test/api/quota", {}, {
      CAIL_API_BASE: "https://cail.example"
    } as Env);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response.json() as Record<string, unknown>;
    expect(body.subject).toBeUndefined();
    expect(body).toMatchObject({ limit: 10000000, remaining: 9370000, enforced: true });
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
    const response = await app.request("http://site-studio.test/api/quota", {}, {
      CAIL_API_BASE: "https://cail.example"
    } as Env);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "network_error",
      message: "The network request to the CAIL backbone failed."
    });
  });
});
