import { readFileSync } from "node:fs";
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

describe("observability source contract", () => {
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

  it("keeps app custom logs complete and raw-URL invocation logs off", () => {
    const source = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    expect(source).toMatch(/"logs"\s*:\s*\{[\s\S]*?"enabled"\s*:\s*true/);
    expect(source).toMatch(/"logs"\s*:\s*\{[\s\S]*?"persist"\s*:\s*true/);
    expect(source).toMatch(/"logs"\s*:\s*\{[\s\S]*?"head_sampling_rate"\s*:\s*1/);
    expect(source).toMatch(/"logs"\s*:\s*\{[\s\S]*?"invocation_logs"\s*:\s*false/);
    expect(source).toMatch(/"CAIL_LOG_ENV"\s*:\s*"production"/);
    expect(source).not.toContain("analytics_engine_datasets");
  });

  it("pins the app to the canonical production CAIL Model API Worker", () => {
    const source = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    expect(source).toMatch(
      /"CAIL_API_BASE"\s*:\s*"https:\/\/cail-model-api\.ailab-452\.workers\.dev"/,
    );
  });

  it.each([
    new URL("../package.json", import.meta.url),
    new URL("../../observability-core/package.json", import.meta.url),
  ])("pins the reviewed fleet projection dependency in %s", (url) => {
    expect(readFileSync(url, "utf8")).toContain(
      '"@cuny-ai-lab/cail-log": "0.6.0"',
    );
  });

  it("pins the reviewed identity and transport primitives in the app", () => {
    const source = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    // Exact pin, not a range: cail-identity 5.x carries the v2 subject
    // derivation, whose ownership subjects differ from every 4.x value. A
    // caret range here could silently move that contract.
    expect(source).toContain(
      '"@cuny-ai-lab/cail-identity": "5.1.2"',
    );
    expect(source).toContain(
      '"@cuny-ai-lab/cail-client": "5.0.0"',
    );
    expect(source).not.toContain("cail-sandbox-client");
  });

  it("defines queryable build and publish action seams", () => {
    expect(OBSERVABILITY_CONTRACT_VERSION).toBe(3);
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
    expect(OBSERVABILITY_CONTRACT.dashboardViews.actionReliability.groupBy).toEqual([
      "service.name",
      "url.template",
      "cail.outcome",
    ]);
    expect(OBSERVABILITY_CONTRACT.dashboardViews.actionReliability.measures).toContainEqual({
      operation: "p95",
      field: "cail.operation.duration_ms",
    });
    expect(OBSERVABILITY_CONTRACT.dashboardViews.actionReliability).toMatchObject({
      source: "workers-logs",
      aggregateSemantics: "diagnostic_only",
      exact: false,
    });
    expect(OBSERVABILITY_CONTRACT.dashboardViews.actionAdmissions).toMatchObject({
      source: "workers-logs",
      eventName: "cail.action.admitted",
      measures: [{ operation: "count" }],
      groupBy: ["service.name", "url.template"],
      aggregateSemantics: "diagnostic_only",
      exact: false,
    });
    expect(OBSERVABILITY_CONTRACT.dashboardViews.fleetActionReliability).toEqual({
      source: "cloudflare-analytics-engine",
      dataset: "cail_fleet_events_v1",
      eventNames: ["cail.action.admitted", "cail.action.terminal"],
      filter: { blob5: "site-studio" },
      dimensions: {
        eventName: "blob1",
        serviceName: "blob2",
        environment: "blob4",
        productId: "blob5",
        cohort: "blob7",
        route: "blob8",
        outcome: "blob9",
      },
      measures: [
        { operation: "sum", field: "_sample_interval", name: "weighted_events" },
        {
          operation: "quantileExactWeighted",
          quantile: 0.95,
          field: "double5",
          weight: "_sample_interval",
          exclude: -1,
          name: "weighted_p95_duration_ms",
        },
      ],
      aggregateSemantics: "weighted_cohort_diagnostic_only",
      exact: false,
    });
    expect(OBSERVABILITY_CONTRACT.telemetryQuality.actionPair.joinKey).toBe("cail.action.id");
    expect(OBSERVABILITY_CONTRACT.dashboardViews.healthReliability.filter["url.template"])
      .toEqual(["/api/health"]);
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
        modelCostAndLimit: {
          source: "cail-gateway-key-service-accounting",
          nativeLimitUsd: 10,
          applicationLogsAreLedger: false,
        },
        sandboxSettlementAndCost: {
          source: "cail-sandbox-accounting",
          applicationLogsAreLedger: false,
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
        "spend_views",
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

  it("versions the 24-hour SLO, action denominator, coverage, latency, and MTD spend rules", () => {
    const levels = OBSERVABILITY_CONTRACT.serviceLevels;
    expect(levels.evaluation).toEqual({
      reliabilityWindowHours: 24,
      evaluationIntervalMinutes: 15,
      consecutiveBreaches: 2,
    });
    expect(levels.syntheticAvailability).toEqual({
      unit: "basis_points",
      target: 9_950,
      warningBelow: 9_950,
      criticalBelow: 9_900,
      minimumEligibleProbes: 100,
    });
    expect(levels.requestReliability).toEqual({
      denominator: {
        eventName: "cail.request.completed",
        uniqueBy: ["service.name", "cail.request.id"],
        excludeRouteTemplates: ["/api/health"],
        excludeOutcomes: ["client_error", "denied"],
      },
      successOutcomes: ["ok"],
      unit: "basis_points",
      target: 9_950,
      warningBelow: 9_950,
      criticalBelow: 9_800,
      minimumEligibleRequests: 100,
    });
    expect(levels.requestLatency).toEqual({
      percentile: 95,
      warningMillisecondsByService: {
        "site-studio-app": 5_000,
      },
      criticalMultiplier: 2,
      minimumEligibleRequests: 100,
    });
    expect(levels.actionReliability).toMatchObject({
      contractVersion: 1,
      windowAssignment: "admission_time",
      authoritativeSource: "site-studio-durable-admin-read",
      adminReadRoute: "/api/projects/{id}/observability",
      adminReadSchemaVersion: "site-studio.action-attempt-admin.v1",
      attemptSchemaVersion: "site-studio.action-attempt.v1",
      retentionHours: 48,
      terminalGraceMinutes: 15,
      separateBy: ["action", "route"],
      denominator: {
        record: "site-studio.action-attempt.v1",
        uniqueBy: ["actionId"],
        includeAllAdmittedOutcomes: true,
        eligibleBeforeWindowEndMinutes: 15,
      },
      terminalMatch: {
        record: "site-studio.action-attempt.v1",
        cardinality: "exactly_one",
        fields: ["actionId", "action", "route"],
        ownerAndProjectScope: "durable-object-instance",
      },
      successNumerator: {
        outcome: "ok",
        requiresAcknowledgedDurableMutation: true,
      },
      coverageNumerator: {
        terminalAt: "present",
        outcome: "any",
      },
    });
    expect(levels.actionReliability.success).toEqual({
      unit: "basis_points",
      target: 9_500,
      warningBelow: 9_500,
      criticalBelow: 8_000,
      minimumEligibleActions: 10,
    });
    expect(levels.actionReliability.coverage).toEqual({
      unit: "basis_points",
      target: 9_950,
      warningBelow: 9_950,
      criticalBelow: 9_800,
      minimumEligibleActions: 10,
      immediateCriticalIssueCodes: [
        "admission_duplicate",
        "terminal_duplicate",
        "route_mismatch",
        "action_route_unrecognized",
      ],
    });
    expect(levels.actionReliability.latency).toEqual({
      percentile: 95,
      warningMillisecondsByAction: {
        build: 600_000,
        publish: 30_000,
      },
      criticalMultiplier: 2,
      minimumEligibleActions: 10,
    });
    expect(levels.spend).toEqual({
      source: "cail-gateway-usage-ledger",
      productId: "site-studio",
      window: "calendar_month_to_date_utc",
      measure: "sum_cost_micro_usd",
      budgetInput: "monthly_budget_micro_usd",
      warningPercent: 80,
      criticalPercent: 95,
      exhaustedPercent: 100,
    });
  });

  it("returns a stable, no-store app liveness response with null local metadata", async () => {
    const response = await createHealthRouter().request(
      "https://app.example/api/health",
      {},
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
