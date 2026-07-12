import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./types";
import { CSRF_ERROR_BODY, CSRF_HEADER_NAME } from "./lib/csrf";
import { createMockKV, type MockKV } from "./lib/test-utils";

// app.ts mounts the agent router, whose `agents` dependency imports
// `cloudflare:`-scheme modules; stub it so the full app is importable here.
vi.mock("agents", () => ({
  getAgentByName: vi.fn(async () => ({
    fetch: async () => new Response("{}", { status: 200 }),
    getObservability: async () => ({ calls: [] })
  }))
}));

import app from "./app";

const BASE = "https://site-studio.example";
const ALLOWED_ORIGIN = "https://tools.ailab.gc.cuny.edu";

function createMockBucket(): R2Bucket {
  const store = new Map<string, string>();
  return {
    head: vi.fn(async (key: string) => (store.has(key) ? { key } : null)),
    get: vi.fn(async (key: string) => {
      const value = store.get(key);
      return value === undefined ? null : { key, text: async () => value };
    }),
    put: vi.fn(async (key: string, value: string, options?: R2PutOptions) => {
      if (options?.onlyIf && "etagDoesNotMatch" in options.onlyIf && options.onlyIf.etagDoesNotMatch === "*" && store.has(key)) {
        return null;
      }
      store.set(key, value);
      return { key, etag: `${key}:1` };
    }),
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ objects: [], truncated: false, delimitedPrefixes: [] }))
  } as unknown as R2Bucket;
}

let kv: MockKV;
let bucket: R2Bucket;

function createEnv(): Env {
  return {
    SESSION_KV: kv,
    SITE_STUDIO_BUCKET: bucket,
    SITE_BUILDER_AGENT: {} as Env["SITE_BUILDER_AGENT"],
    MIGRATION_COORDINATOR: {} as Env["MIGRATION_COORDINATOR"],
    LOADER: {} as WorkerLoader,
    ASSETS: undefined
  };
}

function sessionCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie") || "";
  const match = /site-studio-session=([^;]+)/.exec(setCookie);
  if (!match) {
    throw new Error(`No session cookie in: ${setCookie}`);
  }
  return `site-studio-session=${match[1]}`;
}

/** The CSRF token now delivered via the cail_csrf_sitestudio Set-Cookie. */
function csrfCookieToken(res: Response): string {
  const setCookie = res.headers.get("set-cookie") || "";
  const match = /cail_csrf_sitestudio=([^;]+)/.exec(setCookie);
  if (!match) {
    throw new Error(`No csrf cookie in: ${setCookie}`);
  }
  return match[1];
}

/**
 * The csrf cookie's own segment (attrs up to the next cookie), so attribute
 * assertions don't accidentally match the session cookie's attrs. Set-Cookie
 * combines multiple cookies comma-separated in this test harness.
 */
function csrfCookieSegment(res: Response): string {
  const setCookie = res.headers.get("set-cookie") || "";
  const start = setCookie.indexOf("cail_csrf_sitestudio=");
  if (start === -1) {
    throw new Error(`No csrf cookie in: ${setCookie}`);
  }
  const rest = setCookie.slice(start);
  // The next cookie begins after ", <name>=" — split on the comma that
  // precedes another cookie name (attrs never contain "name=").
  const nextCookie = /,\s*[^;,\s]+=/.exec(rest);
  return nextCookie ? rest.slice(0, nextCookie.index) : rest;
}

beforeEach(() => {
  kv = createMockKV();
  bucket = createMockBucket();
});

