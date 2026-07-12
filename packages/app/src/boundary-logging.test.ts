/**
 * Fleet logging standard (cail-log) at the worker fetch boundary.
 *
 * Pins the adoption contract:
 *  - ONE wide `request.completed` / `auth.denied` event per request, emitted
 *    as a single JSON object on console.log (the Workers Logs sink);
 *  - the event carries ONLY the typed safe-to-log allowlist — subject
 *    (pseudonymous, never email), correlation ids, classified route, method,
 *    status, outcome, duration — and NO content/PII: no query strings, no
 *    header values, no prompts, no emails;
 *  - inbound `traceparent` / `X-CAIL-Request-Id` are ADOPTED, not regenerated;
 *  - outbound gateway calls carry the same correlation headers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./types";
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
import {
  errorCodeFrom,
  mintCorrelation,
  outcomeForStatus,
  withCorrelationFetch
} from "./lib/logging";

const BASE = "https://site-studio.example";

/** Every key the emitted wide event may carry (the cail-log allowlist). */
const ALLOWED_EVENT_KEYS = new Set([
  "timestamp",
  "severity_text",
  "severity_number",
  "event",
  "message",
  "service",
  "release",
  "env",
  "subject",
  "request_id",
  "trace_id",
  "span_id",
  "principal_type",
  "key_id",
  "app",
  "http_method",
  "route",
  "model",
  "status",
  "outcome",
  "duration_ms",
  "upstream_ms",
  "error_code",
  "retry_count",
  "req_bytes",
  "resp_bytes",
  "input_tokens",
  "output_tokens",
  "quota"
]);

const NEVER_LOG_KEYS = [
  "email",
  "given_name",
  "family_name",
  "sub",
  "prompt",
  "messages",
  "completion",
  "content",
  "input",
  "output",
  "body",
  "authorization",
  "cookie",
  "token",
  "secret",
  "password",
  "api_key"
];

function createMockBucket(): R2Bucket {
  const store = new Map<string, string>();
  return {
    head: vi.fn(async (key: string) => (store.has(key) ? { key } : null)),
    get: vi.fn(async (key: string) => {
      const value = store.get(key);
      return value === undefined ? null : { key, text: async () => value };
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return { key, etag: `${key}:1` };
    }),
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ objects: [], truncated: false, delimitedPrefixes: [] }))
  } as unknown as R2Bucket;
}

let kv: MockKV;
let bucket: R2Bucket;

function createEnv(extra?: Partial<Env>): Env {
  return {
    SESSION_KV: kv,
    SITE_STUDIO_BUCKET: bucket,
    SITE_BUILDER_AGENT: {} as Env["SITE_BUILDER_AGENT"],
    MIGRATION_COORDINATOR: {} as Env["MIGRATION_COORDINATOR"],
    LOADER: {} as WorkerLoader,
    ASSETS: undefined,
    ...extra
  };
}

/** Capture cail-log wide events (single JSON objects on console.log). */
function captureLog() {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  return {
    lines(): string[] {
      return spy.mock.calls
        .map(([line]) => (typeof line === "string" ? line : ""))
        .filter((line) => line.startsWith("{"));
    },
    events(): Array<Record<string, unknown>> {
      return this.lines()
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter(
          (event): event is Record<string, unknown> =>
            !!event && typeof event === "object" && "event" in event
        );
    },
    restore() {
      spy.mockRestore();
    }
  };
}

beforeEach(() => {
  kv = createMockKV();
  bucket = createMockBucket();
});

