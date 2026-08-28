import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../types";
import { CSRF_ERROR_BODY, csrfProtect } from "../lib/csrf";
import {
  createMockKV,
  createStoredR2Body,
  createStoredR2Object,
  mintCsrfSession,
  type CsrfSession,
} from "../lib/test-utils";
import { TEST_SUBJECTS } from "@cuny-ai-lab/cail-identity/testing";
import { SITE_STUDIO_VERIFIED_OPERATIONAL_SUBJECT_HEADER } from "../lib/logging";
import { SITE_STUDIO_AGENT_PROPS_HEADER } from "../lib/agent-identity";
import { ACTION_ATTEMPT_ADMIN_SCHEMA_VERSION, ACTION_ATTEMPT_RETENTION_HOURS } from "../../../observability-core/src/action-attempt";
import { z } from "zod";

import { createAgentRouter } from "./agents";
import type { AgentResolver } from "./agents";

const USER_ID = TEST_SUBJECTS.alice;
const PROJECT_ID = "proj-1";
const OPERATIONAL_SUBJECT = "cail-v1-0123456789abcdef0123456789abcdef";
const OWN_ORIGIN = "https://site-studio.example";
const APP_PUBLIC_DOMAIN = "https://tools.ailab.gc.cuny.edu";
type AgentFetchState = { lastRequest: Request | null };
const forwardedUrlSchema = z.object({ forwardedUrl: z.string() });

function createMockBucket(): R2Bucket {
  const store = new Map<string, string>([[
    `projects/${USER_ID}/${PROJECT_ID}/.metadata.json`,
    JSON.stringify({
      id: PROJECT_ID,
      name: "Test project",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      published: false,
    }),
  ]]);
  // SAFETY: This fixture implements the R2 methods exercised by
  // R2ProjectStorage.projectExists and intentionally omits unrelated bindings.
  const fixture = {
    head: vi.fn(async (key: string) => (store.has(key) ? { key, size: 0 } : null)),
    get: vi.fn(async (key: string) => {
      const value = store.get(key);
      return value === undefined ? null : createStoredR2Body(key, value);
    }),
    put: vi.fn(async (key: string, value: string, _options?: R2PutOptions) => {
      store.set(key, value);
      return createStoredR2Object(key);
    }),
    list: vi.fn(async () => ({ objects: [], truncated: false, delimitedPrefixes: [] })),
    delete: vi.fn(async () => undefined),
    createMultipartUpload: vi.fn(async () => { throw new Error("multipart upload is not part of this fixture"); }),
    resumeMultipartUpload: vi.fn(() => { throw new Error("multipart upload is not part of this fixture"); }),
  };
  // SAFETY: This fixture implements the R2 methods exercised by
  // R2ProjectStorage.projectExists and intentionally omits unrelated bindings.
  return fixture as R2Bucket;
}

