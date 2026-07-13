export const OBSERVABILITY_CONTRACT_VERSION = 2;
export const PRODUCT_ID = "site-studio";
export const SERVICE_VERSION = "0.1.0";

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
    publisher: {
      name: "site-studio-publisher",
      version: SERVICE_VERSION,
      healthPath: "/healthz",
      healthMarker: "site-studio-publisher:alive:v1",
    },
  },
  actions: {
    build: {
      route: "/api/agents/site-builder/{project_id}",
      method: "POST",
    },
    publish: {
      route: "/api/projects/{id}/publish",
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
        excludeRouteTemplates: ["/api/health", "/healthz"],
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
        "site-studio-publisher": 1_000,
      },
      criticalMultiplier: 2,
      minimumEligibleRequests: 100,
    },
    actionReliability: {
      contractVersion: 1,
      windowAssignment: "admission_time",
      terminalGraceMinutes: 15,
      separateBy: ["service.name", "url.template"],
      denominator: {
        eventName: "cail.action.admitted",
        uniqueBy: ["service.name", "cail.action.id"],
        includeAllAdmittedOutcomes: true,
        eligibleBeforeWindowEndMinutes: 15,
      },
      terminalMatch: {
        eventName: "cail.action.terminal",
        cardinality: "exactly_one",
        fields: [
          "service.name",
          "url.template",
          "cail.action.id",
          "cail.principal.type",
          "cail.principal.subject",
        ],
        requestId: "equal_when_present",
      },
      successNumerator: {
        terminalOutcome: "ok",
        requiresAcknowledgedDurableMutation: true,
      },
      coverageNumerator: {
        terminalCardinality: "exactly_one",
        terminalOutcome: "any",
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
        { operation: "p50", field: "duration_ms" },
        { operation: "p95", field: "duration_ms" },
        { operation: "p99", field: "duration_ms" },
      ],
      groupBy: [
        "service.name",
        "url.template",
        "cail.outcome",
        "http.response.status_code",
      ],
    },
    actionReliability: {
      eventName: "cail.action.terminal",
      filter: { "cail.product.id": PRODUCT_ID },
      measures: [
        { operation: "count" },
        { operation: "p50", field: "duration_ms" },
        { operation: "p95", field: "duration_ms" },
        { operation: "p99", field: "duration_ms" },
      ],
      groupBy: ["service.name", "url.template", "cail.outcome"],
      drilldown: [
        "cail.request.id",
        "cail.action.id",
        "cail.principal.type",
        "cail.principal.subject",
        "trace_id",
      ],
    },
    actionAdmissions: {
      eventName: "cail.action.admitted",
      filter: { "cail.product.id": PRODUCT_ID },
      measures: [{ operation: "count" }],
      groupBy: ["service.name", "url.template"],
      drilldown: [
        "cail.request.id",
        "cail.action.id",
        "cail.principal.type",
        "cail.principal.subject",
        "trace_id",
      ],
    },
    healthReliability: {
      eventName: "cail.request.completed",
      filter: {
        "cail.product.id": PRODUCT_ID,
        "url.template": ["/api/health", "/healthz"],
      },
      measures: [
        { operation: "count" },
        { operation: "p95", field: "duration_ms" },
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

export type TelemetryRecord = Readonly<Record<string, unknown>>;

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
      const id = record[definition.joinKey];
      const service = record["service.name"];
      if (typeof id !== "string" || typeof service !== "string") continue;
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

      const admittedRoute = group.admissions[0]?.["url.template"];
      const terminalRoute = group.terminals[0]?.["url.template"];
      if (
        typeof admittedRoute === "string"
        && typeof terminalRoute === "string"
        && admittedRoute !== terminalRoute
      ) {
        issues.push({ code: "route_mismatch", lifecycle, service: group.service, id: group.id });
      }
      if (
        lifecycle === "action"
        && typeof terminalRoute === "string"
        && !actionRoutes.has(terminalRoute)
      ) {
        issues.push({
          code: "action_route_unrecognized",
          lifecycle,
          service: group.service,
          id: group.id,
        });
      }
      for (const terminal of group.terminals) {
        const duration = terminal.duration_ms;
        if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) {
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

export function healthResponse(service: SiteStudioService): Response {
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
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
