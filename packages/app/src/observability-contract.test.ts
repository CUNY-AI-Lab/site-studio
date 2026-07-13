import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  OBSERVABILITY_CONTRACT,
  auditTelemetryLifecyclePairs,
} from "../../observability-core/src/contract";
import { createHealthRouter } from "./routes/health";

describe("observability source contract", () => {
  it.each([
    ["app", new URL("../wrangler.jsonc", import.meta.url)],
    ["publisher", new URL("../../worker/wrangler.jsonc", import.meta.url)],
  ] as const)("keeps %s custom logs complete and raw-URL invocation logs off", (_service, url) => {
    const source = readFileSync(url, "utf8");
    expect(source).toMatch(/"logs"\s*:\s*\{[\s\S]*?"enabled"\s*:\s*true/);
    expect(source).toMatch(/"logs"\s*:\s*\{[\s\S]*?"persist"\s*:\s*true/);
    expect(source).toMatch(/"logs"\s*:\s*\{[\s\S]*?"head_sampling_rate"\s*:\s*1/);
    expect(source).toMatch(/"logs"\s*:\s*\{[\s\S]*?"invocation_logs"\s*:\s*false/);
  });

  it("defines queryable build and publish action seams", () => {
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
    expect(OBSERVABILITY_CONTRACT.telemetryQuality.actionPair.joinKey).toBe("cail.action.id");
    expect(OBSERVABILITY_CONTRACT.dashboardViews.healthReliability.filter["url.template"])
      .toEqual(["/api/health", "/healthz"]);
  });

  it("returns a stable, no-store app liveness response", async () => {
    const response = await createHealthRouter().request("https://app.example/api/health");
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
        duration_ms: 42,
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
        duration_ms: -1,
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
        duration_ms: 1,
      },
      {
        "service.name": "site-studio-app",
        "cail.product.id": "site-studio",
        "event.name": "cail.request.completed",
        "cail.request.id": "request-duplicate",
        "url.template": "/wrong-route",
        duration_ms: 2,
      },
    ];
    expect(auditTelemetryLifecyclePairs(requestDuplicate).map((issue) => issue.code)).toEqual([
      "admission_duplicate",
      "terminal_duplicate",
      "route_mismatch",
    ]);
  });
});