describe("agent route WebSocket gate (rule 4)", () => {
  let kv: ReturnType<typeof createMockKV>;
  let bucket: R2Bucket;
  let csrf: CsrfSession;
  let resolveAgent: ReturnType<typeof vi.fn<AgentResolver>>;
  let agentFetch: AgentFetchState;
  let app: Hono<{
    Bindings: Env;
    Variables: { user: { id: string; operationalSubject?: string }; cailGatewayJwt?: string };
  }>;

  const env = () => {
    const bindings = {
      SESSION_KV: kv,
      SITE_STUDIO_BUCKET: bucket,
      // SAFETY: The resolver is injected below; this namespace is an opaque
      // token that is never invoked by the test.
      SITE_BUILDER_AGENT: {} as Env["SITE_BUILDER_AGENT"],
      // SAFETY: The migration coordinator is not reached by the agent route.
      MIGRATION_COORDINATOR: {} as Env["MIGRATION_COORDINATOR"],
      // SAFETY: The worker loader is not reached by the agent route.
      LOADER: {} as WorkerLoader,
      APP_PUBLIC_DOMAIN
    } satisfies Pick<Env, "SESSION_KV" | "SITE_STUDIO_BUCKET" | "SITE_BUILDER_AGENT" | "MIGRATION_COORDINATOR" | "LOADER" | "APP_PUBLIC_DOMAIN">;
    // SAFETY: This test supplies the bindings reached by the agent router;
    // identity/session fields are installed by the middleware above.
    return bindings as Env;
  };

  beforeEach(async () => {
    kv = createMockKV();
    bucket = createMockBucket();
    csrf = await mintCsrfSession(bucket, USER_ID);
    agentFetch = { lastRequest: null } satisfies AgentFetchState;
    resolveAgent = vi.fn<AgentResolver>(async () => ({
      fetch: async (req: Request) => {
        agentFetch.lastRequest = req;
        if (new URL(req.url).pathname.endsWith("/refresh-credential")) {
          return new Response(null, {
            status: 204,
            headers: { "Cache-Control": "no-store" },
          });
        }
        return new Response(JSON.stringify({
          forwardedUrl: req.url,
          forwardedOperationalSubject: req.headers.get("x-site-studio-verified-operational-subject"),
          forwardedIdentityJwt: req.headers.get(SITE_STUDIO_AGENT_PROPS_HEADER),
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      },
      getObservability: async () => ({
        generatedAt: new Date().toISOString(),
        actionAttempts: {
          schemaVersion: ACTION_ATTEMPT_ADMIN_SCHEMA_VERSION,
          authoritative: true,
          retentionHours: ACTION_ATTEMPT_RETENTION_HOURS,
          attempts: [],
        },
        requests: [],
        events: [],
      }),
    }));
    app = new Hono<{
      Bindings: Env;
      Variables: { user: { id: string; operationalSubject?: string }; cailGatewayJwt?: string };
    }>();
    app.use("*", async (c, next) => {
      c.set("user", { id: USER_ID, operationalSubject: OPERATIONAL_SUBJECT });
      c.set("cailGatewayJwt", "verified-token");
      await next();
    });
    app.use("/api/*", csrfProtect);
    app.route("/", createAgentRouter(resolveAgent));
  });

  const upgrade = (query: string, headers: Record<string, string>) =>
    app.request(
      `${OWN_ORIGIN}/api/agents/site-builder/${PROJECT_ID}${query}`,
      { headers: { Upgrade: "websocket", ...headers } },
      env()
    );

  it("accepts an upgrade with own-origin Origin + valid ?csrf and strips the token before forwarding", async () => {
    const res = await upgrade(`?csrf=${csrf.token}&foo=bar`, { Origin: OWN_ORIGIN });
    expect(res.status).toBe(200);
    const body = forwardedUrlSchema.parse(await res.json());
    // Token never reaches the Durable Object; other params survive.
    expect(body.forwardedUrl).not.toContain("csrf=");
    expect(body.forwardedUrl).toContain("foo=bar");
  });

  it("accepts an upgrade with the canonical APP_PUBLIC_DOMAIN Origin + valid token", async () => {
    const res = await upgrade(`?csrf=${csrf.token}`, { Origin: APP_PUBLIC_DOMAIN });
    expect(res.status).toBe(200);
  });

  it("rejects an upgrade from a foreign Origin even with a valid token", async () => {
    const res = await upgrade(`?csrf=${csrf.token}`, { Origin: "https://evil.example" });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual(CSRF_ERROR_BODY);
  });

  it("rejects an upgrade with a bad token", async () => {
    const res = await upgrade(`?csrf=${"b".repeat(64)}`, { Origin: OWN_ORIGIN });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual(CSRF_ERROR_BODY);
  });

  it("rejects an upgrade with no token at all", async () => {
    const res = await upgrade("", { Origin: OWN_ORIGIN });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual(CSRF_ERROR_BODY);
  });

  it("accepts an absent Origin (non-browser client) only with a valid token", async () => {
    const ok = await upgrade(`?csrf=${csrf.token}`, {});
    expect(ok.status).toBe(200);

    const bad = await upgrade("", {});
    expect(bad.status).toBe(403);
    await expect(bad.json()).resolves.toEqual(CSRF_ERROR_BODY);
  });

  it("gates the upgrade before project resolution (bad token 403s even for a missing project)", async () => {
    const res = await app.request(
      `${OWN_ORIGIN}/api/agents/site-builder/nonexistent`,
      { headers: { Upgrade: "websocket", Origin: OWN_ORIGIN } },
      env()
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual(CSRF_ERROR_BODY);
  });

  it("leaves non-upgrade GETs (chat history) ungated by the WS check", async () => {
    const res = await app.request(
      `${OWN_ORIGIN}/api/agents/site-builder/${PROJECT_ID}/get-messages`,
      {},
      env()
    );
    expect(res.status).toBe(200);
    const body = forwardedUrlSchema.parse(await res.json());
    expect(body.forwardedUrl).toContain("/get-messages");
  });

  it("forwards the middleware-selected identity token in agent props", async () => {
    const res = await app.request(
      `${OWN_ORIGIN}/api/agents/site-builder/${PROJECT_ID}/get-messages`,
      {
        headers: {
          "X-CAIL-Identity-JWT": "unverified-raw-token",
          [SITE_STUDIO_VERIFIED_OPERATIONAL_SUBJECT_HEADER]: "client-chosen-subject",
          [SITE_STUDIO_AGENT_PROPS_HEADER]: JSON.stringify({ identityJwt: "client-chosen-token" }),
        },
      },
      env()
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      forwardedOperationalSubject: OPERATIONAL_SUBJECT,
      forwardedIdentityJwt: JSON.stringify({ identityJwt: "verified-token" }),
    });
    expect(resolveAgent).toHaveBeenLastCalledWith(
      expect.anything(),
      `${USER_ID}:${PROJECT_ID}`,
      {
        props: {
          userId: USER_ID,
          projectId: PROJECT_ID,
          identityJwt: "verified-token",
          operationalSubject: OPERATIONAL_SUBJECT,
        },
      }
    );
  });

  it("refreshes the same agent through a CSRF-protected POST without returning props", async () => {
    const res = await app.request(
      `${OWN_ORIGIN}/api/agents/site-builder/${PROJECT_ID}/refresh-credential`,
      {
        method: "POST",
        headers: {
          ...csrf.headers,
          [SITE_STUDIO_AGENT_PROPS_HEADER]: JSON.stringify({ identityJwt: "caller-chosen-token" }),
        },
      },
      env()
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("");
    expect(agentFetch.lastRequest?.headers.get(SITE_STUDIO_AGENT_PROPS_HEADER)).toBe(
      JSON.stringify({ identityJwt: "verified-token" })
    );
  });

  it("rejects the refresh POST before the agent when CSRF is missing", async () => {
    const res = await app.request(
      `${OWN_ORIGIN}/api/agents/site-builder/${PROJECT_ID}/refresh-credential`,
      { method: "POST" },
      env()
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual(CSRF_ERROR_BODY);
    expect(agentFetch.lastRequest).toBeNull();
  });
});
