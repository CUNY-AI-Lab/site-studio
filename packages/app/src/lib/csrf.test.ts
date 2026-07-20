import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import type { Env } from "../types";
import { TEST_SUBJECTS, canonicalTestSubject } from "@cuny-ai-lab/cail-identity/testing";

// Canonical test subjects (cail-identity/testing kit).
const OWNER = TEST_SUBJECTS.alice;
const ROUTE_USER = canonicalTestSubject("route-user");
import {
  CSRF_ERROR_BODY,
  CSRF_HEADER_NAME,
  csrfDecision,
  csrfProtect,
  getCsrfToken,
  getOrMintCsrfToken,
  isLoopbackOrigin,
  SITE_STUDIO_CSRF_COOKIE_PATH,
  setCsrfCookie,
  timingSafeEqual,
  validateCsrfCookiePath,
  verifyWsUpgrade,
  type CsrfRequestFacts
} from "./csrf";
import { mintCsrfSession } from "./test-utils";

const REQUEST_ORIGIN = "https://site-studio.example";
const APP_PUBLIC_DOMAIN = "https://tools.ailab.gc.cuny.edu";
const TOKEN = "a".repeat(64);

function createCsrfBucket(): R2Bucket {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => {
      const value = store.get(key);
      return value === undefined ? null : { key, text: async () => value };
    }),
    put: vi.fn(async (key: string, value: string, options?: R2PutOptions) => {
      if (options?.onlyIf && "etagDoesNotMatch" in options.onlyIf && options.onlyIf.etagDoesNotMatch === "*" && store.has(key)) {
        return null;
      }
      store.set(key, value);
      return { key };
    })
  } as unknown as R2Bucket;
}

function facts(overrides: Partial<CsrfRequestFacts>): CsrfRequestFacts {
  return {
    secFetchSite: null,
    origin: null,
    requestOrigin: REQUEST_ORIGIN,
    appPublicDomain: APP_PUBLIC_DOMAIN,
    presentedToken: TOKEN,
    expectedToken: TOKEN,
    ...overrides
  };
}

describe("csrfDecision (rules 2+3 matrix)", () => {
  type Case = [name: string, overrides: Partial<CsrfRequestFacts>, expected: boolean];

  const cases: Case[] = [
    // ---- Rule 3: token states (posture held compliant) ----
    ["valid token + Sec-Fetch-Site same-origin", { secFetchSite: "same-origin" }, true],
    ["missing token + same-origin", { secFetchSite: "same-origin", presentedToken: null }, false],
    ["mismatched token + same-origin", { secFetchSite: "same-origin", presentedToken: "b".repeat(64) }, false],
    ["valid-looking token but none ever minted", { secFetchSite: "same-origin", expectedToken: null }, false],
    ["empty presented token", { secFetchSite: "same-origin", presentedToken: "" }, false],

    // ---- Rule 2: Sec-Fetch-Site present decides alone ----
    ["valid token + Sec-Fetch-Site same-site", { secFetchSite: "same-site" }, false],
    ["valid token + Sec-Fetch-Site cross-site", { secFetchSite: "cross-site" }, false],
    ["valid token + Sec-Fetch-Site none", { secFetchSite: "none" }, false],
    // 2026-07-05 clarification: same-site is rejected EVEN WITH a valid Origin.
    [
      "clarified rule 2: valid token + valid Origin + Sec-Fetch-Site same-site",
      { secFetchSite: "same-site", origin: REQUEST_ORIGIN },
      false
    ],
    [
      "valid token + canonical APP_PUBLIC_DOMAIN Origin + Sec-Fetch-Site cross-site",
      { secFetchSite: "cross-site", origin: APP_PUBLIC_DOMAIN },
      false
    ],

    // ---- Rule 2: Origin fallback (no Sec-Fetch-Site) ----
    ["valid token + Origin = own serving origin", { origin: REQUEST_ORIGIN }, true],
    ["valid token + Origin = APP_PUBLIC_DOMAIN", { origin: APP_PUBLIC_DOMAIN }, true],
    ["valid token + foreign Origin", { origin: "https://evil.example" }, false],
    ["missing token + Origin = own serving origin", { origin: REQUEST_ORIGIN, presentedToken: null }, false],
    ["mismatched token + Origin = own serving origin", { origin: REQUEST_ORIGIN, presentedToken: "x".repeat(64) }, false],

    // ---- Both origin signals absent: token alone decides ----
    ["valid token + no origin headers", {}, true],
    ["missing token + no origin headers", { presentedToken: null }, false],
    ["mismatched token + no origin headers", { presentedToken: "b".repeat(64) }, false]
  ];

  for (const [name, overrides, expected] of cases) {
    it(`${expected ? "accepts" : "rejects"}: ${name}`, () => {
      expect(csrfDecision(facts(overrides))).toBe(expected);
    });
  }

  it("normalizes Sec-Fetch-Site case/whitespace", () => {
    expect(csrfDecision(facts({ secFetchSite: " Same-Origin " }))).toBe(true);
    expect(csrfDecision(facts({ secFetchSite: " Cross-Site " }))).toBe(false);
  });

  it("does not treat an unparseable APP_PUBLIC_DOMAIN as a match", () => {
    expect(csrfDecision(facts({ origin: "not a url", appPublicDomain: "not a url" }))).toBe(false);
  });
});

