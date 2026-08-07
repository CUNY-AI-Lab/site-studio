import { describe, expect, it, vi } from "vitest";
import type { CailAnalyticsEngineDataPoint } from "@cuny-ai-lab/cail-log";
import { OBSERVABILITY_CONTRACT } from "../../observability-core/src/contract";
import worker, { type Env } from "./index";

describe("publisher observability contract", () => {
  it("serves the versioned publisher liveness response without touching R2", async () => {
    const bucket = { get: vi.fn() } as unknown as R2Bucket;
    const points: CailAnalyticsEngineDataPoint[] = [];
    const env = {
      SITE_STUDIO_BUCKET: bucket,
      CAIL_LOG_ENV: "test",
      CAIL_FLEET_EVENTS: { writeDataPoint: (point: CailAnalyticsEngineDataPoint) => points.push(point) },
    } satisfies Env;
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let response!: Response;
    try {
      response = await worker.fetch(
        new Request("https://publisher.example/healthz?private=value"),
        env,
      );

      const events = [...info.mock.calls, ...log.mock.calls].map(([event]) =>
        event as Record<string, unknown>
      );
      expect(events.find((event) => event["event.name"] === "cail.request.completed"))
        .toMatchObject({
          "service.name": "site-studio-publisher",
          "cail.product.id": "site-studio",
          "url.template": "/healthz",
          "http.response.status_code": 200,
          "cail.outcome": "ok",
        });
      expect(JSON.stringify(events)).not.toContain("private=value");

      const head = await worker.fetch(
        new Request("https://publisher.example/healthz", { method: "HEAD" }),
        env,
      );
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect(head.headers.get("cache-control")).toBe("no-store");
    } finally {
      info.mockRestore();
      log.mockRestore();
    }

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      schema_version: "cail.health.v1",
      status: "ok",
      check: "liveness",
      marker: "site-studio-publisher:alive:v1",
      product_id: "site-studio",
      service: {
        name: "site-studio-publisher",
        version: "0.1.0",
      },
      version_id: null,
      version_tag: null,
    });
    expect(bucket.get).not.toHaveBeenCalled();
    expect(points).toHaveLength(4);
    expect(points.every((point) => point.indexes[0] === "test:site-studio")).toBe(true);
    expect(JSON.stringify(points)).not.toContain("private=value");

    const versioned = await worker.fetch(
      new Request("https://publisher.example/healthz"),
      {
        ...env,
        CF_VERSION_METADATA: {
          id: "1a88955c-2fbd-4a72-9d9b-3ba1e59842f2",
          tag: "fedcba9876543210fedcba9876543210fedcba98",
          timestamp: "2026-08-07T12:00:00.000Z",
        },
      },
    );
    expect(await versioned.json()).toMatchObject({
      version_id: "1a88955c-2fbd-4a72-9d9b-3ba1e59842f2",
      version_tag: "fedcba9876543210fedcba9876543210fedcba98",
    });

    const invalid = await worker.fetch(
      new Request("https://publisher.example/healthz"),
      {
        ...env,
        CF_VERSION_METADATA: {
          id: "1A88955C-2FBD-4A72-9D9B-3BA1E59842F2",
          tag: "release-2026-08-07",
          timestamp: "2026-08-07T12:00:00.000Z",
        },
      },
    );
    expect(await invalid.json()).toMatchObject({
      version_id: null,
      version_tag: null,
    });
  });

  it("classifies health as a safe dashboard route", () => {
    expect(OBSERVABILITY_CONTRACT.services.publisher.healthPath).toBe("/healthz");
    expect(OBSERVABILITY_CONTRACT.dashboardViews.requestReliability.groupBy).toContain(
      "url.template",
    );
  });
});
