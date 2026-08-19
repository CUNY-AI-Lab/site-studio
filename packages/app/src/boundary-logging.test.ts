import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAIL_ANALYTICS_ENGINE_BLOBS,
  toWorkersLogEvent,
  type CailAnalyticsEngineDataPoint,
  type CailLogEvent,
} from "@cuny-ai-lab/cail-log";
import { TEST_SUBJECTS } from "@cuny-ai-lab/cail-identity/testing";
import type { Env } from "./types";
import { createMockKV, type MockKV } from "./lib/test-utils";
import { z } from "zod";

import app from "./app";
import {
  PRODUCT_ID,
  SITE_STUDIO_EVENTS,
  SiteStudioActionLifecycle,
  createSiteStudioBoundaryContext,
  createSiteStudioBoundaryLogger,
  createSiteStudioConnectionLoggingState,
  createSiteStudioLoggingContext,
  createSiteStudioLogger,
  emitDiagnostic,
  errorCodeFrom,
  mintCorrelation,
  outcomeForStatus,
  principalForOperationalSubject,
  terminalForStatus,
  withCorrelationFetch,
} from "./lib/logging";

const BASE = "https://site-studio.example";
const REQUEST_ID = "8b9ec144-39aa-4f1f-bda5-4c645facf2cd";
const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
type CapturedLogValue = string | number | boolean | null;
type CapturedLogEvent = Readonly<Record<string, CapturedLogValue>>;
const capturedLogEventSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

function createStoredR2Object(key: string): R2Object {
  const object = {
    key,
    version: "test-version",
    size: 0,
    etag: `${key}:etag`,
    httpEtag: `"${key}:etag"`,
    checksums: {},
    uploaded: new Date(0),
    storageClass: "Standard",
  };
  // SAFETY: Boundary tests inspect only key/text; remaining R2 metadata is
  // inert fixture data and the runtime binding supplies the complete object.
  return object as R2Object;
}

function createStoredR2Body(key: string, value: string): R2ObjectBody {
  const body = {
    ...createStoredR2Object(key),
    body: new ReadableStream<Uint8Array>(),
    bodyUsed: false,
    arrayBuffer: async () => new TextEncoder().encode(value).buffer,
    blob: async () => new Blob([value]),
    json: async () => JSON.parse(value),
    text: async () => value,
  };
  // SAFETY: Boundary tests consume only text(); other body methods are inert
  // deterministic implementations for the R2 object contract.
  return body as R2ObjectBody;
}

function createMockBucket(): R2Bucket {
  const store = new Map<string, string>();
  const fixture = {
    head: vi.fn(async (key: string) => (store.has(key) ? { key } : null)),
    get: vi.fn(async (key: string) => {
      const value = store.get(key);
      return value === undefined ? null : createStoredR2Body(key, value);
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return createStoredR2Object(key);
    }),
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ objects: [], truncated: false, delimitedPrefixes: [] })),
    createMultipartUpload: vi.fn(async () => { throw new Error("multipart upload is not part of this fixture"); }),
    resumeMultipartUpload: vi.fn(() => { throw new Error("multipart upload is not part of this fixture"); }),
  };
  // SAFETY: Boundary tests use only get/put/list; the remaining methods are
  // inert fixture implementations matching the R2 binding shape.
  return fixture as R2Bucket;
}

let kv: MockKV;
let bucket: R2Bucket;

function createEnv(extra?: { CAIL_LOG_ENV?: string }): Env {
  const bindings = {
    CAIL_LOG_ENV: "test",
    SESSION_KV: kv,
    SITE_STUDIO_BUCKET: bucket,
    // SAFETY: Agent bindings are not reached by logging boundary tests.
    SITE_BUILDER_AGENT: {} as Env["SITE_BUILDER_AGENT"],
    // SAFETY: Migration bindings are not reached by logging boundary tests.
    MIGRATION_COORDINATOR: {} as Env["MIGRATION_COORDINATOR"],
    // SAFETY: The loader binding is not reached by logging boundary tests.
    LOADER: {} as WorkerLoader,
    ASSETS: undefined,
    ...extra
  };
  // SAFETY: Invalid CAIL_LOG_ENV strings are deliberate boundary fixtures;
  // runtime health validation rejects them before any binding is used.
  return bindings as Env;
}