describe("token mint/lookup", () => {
  it("mints a 64-char hex token lazily and keeps it stable per user", async () => {
    const bucket = createCsrfBucket();
    expect(await getCsrfToken(bucket, OWNER)).toBeNull();

    const first = await getOrMintCsrfToken(bucket, OWNER);
    expect(first).toMatch(/^[0-9a-f]{64}$/);

    const second = await getOrMintCsrfToken(bucket, OWNER);
    expect(second).toBe(first);
    expect(await getCsrfToken(bucket, OWNER)).toBe(first);
  });

  it("mints different tokens for different users", async () => {
    const bucket = createCsrfBucket();
    const a = await getOrMintCsrfToken(bucket, OWNER);
    const b = await getOrMintCsrfToken(bucket, "user_anon");
    expect(a).not.toBe(b);
  });

  // SS-53: two parallel FIRST requests both read "no token" and mint. The old
  // read-check-write returned each racer its own mint, so one client held a
  // token that no longer matched KV and every subsequent mutation 403'd until a
  // refetch. All racers must converge on the token atomically created in R2.
  it("SS-53: two parallel first requests converge on the single stored token", async () => {
    const bucket = createCsrfBucket();

    const [a, b] = await Promise.all([
      getOrMintCsrfToken(bucket, OWNER),
      getOrMintCsrfToken(bucket, OWNER)
    ]);

    expect(a).toBe(b);
    // What each racer handed the client is exactly what verification will read.
    await expect(getCsrfToken(bucket, OWNER)).resolves.toBe(a);
  });
});