describe("request-boundary wide event", () => {
  it("emits exactly ONE request.completed event with the allowlist shape and no content/PII", async () => {
    const traceId = "0af7651916cd43dd8448eb211c80319c";
    const inboundRequestId = "req-fixed-0001";
    const capture = captureLog();
    try {
      const res = await app.request(
        `${BASE}/api/health?q=SENSITIVE-QUERY-VALUE`,
        {
          headers: {
            traceparent: `00-${traceId}-b7ad6b7169203331-01`,
            "x-cail-request-id": inboundRequestId,
            // Junk credential: must never appear in any emitted byte.
            "X-CAIL-Identity-JWT": "SECRET-JWT-VALUE"
          }
        },
        createEnv()
      );
      expect(res.status).toBe(200);

      const completed = capture.events().filter((event) => event.event === "request.completed");
      expect(completed).toHaveLength(1);
      const event = completed[0]!;

      // Shape: allowlist fields only, correctly classified.
      expect(event.service).toBe("site-studio");
      expect(event.severity_text).toBe("INFO");
      expect(event.severity_number).toBe(9);
      expect(event.http_method).toBe("GET");
      expect(event.route).toBe("/api/health");
      expect(event.status).toBe(200);
      expect(event.outcome).toBe("ok");
      expect(typeof event.duration_ms).toBe("number");
      expect(typeof event.timestamp).toBe("string");

      // Correlation: ADOPTED from the inbound headers, never regenerated.
      expect(event.trace_id).toBe(traceId);
      expect(event.request_id).toBe(inboundRequestId);
      expect(event.span_id).toMatch(/^[0-9a-f]{16}$/);

      // Every key on the event is on the allowlist; NEVER-LOG keys are absent.
      for (const key of Object.keys(event)) {
        expect(ALLOWED_EVENT_KEYS.has(key), `unexpected event key: ${key}`).toBe(true);
      }
      for (const denied of NEVER_LOG_KEYS) {
        expect(event, `denied key present: ${denied}`).not.toHaveProperty(denied);
      }

      // No content/PII in ANY emitted byte: no query values, no header values,
      // no raw URL with query string.
      for (const line of capture.lines()) {
        expect(line).not.toContain("SENSITIVE-QUERY-VALUE");
        expect(line).not.toContain("SECRET-JWT-VALUE");
        expect(line).not.toContain("?q=");
      }
    } finally {
      capture.restore();
    }
  });

  it("keys the event by the pseudonymous subject (never an email)", async () => {
    const capture = captureLog();
    try {
      const res = await app.request(`${BASE}/api/projects`, {}, createEnv());
      expect(res.status).toBe(200);

      const completed = capture.events().filter((event) => event.event === "request.completed");
      expect(completed).toHaveLength(1);
      const subject = completed[0]!.subject;
      // Anonymous fallback session: the owner id, never an email address.
      expect(typeof subject).toBe("string");
      expect(subject as string).toMatch(/^user_/);
      expect(subject as string).not.toContain("@");
      expect(completed[0]!.route).toBe("/api/projects");
    } finally {
      capture.restore();
    }
  });

  it("emits auth.denied (outcome denied) when identity enforcement rejects the request", async () => {
    const capture = captureLog();
    try {
      const res = await app.request(
        `${BASE}/api/projects`,
        {},
        createEnv({ CAIL_REQUIRE_IDENTITY: "true" })
      );
      expect(res.status).toBe(401);

      const denied = capture.events().filter((event) => event.event === "auth.denied");
      expect(denied).toHaveLength(1);
      expect(denied[0]!.outcome).toBe("denied");
      expect(denied[0]!.status).toBe(401);
      // No request.completed duplicate: one wide event per unit of work.
      expect(capture.events().filter((event) => event.event === "request.completed")).toHaveLength(0);
    } finally {
      capture.restore();
    }
  });

  it("mints well-formed correlation ids when no inbound headers exist", async () => {
    const capture = captureLog();
    try {
      await app.request(`${BASE}/api/health`, {}, createEnv());
      const [event] = capture.events().filter((e) => e.event === "request.completed");
      expect(event!.trace_id).toMatch(/^[0-9a-f]{32}$/);
      expect(event!.span_id).toMatch(/^[0-9a-f]{16}$/);
      expect(typeof event!.request_id).toBe("string");
    } finally {
      capture.restore();
    }
  });
});

describe("logging helpers", () => {
  it("outcomeForStatus maps the fleet vocabulary", () => {
    expect(outcomeForStatus(200)).toBe("ok");
    expect(outcomeForStatus(304)).toBe("ok");
    expect(outcomeForStatus(400)).toBe("client_error");
    expect(outcomeForStatus(401)).toBe("denied");
    expect(outcomeForStatus(403)).toBe("denied");
    expect(outcomeForStatus(404)).toBe("client_error");
    expect(outcomeForStatus(500)).toBe("error");
    expect(outcomeForStatus(503)).toBe("error");
  });

  it("errorCodeFrom yields a stable slug from the error CLASS, never the message", () => {
    const boom = new Error("user@example.com typed a secret prompt");
    expect(errorCodeFrom(boom)).toBe("error");
    class QuotaExceededError extends Error {
      override name = "QuotaExceededError";
    }
    expect(errorCodeFrom(new QuotaExceededError("x"))).toBe("quotaexceedederror");
    expect(errorCodeFrom("not an error")).toBe("error");
    expect(errorCodeFrom(undefined)).toBe("error");
  });

  it("withCorrelationFetch stamps traceparent + x-cail-request-id on outbound gateway calls", async () => {
    const correlation = mintCorrelation();
    const captured: Request[] = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push(new Request(input as RequestInfo, init));
      return new Response("{}");
    }) as typeof fetch;

    const gatewayFetch = withCorrelationFetch(correlation, impl);
    await gatewayFetch("https://gateway.example/v1/run", { method: "POST" });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.headers.get("traceparent")).toBe(
      `00-${correlation.trace_id}-${correlation.span_id}-01`
    );
    expect(captured[0]!.headers.get("x-cail-request-id")).toBe(correlation.request_id);
  });
});
