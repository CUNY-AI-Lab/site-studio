import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../types";
import { createQuotaRouter } from "./quota";

describe("quota route", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the verified JWT wire contract and never exposes the subject", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("X-CAIL-Identity-JWT")).toBe("verified-jwt");
      expect(headers.get("X-CAIL-App")).toBe("site-studio");
      expect(headers.has("Authorization")).toBe(false);
      return Response.json({
        object: "quota",
        subject: "cail-5ec2e7015ec2e7015ec2e7015ec2e701",
        unit: "microdollar",
        currency: "USD",
        window_seconds: 2592000,
        limit: 10000000,
        used: 630000,
        remaining: 9370000,
        reset: 1723200000,
        as_of: 1720600000,
        state: "ok",
        enforced: true
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = new Hono<{ Bindings: Env; Variables: { cailIdentityJwt: string } }>();
    app.use("*", async (c, next) => {
      c.set("cailIdentityJwt", "verified-jwt");
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

    const app = new Hono<{ Bindings: Env; Variables: { cailIdentityJwt: string } }>();
    app.use("*", async (c, next) => {
      c.set("cailIdentityJwt", "verified-jwt");
      await next();
    });
    app.route("/", createQuotaRouter());
    const response = await app.request("http://site-studio.test/api/quota", {}, {
      CAIL_API_BASE: "https://cail.example"
    } as Env);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "network_error",
      message: "Network request to the CAIL backbone failed."
    });
  });
});
