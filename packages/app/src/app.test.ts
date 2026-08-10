import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CAIL_CANONICAL_ISSUER } from "@cuny-ai-lab/cail-identity";
import {
  canonicalTestSubject,
  createTestIdentityIssuer,
  type TestIdentityIssuer,
} from "@cuny-ai-lab/cail-identity/testing";
import type { Env } from "./types";
import { CSRF_ERROR_BODY, CSRF_HEADER_NAME } from "./lib/csrf";
import { createMockKV, createMockMutationCoordinator, type MockKV } from "./lib/test-utils";

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
const ALLOWED_ORIGIN = "https://cail-doorway.ailab-452.workers.dev";

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
let identityIssuer: TestIdentityIssuer;

beforeAll(async () => {
  identityIssuer = await createTestIdentityIssuer({
    kid: "app-test",
    issuer: CAIL_CANONICAL_ISSUER,
  });
});

async function identityHeaders(label = "app-test-user"): Promise<Record<string, string>> {
  const token = await identityIssuer.mintIdentityJwt({
    audience: "cail:site-studio",
    subject: canonicalTestSubject(label),
    expiresInSeconds: 300,
  });
  return { "X-CAIL-Identity-JWT": token };
}

function createEnv(): Env {
  return {
    CAIL_LOG_ENV: "test",
    CAIL_IDENTITY_JWKS: identityIssuer.jwksJson,
    CAIL_IDENTITY_ISSUER: CAIL_CANONICAL_ISSUER,
    SESSION_KV: kv,
    SITE_STUDIO_BUCKET: bucket,
    SITE_BUILDER_AGENT: {} as Env["SITE_BUILDER_AGENT"],
    MIGRATION_COORDINATOR: {} as Env["MIGRATION_COORDINATOR"],
    MUTATION_COORDINATOR: createMockMutationCoordinator(bucket),
    LOADER: {} as WorkerLoader,
    CSRF_COOKIE_PATH: "/site-studio",
    ASSETS: undefined
  };
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

describe("retired public routes", () => {
  it("returns 404 for /sites instead of falling through to the SPA asset", async () => {
    const assetFetch = vi.fn(async () => new Response("SPA", { status: 200 }));
    const env = createEnv();
    env.ASSETS = { fetch: assetFetch } as unknown as Fetcher;

    const response = await app.request(`${BASE}/sites/legacy-owner/site/`, {}, env);

    expect(response.status).toBe(404);
    expect(assetFetch).not.toHaveBeenCalled();
  });
});

describe("mounted SPA assets", () => {
  it("strips the configured mount before forwarding root and nested assets", async () => {
    const requestedPaths: string[] = [];
    const assetFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      requestedPaths.push(path);
      return path === "/"
        ? new Response("<html>Site Studio</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          })
        : new Response("export const ready = true;", {
            status: 200,
            headers: { "content-type": "application/javascript" },
          });
    });
    const env = createEnv();
    env.ASSETS = { fetch: assetFetch } as unknown as Fetcher;

    const root = await app.request(`${BASE}/site-studio/`, {}, env);
    const asset = await app.request(
      `${BASE}/site-studio/_app/immutable/entry/start.js`,
      {},
      env,
    );

    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/html");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("application/javascript");
    expect(requestedPaths).toEqual(["/", "/_app/immutable/entry/start.js"]);
  });
});

describe("subject session retirement", () => {
  it("does not mint a subject session cookie after identity auth", async () => {
    const res = await app.request(`${BASE}/api/csrf`, { headers: await identityHeaders() }, createEnv());
    expect(res.status).toBe(204);

    const setCookie = res.headers.get("set-cookie") || "";
    expect(setCookie).not.toContain("site-studio-session=");
  });
});

describe("GET /api/csrf (rule 3 cookie delivery)", () => {
  it("delivers the token via a path-scoped, non-HttpOnly Set-Cookie and NOT in the body", async () => {
    const res = await app.request(`${BASE}/api/csrf`, { headers: await identityHeaders() }, createEnv());
    // No token in the body: 204, empty body.
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");

    const segment = csrfCookieSegment(res);
    expect(segment).toContain("cail_csrf_sitestudio=");
    // Secure + SameSite=Lax + Path present; NOT HttpOnly (page JS must read it).
    expect(segment).toContain("Secure");
    expect(segment).toContain("SameSite=Lax");
    expect(segment).toContain("Path=/site-studio");
    expect(segment).not.toMatch(/(?:^|;\s*)Path=\/(?:;|$)/);
    expect(segment).not.toContain("HttpOnly");

    expect(csrfCookieToken(res)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("delivers a stable token for the same verified identity", async () => {
    const headers = await identityHeaders();
    const env = createEnv();
    const first = await app.request(`${BASE}/api/csrf`, { headers }, env);
    const token = csrfCookieToken(first);
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const second = await app.request(`${BASE}/api/csrf`, { headers }, env);
    expect(csrfCookieToken(second)).toBe(token);
  });

  it("delivers different tokens for different verified identities", async () => {
    const a = await app.request(`${BASE}/api/csrf`, { headers: await identityHeaders("csrf-a") }, createEnv());
    const b = await app.request(`${BASE}/api/csrf`, { headers: await identityHeaders("csrf-b") }, createEnv());
    expect(csrfCookieToken(a)).not.toBe(csrfCookieToken(b));
  });
});

describe("full-chain CSRF enforcement through the real middleware stack", () => {
  it("403s an identity-authenticated mutation without the token, accepts it with token + same-origin", async () => {
    // Establish an identity's token exactly as the frontend does: read the
    // token out of the delivery cookie, not a response body.
    const identity = await identityHeaders();
    const env = createEnv();
    const bootstrap = await app.request(`${BASE}/api/csrf`, { headers: identity }, env);
    const token = csrfCookieToken(bootstrap);

    const blocked = await app.request(
      `${BASE}/api/projects`,
      {
        method: "POST",
        headers: { ...identity, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "my site" })
      },
      env
    );
    expect(blocked.status).toBe(403);
    await expect(blocked.json()).resolves.toEqual(CSRF_ERROR_BODY);

    const allowed = await app.request(
      `${BASE}/api/projects`,
      {
        method: "POST",
        headers: {
          ...identity,
          "Content-Type": "application/json",
          [CSRF_HEADER_NAME]: token,
          "Sec-Fetch-Site": "same-origin"
        },
        body: JSON.stringify({ name: "my site" })
      },
      env
    );
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({ id: "my-site", name: "my site" });
  });

  it("403s a WebSocket upgrade without a valid token before any project resolution", async () => {
    const identity = await identityHeaders();
    const env = createEnv();
    await app.request(`${BASE}/api/csrf`, { headers: identity }, env);

    const res = await app.request(
      `${BASE}/api/agents/site-builder/some-project`,
      { headers: { ...identity, Upgrade: "websocket", Origin: BASE } },
      env
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual(CSRF_ERROR_BODY);
  });
});
