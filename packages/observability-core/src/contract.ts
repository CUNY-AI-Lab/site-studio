export const OBSERVABILITY_CONTRACT_VERSION = 1;
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
