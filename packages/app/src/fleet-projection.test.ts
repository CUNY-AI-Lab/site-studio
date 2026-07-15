import { describe, expect, it, vi } from "vitest";
import {
  CAIL_ANALYTICS_ENGINE_BLOBS,
  CAIL_ANALYTICS_ENGINE_DOUBLES,
  CAIL_ANALYTICS_ENGINE_MAX_POINTS_PER_INVOCATION,
  CAIL_EVENTS,
  ROUTE_TEMPLATE_RE,
  type CailAnalyticsEngineDataPoint,
} from "@cuny-ai-lab/cail-log";
import { OBSERVABILITY_CONTRACT } from "../../observability-core/src/contract";
import { SITE_STUDIO_MAX_FLEET_POINTS_PER_INVOCATION } from "../../observability-core/src/fleet-projection";
import { createSiteStudioBoundaryLogger } from "./lib/logging";

const REQUEST_ID = "8b9ec144-39aa-4f1f-bda5-4c645facf2cd";
const ACTION_ID = "9f50d4a4-ef70-41b2-b225-0a5cbf2df5e7";

function fleetCapture() {
  const points: CailAnalyticsEngineDataPoint[] = [];
  const logger = createSiteStudioBoundaryLogger({
    CAIL_LOG_ENV: "test",
    CAIL_FLEET_EVENTS: {
      writeDataPoint: (point) => points.push(point),
    },
  });
  return { logger, points };
}

describe("CAIL fleet projection boundary", () => {
  it("uses the library projection with environment+product sampling and cohort-only identity", () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { logger, points } = fleetCapture();
      logger.emit(CAIL_EVENTS.ACTION_TERMINAL, {
        action_id: ACTION_ID,
        request_id: REQUEST_ID,
        product_id: "site-studio",
        principal: {
          type: "user",
          subject: "cail-v1-0123456789abcdef0123456789abcdef",
        },
        cohort: "faculty",
        http_method: "POST",
        route: OBSERVABILITY_CONTRACT.actions.publish.route,
        terminal: { outcome: "ok", reason: "completed" },
        duration_ms: 42,
      });

      expect(points).toHaveLength(1);
      const point = points[0]!;
      expect(point.indexes).toEqual(["test:site-studio"]);
      expect(point.blobs[CAIL_ANALYTICS_ENGINE_BLOBS.event_name - 1])
        .toBe("cail.action.terminal");
      expect(point.blobs[CAIL_ANALYTICS_ENGINE_BLOBS.product_id - 1]).toBe("site-studio");
      expect(point.blobs[CAIL_ANALYTICS_ENGINE_BLOBS.cohort - 1]).toBe("faculty");
      expect(point.blobs[CAIL_ANALYTICS_ENGINE_BLOBS.route - 1])
        .toBe("/api/projects/{id}/publish");
      expect(point.doubles[CAIL_ANALYTICS_ENGINE_DOUBLES.duration_ms - 1]).toBe(42);

      const serialized = JSON.stringify(point);
      expect(serialized).not.toContain(REQUEST_ID);
      expect(serialized).not.toContain(ACTION_ID);
      expect(serialized).not.toContain("cail-v1-0123456789abcdef0123456789abcdef");
    } finally {
      consoleLog.mockRestore();
    }
  });

  it("enforces an invocation-local point budget below Cloudflare's ceiling", () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { logger, points } = fleetCapture();
      for (let index = 0; index < SITE_STUDIO_MAX_FLEET_POINTS_PER_INVOCATION + 5; index += 1) {
        logger.emit(CAIL_EVENTS.REQUEST_RECEIVED, {
          request_id: REQUEST_ID,
          product_id: "site-studio",
          http_method: "GET",
          route: "/api/health",
        });
      }
      expect(SITE_STUDIO_MAX_FLEET_POINTS_PER_INVOCATION)
        .toBeLessThan(CAIL_ANALYTICS_ENGINE_MAX_POINTS_PER_INVOCATION);
      expect(points).toHaveLength(SITE_STUDIO_MAX_FLEET_POINTS_PER_INVOCATION);
      expect(consoleLog).toHaveBeenCalledTimes(SITE_STUDIO_MAX_FLEET_POINTS_PER_INVOCATION + 5);
    } finally {
      consoleLog.mockRestore();
    }
  });

  it("recognizes every canonical action route and keeps build/publish distinct", () => {
    expect(Object.entries(OBSERVABILITY_CONTRACT.actions)).toEqual([
      ["build", { route: "/api/agents/site-builder/{project_id}", method: "POST" }],
      ["publish", { route: "/api/projects/{id}/publish", method: "POST" }],
    ]);
    for (const action of Object.values(OBSERVABILITY_CONTRACT.actions)) {
      expect(ROUTE_TEMPLATE_RE.test(action.route)).toBe(true);
    }
  });
});