describe("CORS allowlist (rule 5)", () => {
  it("sends NO access-control-allow-origin to a non-allowlisted origin on a credentialed route", async () => {
    const res = await app.request(
      `${BASE}/api/health`,
      { headers: { Origin: "https://evil.example" } },
      createEnv()
    );

    expect(res.status).toBe(200);
    // A credentialed allowlist must never reflect unknown origins (and never
    // wildcard): the header must be absent entirely.
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("echoes an allowlisted origin with credentials", async () => {
    const res = await app.request(
      `${BASE}/api/health`,
      { headers: { Origin: ALLOWED_ORIGIN } },
      createEnv()
    );

    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("keeps CORS preflights open (OPTIONS is never CSRF-gated)", async () => {
    const res = await app.request(
      `${BASE}/api/projects`,
      {
        method: "OPTIONS",
        headers: {
          Origin: ALLOWED_ORIGIN,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": CSRF_HEADER_NAME
        }
      },
      createEnv()
    );

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
  });
});

describe("session cookie posture (rule 7)", () => {
  it("pins HttpOnly + Secure + SameSite=Strict on the session cookie", async () => {
    const res = await app.request(`${BASE}/api/csrf`, {}, createEnv());
    expect(res.status).toBe(204);

    const setCookie = res.headers.get("set-cookie") || "";
    expect(setCookie).toContain("site-studio-session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
  });
});

describe("GET /api/csrf (rule 3 cookie delivery)", () => {
  it("delivers the token via a path-scoped, non-HttpOnly Set-Cookie and NOT in the body", async () => {
    const res = await app.request(`${BASE}/api/csrf`, {}, createEnv());
    // No token in the body: 204, empty body.
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");

    const segment = csrfCookieSegment(res);
    expect(segment).toContain("cail_csrf_sitestudio=");
    // Secure + SameSite=Lax + Path present; NOT HttpOnly (page JS must read it).
    expect(segment).toContain("Secure");
    expect(segment).toContain("SameSite=Lax");
    expect(segment).toContain("Path=/");
    expect(segment).not.toContain("HttpOnly");

    expect(csrfCookieToken(res)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("delivers a stable token for the same session", async () => {
    const first = await app.request(`${BASE}/api/csrf`, {}, createEnv());
    const token = csrfCookieToken(first);
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const cookie = sessionCookie(first);
    const second = await app.request(`${BASE}/api/csrf`, { headers: { Cookie: cookie } }, createEnv());
    expect(csrfCookieToken(second)).toBe(token);
  });

  it("delivers different tokens for different sessions", async () => {
    const a = await app.request(`${BASE}/api/csrf`, {}, createEnv());
    const b = await app.request(`${BASE}/api/csrf`, {}, createEnv());
    expect(csrfCookieToken(a)).not.toBe(csrfCookieToken(b));
  });
});

describe("full-chain CSRF enforcement through the real middleware stack", () => {
  it("403s a session-authenticated mutation without the token, accepts it with token + same-origin", async () => {
    // Establish a session and its token exactly as the frontend does: read the
    // token out of the delivery cookie, not a response body.
    const bootstrap = await app.request(`${BASE}/api/csrf`, {}, createEnv());
    const cookie = sessionCookie(bootstrap);
    const token = csrfCookieToken(bootstrap);

    const blocked = await app.request(
      `${BASE}/api/projects`,
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "my site" })
      },
      createEnv()
    );
    expect(blocked.status).toBe(403);
    await expect(blocked.json()).resolves.toEqual(CSRF_ERROR_BODY);

    const allowed = await app.request(
      `${BASE}/api/projects`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
          [CSRF_HEADER_NAME]: token,
          "Sec-Fetch-Site": "same-origin"
        },
        body: JSON.stringify({ name: "my site" })
      },
      createEnv()
    );
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({ id: "my-site", name: "my site" });
  });

  it("403s a WebSocket upgrade without a valid token before any project resolution", async () => {
    const bootstrap = await app.request(`${BASE}/api/csrf`, {}, createEnv());
    const cookie = sessionCookie(bootstrap);

    const res = await app.request(
      `${BASE}/api/agents/site-builder/some-project`,
      { headers: { Cookie: cookie, Upgrade: "websocket", Origin: BASE } },
      createEnv()
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual(CSRF_ERROR_BODY);
  });
});