describe("setCsrfCookie (rule 3 delivery)", () => {
  async function setCookieHeader(url: string, csrfCookiePath?: string): Promise<string> {
    const app = new Hono<{ Bindings: Env }>();
    app.get("*", (c) => {
      setCsrfCookie(c, TOKEN);
      return c.body(null, 204);
    });
    const env = { CSRF_COOKIE_PATH: csrfCookiePath } as unknown as Env;
    const res = await app.request(url, {}, env);
    return res.headers.get("set-cookie") || "";
  }

  it("emits Secure + SameSite=Lax + Path=/site-studio, NOT HttpOnly, over https", async () => {
    const setCookie = await setCookieHeader(
      "https://tools.example/site-studio/x",
      SITE_STUDIO_CSRF_COOKIE_PATH
    );
    expect(setCookie).toContain(`cail_csrf_sitestudio=${TOKEN}`);
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/site-studio");
    expect(setCookie).not.toContain("HttpOnly");
  });

  it("rejects missing and root-scoped cookie configuration", () => {
    expect(() => validateCsrfCookiePath(undefined)).toThrow("CSRF_COOKIE_PATH must be /site-studio");
    expect(() => validateCsrfCookiePath("/")).toThrow("CSRF_COOKIE_PATH must be /site-studio");
  });

  it("uses root scope and drops Secure on loopback http development", async () => {
    const setCookie = await setCookieHeader(
      "http://localhost:8792/site-studio/x",
      SITE_STUDIO_CSRF_COOKIE_PATH
    );
    expect(setCookie).toContain("cail_csrf_sitestudio=");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain("Path=/site-studio");
    expect(setCookie).not.toContain("Secure");
  });

  it("keeps /site-studio scope on non-loopback http origins", async () => {
    const setCookie = await setCookieHeader(
      "http://site-studio.test/site-studio/x",
      SITE_STUDIO_CSRF_COOKIE_PATH
    );
    expect(setCookie).toContain("Path=/site-studio");
  });

  it("keeps the cookie out of a hostile /sites page's browser path scope", async () => {
    const setCookie = await setCookieHeader(
      "https://tools.ailab.gc.cuny.edu/site-studio/api/csrf",
      SITE_STUDIO_CSRF_COOKIE_PATH
    );
    expect(setCookie).toMatch(/(?:^|;\s*)Path=\/site-studio(?:;|$)/);
    expect(setCookie).not.toMatch(/(?:^|;\s*)Path=\/(?:;|$)/);
    expect("/sites/attacker/index.html".startsWith(SITE_STUDIO_CSRF_COOKIE_PATH)).toBe(false);
  });

  it("pins the checked-in Wrangler production value to /site-studio", () => {
    const config = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
    expect(config).toMatch(/"CSRF_COOKIE_PATH"\s*:\s*"\/site-studio"/);
    expect(config).not.toMatch(/"CSRF_COOKIE_PATH"\s*:\s*"\/"/);
  });
});

describe("timingSafeEqual", () => {
  it("matches equal strings and rejects mismatches and length differences", () => {
    expect(timingSafeEqual(TOKEN, TOKEN)).toBe(true);
    expect(timingSafeEqual(TOKEN, "b".repeat(64))).toBe(false);
    expect(timingSafeEqual(TOKEN, TOKEN.slice(0, 63))).toBe(false);
    expect(timingSafeEqual("", TOKEN)).toBe(false);
  });
});

describe("verifyWsUpgrade (rule 4)", () => {
  const base = {
    requestOrigin: REQUEST_ORIGIN,
    appPublicDomain: APP_PUBLIC_DOMAIN,
    presentedToken: TOKEN,
    expectedToken: TOKEN
  };

  it("accepts own-origin + valid token", () => {
    expect(verifyWsUpgrade({ ...base, origin: REQUEST_ORIGIN })).toBe(true);
  });

  it("accepts APP_PUBLIC_DOMAIN origin + valid token", () => {
    expect(verifyWsUpgrade({ ...base, origin: APP_PUBLIC_DOMAIN })).toBe(true);
  });

  it("rejects a foreign origin even with a valid token", () => {
    expect(verifyWsUpgrade({ ...base, origin: "https://evil.example" })).toBe(false);
  });

  it("accepts an absent origin only because the token is valid", () => {
    expect(verifyWsUpgrade({ ...base, origin: null })).toBe(true);
    expect(verifyWsUpgrade({ ...base, origin: null, presentedToken: null })).toBe(false);
    expect(verifyWsUpgrade({ ...base, origin: null, presentedToken: "b".repeat(64) })).toBe(false);
  });

  it("rejects a valid origin without a token", () => {
    expect(verifyWsUpgrade({ ...base, origin: REQUEST_ORIGIN, presentedToken: null })).toBe(false);
    expect(verifyWsUpgrade({ ...base, origin: REQUEST_ORIGIN, expectedToken: null })).toBe(false);
  });

  it("accepts a valid-token upgrade across loopback dev-server ports", () => {
    expect(verifyWsUpgrade({
      ...base,
      requestOrigin: "http://localhost:8792",
      origin: "http://localhost:5173"
    })).toBe(true);
  });

  it("rejects a loopback browser origin when the worker origin is production", () => {
    expect(verifyWsUpgrade({
      ...base,
      requestOrigin: "https://tools.ailab.gc.cuny.edu",
      origin: "http://localhost:5173"
    })).toBe(false);
  });

  it("rejects loopback origins when the token is bad", () => {
    expect(verifyWsUpgrade({
      ...base,
      requestOrigin: "http://localhost:8792",
      origin: "http://127.0.0.1:5173",
      presentedToken: "b".repeat(64)
    })).toBe(false);
  });

  it("does not treat a localhost-looking hostile hostname as loopback", () => {
    expect(isLoopbackOrigin("http://localhost.evil.com:5173")).toBe(false);
    expect(verifyWsUpgrade({
      ...base,
      requestOrigin: "http://localhost:8792",
      origin: "http://localhost.evil.com:5173"
    })).toBe(false);
  });
});

