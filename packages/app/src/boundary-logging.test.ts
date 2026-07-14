import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CailLogEvent } from "@cuny-ai-lab/cail-log";
import type { Env } from "./types";
import { createMockKV, type MockKV } from "./lib/test-utils";

vi.mock("agents", () => ({
  getAgentByName: vi.fn(async () => ({
    fetch: async () => new Response("{}", { status: 200 }),
    getObservability: async () => ({ calls: [] })
  }))
}));

import app from "./app";
import {
  PRODUCT_ID,
  SITE_STUDIO_EVENTS,
  SiteStudioActionLifecycle,
  createSiteStudioLogger,
  emitDiagnostic,
  errorCodeFrom,
  mintCorrelation,
  outcomeForStatus,
  principalForOwnerId,
  terminalForStatus,
  withCorrelationFetch,
} from "./lib/logging";

const BASE = "https://site-studio.example";
const REQUEST_ID = "8b9ec144-39aa-4f1f-bda5-4c645facf2cd";
const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";

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
  const now = Date.now();
  return {
    SESSION_KV: kv,
    SITE_STUDIO_BUCKET: bucket,
    SITE_BUILDER_AGENT: {} as Env["SITE_BUILDER_AGENT"],
    MIGRATION_COORDINATOR: {} as Env["MIGRATION_COORDINATOR"],
    LOADER: {} as WorkerLoader,
    CAIL_SSO_SWITCHED_AT: new Date(now - 86_400_000).toISOString(),
    CAIL_ACCOUNT_IMPORT_UNTIL: new Date(now + 86_400_000).toISOString(),
    ASSETS: undefined,
    ...extra
  };
}

function captureConsole() {
  const spies = [
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {})
  ];
  return {
    events(): Array<Record<string, unknown>> {
      return spies.flatMap((spy) => spy.mock.calls)
        .map(([event]) => event)
        .filter((event): event is Record<string, unknown> =>
          !!event && typeof event === "object" && "event.name" in event
        );
    },
    lines(): string[] {
      return spies.flatMap((spy) => spy.mock.calls).map(([value]) => JSON.stringify(value));
    },
    restore() {
      for (const spy of spies) spy.mockRestore();
    }
  };
}

beforeEach(() => {
  kv = createMockKV();
  bucket = createMockBucket();
});

describe("canonical request mappings", () => {
  it("emits received and completed with fleet product, component identity, safe route, and no content", async () => {
    const capture = captureConsole();
    try {
      const response = await app.request(
        `${BASE}/api/health?q=SENSITIVE-QUERY-VALUE`,
        {
          headers: {
            traceparent: `00-${TRACE_ID}-b7ad6b7169203331-01`,
            "x-cail-request-id": REQUEST_ID,
            "X-CAIL-Identity-JWT": "SECRET-JWT-VALUE"
          }
        },
        createEnv()
      );
      expect(response.status).toBe(200);

      const events = capture.events();
      const received = events.filter((event) => event["event.name"] === "cail.request.received");
      const completed = events.filter((event) => event["event.name"] === "cail.request.completed");
      expect(received).toHaveLength(1);
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({
        "service.name": "site-studio-app",
        "service.version": "0.1.0",
        "cail.product.id": PRODUCT_ID,
        "cail.request.id": REQUEST_ID,
        "http.request.method": "GET",
        "url.template": "/api/health",
        "http.response.status_code": 200,
        "cail.outcome": "ok",
        "cail.outcome.reason": "completed",
        trace_id: TRACE_ID,
        trace_flags: 1
      });

      for (const line of capture.lines()) {
        expect(line).not.toContain("SENSITIVE-QUERY-VALUE");
        expect(line).not.toContain("SECRET-JWT-VALUE");
        expect(line).not.toContain("?q=");
      }
    } finally {
      capture.restore();
    }
  });

  it("emits request terminal plus auth denial for an enforced anonymous request", async () => {
    const capture = captureConsole();
    try {
      const response = await app.request(
        `${BASE}/api/projects`,
        { headers: { "x-cail-request-id": REQUEST_ID } },
        createEnv({ CAIL_REQUIRE_IDENTITY: "true" })
      );
      expect(response.status).toBe(401);
      const events = capture.events();
      expect(events.filter((event) => event["event.name"] === "cail.request.completed")).toHaveLength(1);
      const denied = events.filter((event) => event["event.name"] === "cail.auth.denied");
      expect(denied).toHaveLength(1);
      expect(denied[0]).toMatchObject({
        "cail.product.id": PRODUCT_ID,
        "cail.principal.type": "anonymous",
        "cail.outcome": "denied",
        "cail.outcome.reason": "denied",
        "url.template": "/api/projects"
      });
    } finally {
      capture.restore();
    }
  });

  it("mints atomic UUID/trace correlation when headers are absent", async () => {
    const capture = captureConsole();
    try {
      await app.request(`${BASE}/api/health`, {}, createEnv());
      const event = capture.events().find((value) => value["event.name"] === "cail.request.completed");
      expect(event?.["cail.request.id"]).toMatch(/^[0-9a-f-]{36}$/);
      expect(event?.trace_id).toMatch(/^[0-9a-f]{32}$/);
      expect(event?.span_id).toMatch(/^[0-9a-f]{16}$/);
      expect(event?.trace_flags).toBe(0);
    } finally {
      capture.restore();
    }
  });
});

