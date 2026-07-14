import {
  CAIL_ANALYTICS_ENGINE_MAX_POINTS_PER_INVOCATION,
  createAnalyticsEngineSink,
  fanoutSinks,
  workersStructuredSink,
  type CailAnalyticsEngineDataPoint,
  type CailAnalyticsEngineDataset,
  type CailLogSink,
} from "@cuny-ai-lab/cail-log";

/**
 * One request/action boundary emits far fewer events than this. The adapter
 * enforces the budget independently so a future diagnostic loop cannot cross
 * Cloudflare's platform ceiling.
 */
export const SITE_STUDIO_MAX_FLEET_POINTS_PER_INVOCATION = 32 as const;

if (
  SITE_STUDIO_MAX_FLEET_POINTS_PER_INVOCATION
  >= CAIL_ANALYTICS_ENGINE_MAX_POINTS_PER_INVOCATION
) {
  throw new TypeError("Site Studio fleet point budget must stay below Cloudflare's ceiling");
}

export type SiteStudioFleetProjectionEnv = Readonly<{
  CAIL_FLEET_EVENTS?: CailAnalyticsEngineDataset;
}>;

function boundedDataset(
  dataset: CailAnalyticsEngineDataset,
): CailAnalyticsEngineDataset {
  let points = 0;
  return {
    writeDataPoint(point: CailAnalyticsEngineDataPoint): void {
      if (points >= SITE_STUDIO_MAX_FLEET_POINTS_PER_INVOCATION) return;
      points += 1;
      dataset.writeDataPoint(point);
    },
  };
}

/**
 * Build one invocation-local sink at a trusted Worker boundary. An absent
 * source binding preserves Workers Logs while provisioning remains external.
 */
export function createSiteStudioBoundarySink(
  env: SiteStudioFleetProjectionEnv,
): CailLogSink {
  if (!env.CAIL_FLEET_EVENTS) return workersStructuredSink;
  return fanoutSinks(
    workersStructuredSink,
    createAnalyticsEngineSink(boundedDataset(env.CAIL_FLEET_EVENTS)),
  );
}
