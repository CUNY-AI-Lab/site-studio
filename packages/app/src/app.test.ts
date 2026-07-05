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
  return {
    head: vi.fn(async () => null),
    get: vi.fn(async () => null),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ objects: [], truncated: false, delimitedPrefixes: [] }))
  } as unknown as R2Bucket;
}

let kv: MockKV;

function createEnv(): Env {
  return {
    SESSION_KV: kv,
    SITE_STUDIO_BUCKET: createMockBucket(),
    SITE_BUILDER_AGENT: {} as Env["SITE_BUILDER_AGENT"],
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

beforeEach(() => {
  kv = createMockKV();
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
    expect(res.status).toBe(200);

    const setCookie = res.headers.get("set-cookie") || "";
    expect(setCookie).toContain("site-studio-session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
  });
});

describe("GET /api/csrf", () => {
  it("returns a stable 64-hex token for the same session", async () => {
    const first = await app.request(`${BASE}/api/csrf`, {}, createEnv());
    expect(first.status).toBe(200);
    const { token } = (await first.json()) as { token: string };
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const cookie = sessionCookie(first);
    const second = await app.request(`${BASE}/api/csrf`, { headers: { Cookie: cookie } }, createEnv());
    await expect(second.json()).resolves.toEqual({ token });
  });

  it("returns different tokens for different sessions", async () => {
    const a = await app.request(`${BASE}/api/csrf`, {}, createEnv());
    const b = await app.request(`${BASE}/api/csrf`, {}, createEnv());

    const { token: tokenA } = (await a.json()) as { token: string };
    const { token: tokenB } = (await b.json()) as { token: string };
    expect(tokenA).not.toBe(tokenB);
  });
});

describe("full-chain CSRF enforcement through the real middleware stack", () => {
  it("403s a session-authenticated mutation without the token, accepts it with token + same-origin", async () => {
    // Establish a session and its token exactly as the frontend does.
    const bootstrap = await app.request(`${BASE}/api/csrf`, {}, createEnv());
    const cookie = sessionCookie(bootstrap);
    const { token } = (await bootstrap.json()) as { token: string };

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