describe("canonical build/publish action mappings", () => {
  function createLifecycle(events: CailLogEvent[], clockValues = [100, 145]) {
    const logger = createSiteStudioLogger({
      sink: (event) => events.push(event),
      env: "test",
      clock: () => clockValues.shift() ?? 145,
    });
    return new SiteStudioActionLifecycle({
      action: "publish",
      principal: { type: "user", subject: "cail-0123456789abcdef0123456789abcdef" },
      correlation: {
        request_id: REQUEST_ID,
        trace_id: TRACE_ID,
        span_id: "b7ad6b7169203331",
        trace_flags: 1,
      },
    }, logger, () => clockValues.shift() ?? 145);
  }

  it("emits success only after admission and a durable mutation acknowledgement", () => {
    const events: CailLogEvent[] = [];
    const lifecycle = createLifecycle(events, [100, 145]);
    lifecycle.admit();
    lifecycle.acknowledgeMutation();
    lifecycle.completeSuccess();
    lifecycle.completeSuccess();

    expect(events.map((event) => event.event_name)).toEqual([
      "cail.action.admitted",
      "cail.action.terminal",
    ]);
    expect(events[0]?.attributes).toMatchObject({
      "cail.product.id": PRODUCT_ID,
      "cail.principal.type": "user",
      "url.template": "/api/projects/{id}/publish",
    });
    expect(events[1]?.attributes).toMatchObject({
      "cail.outcome": "ok",
      "cail.outcome.reason": "completed",
    });
    expect(events[0]?.attributes["cail.action.id"]).toBe(events[1]?.attributes["cail.action.id"]);
  });

  it("never claims success when persistence was not acknowledged", () => {
    const events: CailLogEvent[] = [];
    const lifecycle = createLifecycle(events, [100, 145]);
    lifecycle.admit();
    lifecycle.completeSuccess();
    expect(events[1]?.attributes).toMatchObject({
      "cail.outcome": "error",
      "cail.outcome.reason": "application_failure",
      "error.type": "mutation_unacknowledged",
    });
  });

  it("records the durable denominator and terminal before projecting either log event", () => {
    const order: string[] = [];
    const events: CailLogEvent[] = [];
    const times = [1_000, 1_045];
    const logger = createSiteStudioLogger({
      sink: (event) => {
        order.push(`log:${event.event_name}`);
        events.push(event);
      },
      env: "test",
      clock: () => 1_000,
    });
    const lifecycle = new SiteStudioActionLifecycle({
      action: "build",
      principal: { type: "anonymous" },
      correlation: mintCorrelation(),
    }, logger, () => times.shift() ?? 1_045, {
      admit: (admission) => {
        order.push("durable:admitted");
        expect(admission).toMatchObject({
          action: "build",
          route: "/api/agents/site-builder/{project_id}",
          admittedAt: "1970-01-01T00:00:01.000Z",
        });
      },
      terminal: (terminal) => {
        order.push("durable:terminal");
        expect(terminal).toMatchObject({
          outcome: "ok",
          reason: "completed",
          terminalAt: "1970-01-01T00:00:01.045Z",
          durationMs: 45,
        });
      },
    });
    lifecycle.admit();
    lifecycle.acknowledgeMutation();
    lifecycle.completeSuccess();

    expect(order).toEqual([
      "durable:admitted",
      "log:cail.action.admitted",
      "durable:terminal",
      "log:cail.action.terminal",
    ]);
    expect(events).toHaveLength(2);
  });
});

describe("service-local diagnostics and helpers", () => {
  it("covers every fixed-severity diagnostic mapping without a free-text body", () => {
    const events: CailLogEvent[] = [];
    const logger = createSiteStudioLogger({ sink: (event) => events.push(event), env: "test" });
    emitDiagnostic("info", "account_import_completed", {}, logger);
    emitDiagnostic("warning", "snapshot_too_large", { req_bytes: 1_024 }, logger);
    emitDiagnostic("error", "session_store_unavailable", { status: 503 }, logger);
    expect(events.map((event) => event.event_name)).toEqual([
      SITE_STUDIO_EVENTS.DIAGNOSTIC_INFO,
      SITE_STUDIO_EVENTS.DIAGNOSTIC_WARNING,
      SITE_STUDIO_EVENTS.DIAGNOSTIC_ERROR,
    ]);
    expect(events.every((event) => event.attributes["cail.product.id"] === PRODUCT_ID)).toBe(true);
    expect(events.every((event) => event.body === "Site Studio diagnostic condition observed.")).toBe(true);
  });

  it("maps terminal outcomes and principals without treating legacy ids as subjects", () => {
    expect(outcomeForStatus(200)).toBe("ok");
    expect(terminalForStatus(401)).toEqual({ outcome: "denied", reason: "denied" });
    expect(terminalForStatus(429)).toEqual({ outcome: "denied", reason: "rate_limited" });
    expect(terminalForStatus(503)).toEqual({ outcome: "error", reason: "application_failure" });
    expect(principalForOwnerId("user_abc")).toEqual({ type: "anonymous" });
    expect(principalForOwnerId("cail-0123456789abcdef0123456789abcdef")).toEqual({
      type: "user",
      subject: "cail-0123456789abcdef0123456789abcdef",
    });
  });

  it("derives only an exception class and preserves unsampled W3C propagation", async () => {
    const error = new Error("user@example.com typed a secret prompt");
    expect(errorCodeFrom(error)).toBe("error");
    const correlation = mintCorrelation();
    const captured: Request[] = [];
    const gatewayFetch = withCorrelationFetch(correlation, (async (input, init) => {
      captured.push(new Request(input, init));
      return new Response("{}");
    }) as typeof fetch);
    await gatewayFetch("https://gateway.example/v1/run", { method: "POST" });
    expect(captured[0]?.headers.get("traceparent")).toBe(
      `00-${correlation.trace_id}-${correlation.span_id}-00`
    );
    expect(captured[0]?.headers.get("x-cail-request-id")).toBe(correlation.request_id);
  });
});
