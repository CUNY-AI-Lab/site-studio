import { describe, expect, it } from "vitest";
import {
  OBSERVABILITY_CONTRACT,
  OBSERVABILITY_CONTRACT_VERSION,
  auditTelemetryLifecyclePairs,
  createCloudflareHealthCheckSpec,
  CAIL_LOG_ENVIRONMENTS,
  parseCailLogEnvironment,
} from "../../observability-core/src/contract";
import { createHealthRouter } from "./routes/health";
import type { Env } from "./types";

describe("observability contract", () => {
  it("accepts only the exact cail-log environment vocabulary", () => {
    expect(CAIL_LOG_ENVIRONMENTS).toEqual([
      "production",
      "staging",
      "development",
      "test",
    ]);
    expect(CAIL_LOG_ENVIRONMENTS.every((value) => parseCailLogEnvironment(value) === value)).toBe(true);
    for (const value of [undefined, null, "", " production", "production ", "PRODUCTION", "qa"]) {
      expect(parseCailLogEnvironment(value)).toBeUndefined();
    }
  });

  it("defines queryable build and publish action seams", () => {
    expect(OBSERVABILITY_CONTRACT_VERSION).toBe(4);
    expect(OBSERVABILITY_CONTRACT.actions).toEqual({
      build: {
        route: "/api/agents/site-builder/{project_id}",
        method: "POST",
      },
      publish: {
        route: "/api/projects/{id}/publish",
        method: "POST",
      },
    });
    expect(OBSERVABILITY_CONTRACT.telemetryQuality.actionPair.joinKey).toBe("cail.action.id");
  });

  it("pins privacy, access, export, and conservative monitor defaults", () => {
    expect(OBSERVABILITY_CONTRACT.collection).toEqual({
      customLogs: {
        enabled: true,
        persist: true,
        headSamplingRate: 1,
        boundedCatalogEventsOnly: true,
      },
      invocationLogs: false,
      externalExporter: null,
    });
    expect(OBSERVABILITY_CONTRACT.fleetProjection).toMatchObject({
      logSchemaVersion: 2,
      provider: "cloudflare-analytics-engine",
      dataset: "cail_fleet_events_v1",
      binding: "CAIL_FLEET_EVENTS",
      schemaVersion: 1,
      samplingIndex: ["deployment.environment.name", "cail.product.id"],
      weightField: "_sample_interval",
      cohortOnly: true,
      exact: false,
      maxPointsPerInvocation: 32,
      authority: {
        actionSuccessAndCoverage: {
          source: "site-studio-durable-admin-read",
          route: "/api/projects/{id}/observability",
          schemaVersion: "site-studio.action-attempt-admin.v1",
        },
      },
    });
    expect(OBSERVABILITY_CONTRACT.access).toEqual({
      role: "kale-admin",
      defaultDecision: "deny",
      resources: [
        "dashboards",
        "saved_queries",
        "monitor_configuration",
      ],
    });
    expect(OBSERVABILITY_CONTRACT.syntheticMonitor).toMatchObject({
      provider: "cloudflare-health-checks",
      checkRegions: ["ENAM"],
      intervalSeconds: 60,
      timeoutSeconds: 5,
      retries: 2,
      consecutiveFailures: 2,
      consecutiveSuccesses: 2,
      notifyOn: ["unhealthy", "healthy"],
    });

    expect(createCloudflareHealthCheckSpec("app", "Studio.Example.edu")).toEqual({
      address: "studio.example.edu",
      name: "site-studio-app",
      description: "site-studio-app liveness (/api/health)",
      type: "HTTPS",
      check_regions: ["ENAM"],
      interval: 60,
      timeout: 5,
      retries: 2,
      consecutive_fails: 2,
      consecutive_successes: 2,
      http_config: {
        allow_insecure: false,
        expected_body: "site-studio-app:alive:v1",
        expected_codes: ["200"],
        follow_redirects: false,
        method: "GET",
        path: "/api/health",
        port: 443,
      },
    });
    for (
      const invalid of ["", "https://sites.example.edu", "sites.example.edu/path", "localhost"]
    ) {
      expect(() => createCloudflareHealthCheckSpec("app", invalid)).toThrow(TypeError);
    }
  });


  it("returns a stable, no-store app liveness response with null local metadata", async () => {
    const response = await createHealthRouter().request(
      "https://app.example/api/health",
      {},
      // SAFETY: Health liveness only reads the optional logging environment.
      { CAIL_LOG_ENV: "test" } as Env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      schema_version: "cail.health.v1",
      status: "ok",
      check: "liveness",
      marker: "site-studio-app:alive:v1",
      product_id: "site-studio",
      service: {
        name: "site-studio-app",
        version: "0.1.0",
      },
      version_id: null,
      version_tag: null,
    });
  });

  it("returns exact canonical Cloudflare version metadata when present", async () => {
    const response = await createHealthRouter().request(
      "https://app.example/api/health",
      {},
      // SAFETY: Version metadata fixture matches Cloudflare's binding shape.
      {
        CAIL_LOG_ENV: "test",
        CF_VERSION_METADATA: {
          id: "095f00a7-23a7-43b7-a227-e4c97cab5f22",
          tag: "0123456789abcdef0123456789abcdef01234567",
          timestamp: "2026-08-07T12:00:00.000Z",
        },
      } as Env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      version_id: "095f00a7-23a7-43b7-a227-e4c97cab5f22",
      version_tag: "0123456789abcdef0123456789abcdef01234567",
    });
  });

  it("nulls non-canonical version metadata", async () => {
    const response = await createHealthRouter().request(
      "https://app.example/api/health",
      {},
      // SAFETY: Invalid metadata fixture is deliberately passed through the Env boundary.
      {
        CAIL_LOG_ENV: "test",
        CF_VERSION_METADATA: {
          id: "095F00A7-23A7-43B7-A227-E4C97CAB5F22",
          tag: "release-2026-08-07",
          timestamp: "2026-08-07T12:00:00.000Z",
        },
      } as Env,
    );
    expect(await response.json()).toMatchObject({
      version_id: null,
      version_tag: null,
    });
  });

  it("audits lifecycle projection gaps without deciding product success", () => {
    const base = {
      "service.name": "site-studio-app",
      "cail.product.id": "site-studio",
      "url.template": "/api/projects/{id}/publish",
    };
    const valid = [
      { ...base, "event.name": "cail.action.admitted", "cail.action.id": "action-ok" },
      {
        ...base,
        "event.name": "cail.action.terminal",
        "cail.action.id": "action-ok",
        "cail.operation.duration_ms": 42,
        "cail.outcome": "ok",
      },
    ];
    expect(auditTelemetryLifecyclePairs(valid)).toEqual([]);

    const broken = [
      ...valid,
      {
        ...base,
        "event.name": "cail.action.admitted",
        "cail.action.id": "missing-terminal",
      },
      {
        ...base,
        "event.name": "cail.action.terminal",
        "cail.action.id": "orphan-terminal",
        "url.template": "/unexpected/{id}",
        "cail.operation.duration_ms": -1,
      },
    ];
    expect(auditTelemetryLifecyclePairs(broken).map((issue) => issue.code)).toEqual([
      "terminal_missing",
      "admission_missing",
      "action_route_unrecognized",
      "terminal_duration_invalid",
    ]);

    const requestDuplicate = [
      {
        "service.name": "site-studio-app",
        "cail.product.id": "site-studio",
        "event.name": "cail.request.received",
        "cail.request.id": "request-duplicate",
        "url.template": "/api/health",
      },
      {
        "service.name": "site-studio-app",
        "cail.product.id": "site-studio",
        "event.name": "cail.request.received",
        "cail.request.id": "request-duplicate",
        "url.template": "/api/health",
      },
      {
        "service.name": "site-studio-app",
        "cail.product.id": "site-studio",
        "event.name": "cail.request.completed",
        "cail.request.id": "request-duplicate",
        "url.template": "/wrong-route",
        "cail.operation.duration_ms": 1,
      },
      {
        "service.name": "site-studio-app",
        "cail.product.id": "site-studio",
        "event.name": "cail.request.completed",
        "cail.request.id": "request-duplicate",
        "url.template": "/wrong-route",
        "cail.operation.duration_ms": 2,
      },
    ];
    expect(auditTelemetryLifecyclePairs(requestDuplicate).map((issue) => issue.code)).toEqual([
      "admission_duplicate",
      "terminal_duplicate",
      "route_mismatch",
    ]);
  });
});
