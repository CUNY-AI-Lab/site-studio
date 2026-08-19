import {
  CAIL_ANALYTICS_ENGINE_BLOBS,
  CAIL_ANALYTICS_ENGINE_DATASET,
  CAIL_ANALYTICS_ENGINE_DOUBLES,
  CAIL_ANALYTICS_ENGINE_SCHEMA_VERSION,
  CAIL_LOG_SCHEMA_VERSION,
  type CailLogEnvironment,
} from "@cuny-ai-lab/cail-log";
import {
  ACTION_ATTEMPT_ADMIN_SCHEMA_VERSION,
  ACTION_ATTEMPT_RETENTION_HOURS,
  ACTION_ATTEMPT_SCHEMA_VERSION,
  SITE_STUDIO_ACTION_ROUTES,
} from "./action-attempt";
import { SITE_STUDIO_MAX_FLEET_POINTS_PER_INVOCATION } from "./fleet-projection";
import { z } from "zod";

export const OBSERVABILITY_CONTRACT_VERSION = 3;
export const PRODUCT_ID = "site-studio";
export const SERVICE_VERSION = "0.1.0";

/** Closed environment vocabulary shared by every Site Studio log boundary. */
export const CAIL_LOG_ENVIRONMENTS = Object.freeze([
  "production",
  "staging",
  "development",
  "test",
] as const);

/**
 * Parse the deployment environment without normalization or a fallback.
 * Configuration typos must fail closed instead of relabeling telemetry.
 */
export function parseCailLogEnvironment(value: string | null | undefined): CailLogEnvironment | undefined {
  switch (value) {
    case "production":
    case "staging":
    case "development":
    case "test":
      return value;
    default:
      return undefined;
  }
}

/** Non-cacheable response used when a required runtime contract is invalid. */
export function serviceUnavailableResponse(): Response {
  return new Response(JSON.stringify({ error: "Service unavailable" }), {
    status: 503,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=UTF-8",
    },
  });
}