function captureConsole() {
  const spies = [
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {})
  ];
  return {
    events(): CapturedLogEvent[] {
      return spies.flatMap((spy) => spy.mock.calls)
        .map(([event]) => capturedLogEventSchema.safeParse(event))
        .filter((result) => result.success)
        .map((result) => result.data)
        .filter((event) => "event.name" in event);
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
        "cail.schema.version": 2,
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
        createEnv()
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

describe("CAIL_LOG_ENV boundary", () => {
  it.each(["production", "staging"] as const)("joins diagnostic events to exact %s environment", (environment) => {
    const events: CailLogEvent[] = [];
    const logger = createSiteStudioLogger({
      sink: (event) => events.push(event),
      env: environment,
    });
    emitDiagnostic("info", "environment_probe", {}, logger);
    expect(events[0]?.resource["deployment.environment.name"]).toBe(environment);
  });

  it.each([undefined, "", " production", "production ", "PRODUCTION", "qa"])(
    "fails health and protected app requests closed for invalid env %j",
    async (environment) => {
      const capture = captureConsole();
      try {
        const env = createEnv({ CAIL_LOG_ENV: environment });
        const health = await app.request(`${BASE}/api/health`, {}, env);
        const operational = await app.request(`${BASE}/api/projects/probe`, {}, env);

        expect(health.status).toBe(503);
        expect(operational.status).toBe(503);
        expect(kv.get).not.toHaveBeenCalled();
        expect(bucket.get).not.toHaveBeenCalled();
        expect(capture.events()).toHaveLength(0);
      } finally {
        capture.restore();
      }
    },
  );

  it("requires a validated environment in logger factories", () => {
    expect(() => createSiteStudioLogger({
      sink: () => undefined,
      env: "PRODUCTION",
    })).toThrow(/CAIL_LOG_ENV/);
    expect(() => createSiteStudioBoundaryLogger({ CAIL_LOG_ENV: undefined })).toThrow(/CAIL_LOG_ENV/);
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
      principal: { type: "user", subject: "cail-v1-0123456789abcdef0123456789abcdef" },
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
  it("fans diagnostics through the injected fleet sink without leaking identifiers", () => {
    const points: CailAnalyticsEngineDataPoint[] = [];
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const logging = createSiteStudioBoundaryContext({
        CAIL_LOG_ENV: "staging",
        CAIL_FLEET_EVENTS: {
          writeDataPoint: (point) => points.push(point),
        },
      }, {
        correlation: {
          trace_id: TRACE_ID,
          span_id: "b".repeat(16),
          trace_flags: 1,
          request_id: REQUEST_ID,
        },
        operationalSubject: "cail-v1-0123456789abcdef0123456789abcdef",
      });

      emitDiagnostic("warning", "fleet_context_probe", {}, logging);

      expect(points).toHaveLength(1);
      expect(points[0]?.blobs[CAIL_ANALYTICS_ENGINE_BLOBS.event_name - 1])
        .toBe(SITE_STUDIO_EVENTS.DIAGNOSTIC_WARNING);
      const serialized = JSON.stringify(points[0]);
      expect(serialized).not.toContain(REQUEST_ID);
      expect(serialized).not.toContain("cail-v1-0123456789abcdef0123456789abcdef");
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("keeps diagnostic environment, correlation, and operational identity at the boundary", () => {
    const events: CailLogEvent[] = [];
    const correlation = {
      trace_id: TRACE_ID,
      span_id: "a".repeat(16),
      trace_flags: 1 as const,
      request_id: REQUEST_ID,
    };
    const logging = createSiteStudioLoggingContext(
      createSiteStudioLogger({
        sink: (event) => events.push(event),
        env: "staging",
        release: "9.9.0",
      }),
      {
        correlation,
        operationalSubject: "cail-v1-0123456789abcdef0123456789abcdef",
      },
    );

    emitDiagnostic("warning", "context_probe", {}, logging);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      trace_id: TRACE_ID,
      span_id: "a".repeat(16),
      resource: {
        "deployment.environment.name": "staging",
        "service.version": "9.9.0",
      },
      attributes: {
        "cail.request.id": REQUEST_ID,
        "cail.principal.type": "user",
        "enduser.pseudo.id": "cail-v1-0123456789abcdef0123456789abcdef",
      },
    });
    expect(JSON.stringify(events[0])).not.toContain(TEST_SUBJECTS.alice);
  });

  it("keeps interleaved connection contexts independent after a later socket connects", () => {
    const requestIdA = "11111111-1111-4111-8111-111111111111";
    const requestIdB = "22222222-2222-4222-8222-222222222222";
    const traceIdA = "1".repeat(32);
    const traceIdB = "2".repeat(32);
    const subjectA = "cail-v1-0123456789abcdef0123456789abcdef";
    const subjectB = "cail-v1-fedcba9876543210fedcba9876543210";
    const stateA = createSiteStudioConnectionLoggingState(
      new Request("https://site-studio.example/agent", {
        headers: {
          traceparent: `00-${traceIdA}-aaaaaaaaaaaaaaaa-01`,
          "x-cail-request-id": requestIdA,
        },
      }),
      subjectA,
    );
    // Simulate socket B connecting before socket A's turn finishes. PartyServer
    // keeps these states on their individual connections; no DO-wide field is
    // allowed to replace stateA.
    const stateB = createSiteStudioConnectionLoggingState(
      new Request("https://site-studio.example/agent", {
        headers: {
          traceparent: `00-${traceIdB}-bbbbbbbbbbbbbbbb-01`,
          "x-cail-request-id": requestIdB,
        },
      }),
      subjectB,
    );

    const events: CailLogEvent[] = [];
    const logger = createSiteStudioLogger({ sink: (event) => events.push(event), env: "test" });
    emitDiagnostic("info", "interleaved_connection_a", {}, createSiteStudioLoggingContext(logger, stateA));
    emitDiagnostic("info", "interleaved_connection_b", {}, createSiteStudioLoggingContext(logger, stateB));

    expect(Object.isFrozen(stateA)).toBe(true);
    expect(Object.isFrozen(stateA.correlation)).toBe(true);
    expect(stateA.correlation.request_id).toBe(requestIdA);
    expect(stateA.correlation.trace_id).toBe(traceIdA);
    expect(stateA.operationalSubject).toBe(subjectA);
    expect(stateB.correlation.request_id).toBe(requestIdB);
    expect(stateB.correlation.trace_id).toBe(traceIdB);
    expect(stateB.operationalSubject).toBe(subjectB);
    expect(events.map((event) => event.attributes["cail.request.id"])).toEqual([requestIdA, requestIdB]);
    expect(events.map((event) => event.attributes["enduser.pseudo.id"])).toEqual([subjectA, subjectB]);
  });

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
    expect(events.every((event) => event.body === "Service event recorded.")).toBe(true);
    expect(events.every((event) => event.schema_version === 2)).toBe(true);
  });

  it("maps terminal outcomes and principals without treating legacy ids as subjects", () => {
    expect(outcomeForStatus(200)).toBe("ok");
    expect(terminalForStatus(401)).toEqual({ outcome: "denied", reason: "denied" });
    expect(terminalForStatus(429)).toEqual({ outcome: "denied", reason: "rate_limited" });
    expect(terminalForStatus(503)).toEqual({ outcome: "error", reason: "application_failure" });
    expect(principalForOperationalSubject("user_abc")).toEqual({ type: "anonymous" });
    // An OWNERSHIP subject must never become a log principal: relabelling it
    // would put the durable project-owner key into logs in recoverable form.
    // TEST_SUBJECTS.alice = cail-2bd806c97f0e00af1a1fc3328fa763a9
    expect(principalForOperationalSubject(TEST_SUBJECTS.alice)).toEqual({
      type: "anonymous",
    });
    expect(principalForOperationalSubject(undefined)).toEqual({ type: "anonymous" });
    // Only a verified operational subject is logged, verbatim.
    expect(
      principalForOperationalSubject("cail-v1-2bd806c97f0e00af1a1fc3328fa763a9"),
    ).toEqual({
      type: "user",
      subject: "cail-v1-2bd806c97f0e00af1a1fc3328fa763a9",
    });
  });

  it("preserves same-instance event provenance at every configured sink", () => {
    const events: CailLogEvent[] = [];
    const logger = createSiteStudioLogger({ sink: (event) => events.push(event), env: "test" });
    emitDiagnostic("info", "provenance_probe", {}, logger);

    expect(() => toWorkersLogEvent(events[0]!)).not.toThrow();
    expect(() => toWorkersLogEvent({ ...events[0]! })).toThrow(/produced by createCailLogger/);
  });

  it("derives only an exception class and preserves unsampled W3C propagation", async () => {
    const error = new Error("user@example.com typed a secret prompt");
    expect(errorCodeFrom(error)).toBe("error");
    const correlation = mintCorrelation();
    const captured: Request[] = [];
    // SAFETY: The callback implements the global fetch signature used by the
    // correlation wrapper and records the forwarded request for assertions.
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