describe("csrfProtect middleware", () => {
  function buildApp(userId?: string) {
    const app = new Hono<{ Bindings: Env; Variables: { user: { id: string } } }>();
    if (userId) {
      app.use("*", async (c, next) => {
        c.set("user", { id: userId });
        await next();
      });
    }
    app.use("*", csrfProtect);
    app.get("/api/thing", (c) => c.json({ read: true }));
    app.post("/api/thing", (c) => c.json({ wrote: true }));
    app.options("/api/thing", (c) => c.body(null, 204));
    return app;
  }

  const env = (bucket: R2Bucket) => ({ SITE_STUDIO_BUCKET: bucket, APP_PUBLIC_DOMAIN }) as unknown as Env;

  it("no-ops on GET and OPTIONS", async () => {
    const bucket = createCsrfBucket();
    const app = buildApp(ROUTE_USER);

    const get = await app.request(`${REQUEST_ORIGIN}/api/thing`, {}, env(bucket));
    expect(get.status).toBe(200);

    const options = await app.request(`${REQUEST_ORIGIN}/api/thing`, { method: "OPTIONS" }, env(bucket));
    expect(options.status).toBe(204);
  });

  it("rejects a tokenless POST with the exact 403 envelope", async () => {
    const bucket = createCsrfBucket();
    const app = buildApp(ROUTE_USER);

    const res = await app.request(`${REQUEST_ORIGIN}/api/thing`, { method: "POST" }, env(bucket));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual(CSRF_ERROR_BODY);
  });

  it("accepts a POST with a valid token + same-origin posture", async () => {
    const bucket = createCsrfBucket();
    const { headers } = await mintCsrfSession(bucket, ROUTE_USER);
    const app = buildApp(ROUTE_USER);

    const res = await app.request(`${REQUEST_ORIGIN}/api/thing`, { method: "POST", headers }, env(bucket));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ wrote: true });
  });

  it("rejects a valid token when Sec-Fetch-Site says cross-site", async () => {
    const bucket = createCsrfBucket();
    const { token } = await mintCsrfSession(bucket, ROUTE_USER);
    const app = buildApp(ROUTE_USER);

    const res = await app.request(
      `${REQUEST_ORIGIN}/api/thing`,
      { method: "POST", headers: { [CSRF_HEADER_NAME]: token, "Sec-Fetch-Site": "cross-site" } },
      env(bucket)
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual(CSRF_ERROR_BODY);
  });

  it("fails closed when no session user is in scope", async () => {
    const bucket = createCsrfBucket();
    const { headers } = await mintCsrfSession(bucket, ROUTE_USER);
    const app = buildApp(undefined);

    const res = await app.request(`${REQUEST_ORIGIN}/api/thing`, { method: "POST", headers }, env(bucket));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual(CSRF_ERROR_BODY);
  });
});