export const OBSERVABILITY_CONTRACT = {
  schemaVersion: OBSERVABILITY_CONTRACT_VERSION,
  productId: PRODUCT_ID,
  services: {
    app: {
      name: "site-studio-app",
      version: SERVICE_VERSION,
      healthPath: "/api/health",
      healthMarker: "site-studio-app:alive:v1",
    },
  },
  actions: {
    build: {
      route: SITE_STUDIO_ACTION_ROUTES.build,
      method: "POST",
    },
    publish: {
      route: SITE_STUDIO_ACTION_ROUTES.publish,
      method: "POST",
    },
  },
  collection: {
    customLogs: {
      enabled: true,
      persist: true,
      headSamplingRate: 1,
      boundedCatalogEventsOnly: true,
    },
    invocationLogs: false,
    externalExporter: null,
  },
  fleetProjection: {
    logSchemaVersion: CAIL_LOG_SCHEMA_VERSION,
    provider: "cloudflare-analytics-engine",
    dataset: CAIL_ANALYTICS_ENGINE_DATASET,
    binding: "CAIL_FLEET_EVENTS",
    schemaVersion: CAIL_ANALYTICS_ENGINE_SCHEMA_VERSION,
    columns: {
      blobs: CAIL_ANALYTICS_ENGINE_BLOBS,
      doubles: CAIL_ANALYTICS_ENGINE_DOUBLES,
    },
    samplingIndex: ["deployment.environment.name", "cail.product.id"],
    weightField: "_sample_interval",
    cohortOnly: true,
    exact: false,
    maxPointsPerInvocation: SITE_STUDIO_MAX_FLEET_POINTS_PER_INVOCATION,
    authority: {
      actionSuccessAndCoverage: {
        source: "site-studio-durable-admin-read",
        route: "/api/projects/{id}/observability",
        schemaVersion: ACTION_ATTEMPT_ADMIN_SCHEMA_VERSION,
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
  },
  access: {
    role: "kale-admin",
    defaultDecision: "deny",
    resources: [
      "dashboards",
      "saved_queries",
      "monitor_configuration",
      "spend_views",
    ],
  },
  syntheticMonitor: {
    provider: "cloudflare-health-checks",
    type: "HTTPS",
    checkRegions: ["ENAM"],
    intervalSeconds: 60,
    timeoutSeconds: 5,
    retries: 2,
    consecutiveFailures: 2,
    consecutiveSuccesses: 2,
    method: "GET",
    port: 443,
    expectedCodes: ["200"],
    followRedirects: false,
    allowInsecure: false,
    notifyOn: ["unhealthy", "healthy"],
  },
  serviceLevels: {
    evaluation: {
      reliabilityWindowHours: 24,
      evaluationIntervalMinutes: 15,
      consecutiveBreaches: 2,
    },
    syntheticAvailability: {
      unit: "basis_points",
      target: 9_950,
      warningBelow: 9_950,
      criticalBelow: 9_900,
      minimumEligibleProbes: 100,
    },
    requestReliability: {
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
    },
    requestLatency: {
      percentile: 95,
      warningMillisecondsByService: {
        "site-studio-app": 5_000,
      },
      criticalMultiplier: 2,
      minimumEligibleRequests: 100,
    },
    actionReliability: {
      contractVersion: 1,
      windowAssignment: "admission_time",
      authoritativeSource: "site-studio-durable-admin-read",
      adminReadRoute: "/api/projects/{id}/observability",
      adminReadSchemaVersion: ACTION_ATTEMPT_ADMIN_SCHEMA_VERSION,
      attemptSchemaVersion: ACTION_ATTEMPT_SCHEMA_VERSION,
      retentionHours: ACTION_ATTEMPT_RETENTION_HOURS,
      terminalGraceMinutes: 15,
      separateBy: ["action", "route"],
      denominator: {
        record: ACTION_ATTEMPT_SCHEMA_VERSION,
        uniqueBy: ["actionId"],
        includeAllAdmittedOutcomes: true,
        eligibleBeforeWindowEndMinutes: 15,
      },
      terminalMatch: {
        record: ACTION_ATTEMPT_SCHEMA_VERSION,
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
      success: {
        unit: "basis_points",
        target: 9_500,
        warningBelow: 9_500,
        criticalBelow: 8_000,
        minimumEligibleActions: 10,
      },
      coverage: {
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
      },
      latency: {
        percentile: 95,
        warningMillisecondsByAction: {
          build: 600_000,
          publish: 30_000,
        },
        criticalMultiplier: 2,
        minimumEligibleActions: 10,
      },
    },
    spend: {
      source: "cail-gateway-usage-ledger",
      productId: PRODUCT_ID,
      window: "calendar_month_to_date_utc",
      measure: "sum_cost_micro_usd",
      budgetInput: "monthly_budget_micro_usd",
      warningPercent: 80,
      criticalPercent: 95,
      exhaustedPercent: 100,
    },
  },
  dashboardViews: {
    requestReliability: {
      eventName: "cail.request.completed",
      filter: { "cail.product.id": PRODUCT_ID },
      measures: [
        { operation: "count" },
        { operation: "p50", field: "cail.operation.duration_ms" },
        { operation: "p95", field: "cail.operation.duration_ms" },
        { operation: "p99", field: "cail.operation.duration_ms" },
      ],
      groupBy: [
        "service.name",
        "url.template",
        "cail.outcome",
        "http.response.status_code",
      ],
    },
    actionReliability: {
      source: "workers-logs",
      eventName: "cail.action.terminal",
      filter: { "cail.product.id": PRODUCT_ID },
      measures: [
        { operation: "count" },
        { operation: "p50", field: "cail.operation.duration_ms" },
        { operation: "p95", field: "cail.operation.duration_ms" },
        { operation: "p99", field: "cail.operation.duration_ms" },
      ],
      groupBy: ["service.name", "url.template", "cail.outcome"],
      aggregateSemantics: "diagnostic_only",
      exact: false,
      drilldown: [
        "cail.request.id",
        "cail.action.id",
        "cail.principal.type",
        "cail.principal.subject",
        "trace_id",
      ],
    },
    actionAdmissions: {
      source: "workers-logs",
      eventName: "cail.action.admitted",
      filter: { "cail.product.id": PRODUCT_ID },
      measures: [{ operation: "count" }],
      groupBy: ["service.name", "url.template"],
      aggregateSemantics: "diagnostic_only",
      exact: false,
      drilldown: [
        "cail.request.id",
        "cail.action.id",
        "cail.principal.type",
        "cail.principal.subject",
        "trace_id",
      ],
    },
    fleetActionReliability: {
      source: "cloudflare-analytics-engine",
      dataset: CAIL_ANALYTICS_ENGINE_DATASET,
      eventNames: ["cail.action.admitted", "cail.action.terminal"],
      filter: { blob5: PRODUCT_ID },
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
    },
    healthReliability: {
      eventName: "cail.request.completed",
      filter: {
        "cail.product.id": PRODUCT_ID,
        "url.template": ["/api/health"],
      },
      measures: [
        { operation: "count" },
        { operation: "p95", field: "cail.operation.duration_ms" },
      ],
      groupBy: [
        "service.name",
        "url.template",
        "cail.outcome",
        "http.response.status_code",
      ],
    },
  },
  telemetryQuality: {
    requestPair: {
      admittedEventName: "cail.request.received",
      terminalEventName: "cail.request.completed",
      joinKey: "cail.request.id",
    },
    actionPair: {
      admittedEventName: "cail.action.admitted",
      terminalEventName: "cail.action.terminal",
      joinKey: "cail.action.id",
    },
    violationSignals: {
      unacknowledgedMutation: {
        eventName: "cail.action.terminal",
        field: "error.type",
        equals: "mutation_unacknowledged",
      },
      unclassifiedRoute: {
        field: "url.template",
        equals: "/unclassified",
      },
    },
  },
} as const;

export type SiteStudioService = keyof typeof OBSERVABILITY_CONTRACT.services;
export type SiteStudioAction = keyof typeof OBSERVABILITY_CONTRACT.actions;

export type TelemetryQualityIssue = Readonly<{
  code:
    | "admission_missing"
    | "admission_duplicate"
    | "terminal_missing"
    | "terminal_duplicate"
    | "route_mismatch"
    | "action_route_unrecognized"
    | "terminal_duration_invalid";
  lifecycle: "request" | "action";
  service: string;
  id: string;
}>;

export type TelemetryValue = string | number | boolean | null | undefined;
export type TelemetryRecord = Readonly<Record<string, TelemetryValue>>;

export type CloudflareHealthCheckSpec = Readonly<{
  address: string;
  name: string;
  description: string;
  type: "HTTPS";
  check_regions: readonly ["ENAM"];
  interval: number;
  timeout: number;
  retries: number;
  consecutive_fails: number;
  consecutive_successes: number;
  http_config: Readonly<{
    allow_insecure: false;
    expected_body: string;
    expected_codes: readonly ["200"];
    follow_redirects: false;
    method: "GET";
    path: string;
    port: 443;
  }>;
}>;

/** Build an API-ready standalone Cloudflare Health Check without mutating Cloudflare. */
export function createCloudflareHealthCheckSpec(
  service: SiteStudioService,
  hostname: string,
): CloudflareHealthCheckSpec {
  const address = hostname.trim().toLowerCase();
  const labels = address.split(".");
  const validLabel = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
  if (
    address.length > 253
    || labels.length < 2
    || labels.some((label) => !validLabel.test(label))
  ) {
    throw new TypeError("hostname must be a DNS hostname without a scheme, port, or path");
  }

  const definition = OBSERVABILITY_CONTRACT.services[service];
  const monitor = OBSERVABILITY_CONTRACT.syntheticMonitor;
  return {
    address,
    name: `${PRODUCT_ID}-${service}`,
    description: `${definition.name} liveness (${definition.healthPath})`,
    type: monitor.type,
    check_regions: monitor.checkRegions,
    interval: monitor.intervalSeconds,
    timeout: monitor.timeoutSeconds,
    retries: monitor.retries,
    consecutive_fails: monitor.consecutiveFailures,
    consecutive_successes: monitor.consecutiveSuccesses,
    http_config: {
      allow_insecure: monitor.allowInsecure,
      expected_body: definition.healthMarker,
      expected_codes: monitor.expectedCodes,
      follow_redirects: monitor.followRedirects,
      method: monitor.method,
      path: definition.healthPath,
      port: monitor.port,
    },
  };
}

/**
 * Audit a closed export window after its terminal grace period. This checks log
 * projection quality only; it never decides whether a product action succeeded.
 */
export function auditTelemetryLifecyclePairs(
  records: readonly TelemetryRecord[],
): TelemetryQualityIssue[] {
  const issues: TelemetryQualityIssue[] = [];
  const actionRoutes = new Set<string>(
    Object.values(OBSERVABILITY_CONTRACT.actions).map((action) => action.route),
  );

  for (const lifecycle of ["request", "action"] as const) {
    const definition = lifecycle === "request"
      ? OBSERVABILITY_CONTRACT.telemetryQuality.requestPair
      : OBSERVABILITY_CONTRACT.telemetryQuality.actionPair;
    const groups = new Map<string, {
      id: string;
      service: string;
      admissions: TelemetryRecord[];
      terminals: TelemetryRecord[];
    }>();

    for (const record of records) {
      if (record["cail.product.id"] !== PRODUCT_ID) continue;
      const eventName = record["event.name"];
      if (
        eventName !== definition.admittedEventName
        && eventName !== definition.terminalEventName
      ) continue;
      const idResult = z.string().safeParse(record[definition.joinKey]);
      const serviceResult = z.string().safeParse(record["service.name"]);
      if (!idResult.success || !serviceResult.success) continue;
      const id = idResult.data;
      const service = serviceResult.data;
      const key = `${service}\u0000${id}`;
      const group = groups.get(key) ?? {
        id,
        service,
        admissions: [],
        terminals: [],
      };
      (eventName === definition.admittedEventName
        ? group.admissions
        : group.terminals).push(record);
      groups.set(key, group);
    }

    for (const group of groups.values()) {
      if (group.admissions.length === 0) {
        issues.push({ code: "admission_missing", lifecycle, service: group.service, id: group.id });
      } else if (group.admissions.length > 1) {
        issues.push({ code: "admission_duplicate", lifecycle, service: group.service, id: group.id });
      }
      if (group.terminals.length === 0) {
        issues.push({ code: "terminal_missing", lifecycle, service: group.service, id: group.id });
      } else if (group.terminals.length > 1) {
        issues.push({ code: "terminal_duplicate", lifecycle, service: group.service, id: group.id });
      }

      const admittedRouteResult = z.string().safeParse(group.admissions[0]?.["url.template"]);
      const terminalRouteResult = z.string().safeParse(group.terminals[0]?.["url.template"]);
      if (
        admittedRouteResult.success
        && terminalRouteResult.success
        && admittedRouteResult.data !== terminalRouteResult.data
      ) {
        issues.push({ code: "route_mismatch", lifecycle, service: group.service, id: group.id });
      }
      if (
        lifecycle === "action"
        && terminalRouteResult.success
        && !actionRoutes.has(terminalRouteResult.data)
      ) {
        issues.push({
          code: "action_route_unrecognized",
          lifecycle,
          service: group.service,
          id: group.id,
        });
      }
      for (const terminal of group.terminals) {
        const durationResult = z.number().finite().nonnegative().safeParse(
          terminal["cail.operation.duration_ms"],
        );
        if (!durationResult.success) {
          issues.push({
            code: "terminal_duration_invalid",
            lifecycle,
            service: group.service,
            id: group.id,
          });
        }
      }
    }
  }

  return issues;
}

/**
 * The Cloudflare version-metadata binding is absent in local development and
 * older deployments. Keep its public health projection joinable and explicit:
 * only a canonical Cloudflare version UUID and a lowercase full Git SHA tag
 * are exposed; invalid or missing fields become null.
 */
export type HealthVersionMetadata = Readonly<{
  id: string;
  tag: string;
  timestamp?: string;
}>;

const CLOUDFLARE_VERSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GIT_SHA_VERSION_TAG_PATTERN = /^[0-9a-f]{40}$/;

function cloudflareVersionId(value: string | undefined): string | null {
  return value !== undefined && CLOUDFLARE_VERSION_ID_PATTERN.test(value)
    ? value
    : null;
}

function gitShaVersionTag(value: string | undefined): string | null {
  return value !== undefined && GIT_SHA_VERSION_TAG_PATTERN.test(value)
    ? value
    : null;
}

export function healthResponse(
  service: SiteStudioService,
  versionMetadata?: HealthVersionMetadata | null,
): Response {
  const definition = OBSERVABILITY_CONTRACT.services[service];
  return Response.json(
    {
      schema_version: "cail.health.v1",
      status: "ok",
      check: "liveness",
      marker: definition.healthMarker,
      product_id: PRODUCT_ID,
      service: {
        name: definition.name,
        version: definition.version,
      },
      version_id: cloudflareVersionId(versionMetadata?.id),
      version_tag: gitShaVersionTag(versionMetadata?.tag),
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
