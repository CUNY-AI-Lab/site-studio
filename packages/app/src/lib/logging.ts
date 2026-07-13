import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { matchedRoutes } from "hono/route";
import {
  CAIL_EVENTS,
  correlationFromHeaders,
  createCailLogger,
  extendCailEventCatalog,
  outboundCorrelationHeaders,
  workersStructuredSink,
  type CailCorrelation,
  type CailHttpMethod,
  type CailLogEnvironment,
  type CailLogSink,
  type CailLogger,
  type CailPrincipalFields,
  type CailTerminalFields,
} from "@cuny-ai-lab/cail-log";

export const LOG_SERVICE = "site-studio-app";
export const LOG_RELEASE = "0.1.0";
export const PRODUCT_ID = "site-studio";

export const SITE_STUDIO_EVENTS = Object.freeze({
  DIAGNOSTIC_INFO: "site_studio.diagnostic.info",
  DIAGNOSTIC_WARNING: "site_studio.diagnostic.warning",
  DIAGNOSTIC_ERROR: "site_studio.diagnostic.error",
} as const);

export const SITE_STUDIO_EVENT_CATALOG = extendCailEventCatalog({
  [SITE_STUDIO_EVENTS.DIAGNOSTIC_INFO]: {
    body: "Site Studio diagnostic condition observed.",
    source: "platform",
    severity: "info",
    required: ["product_id", "error_type"],
    optional: ["request_id", "action_id", "trace", "principal", "http_method", "route", "status", "duration_ms", "retry_count", "req_bytes"],
  },
  [SITE_STUDIO_EVENTS.DIAGNOSTIC_WARNING]: {
    body: "Site Studio diagnostic condition observed.",
    source: "platform",
    severity: "warn",
    required: ["product_id", "error_type"],
    optional: ["request_id", "action_id", "trace", "principal", "http_method", "route", "status", "duration_ms", "retry_count", "req_bytes"],
  },
  [SITE_STUDIO_EVENTS.DIAGNOSTIC_ERROR]: {
    body: "Site Studio diagnostic condition observed.",
    source: "platform",
    severity: "error",
    required: ["product_id", "error_type"],
    optional: ["request_id", "action_id", "trace", "principal", "http_method", "route", "status", "duration_ms", "retry_count", "req_bytes"],
  },
});

export type SiteStudioLogger = CailLogger<typeof SITE_STUDIO_EVENT_CATALOG, "platform">;

export function createSiteStudioLogger(options: {
  sink: CailLogSink;
  env?: CailLogEnvironment;
  release?: string;
  clock?: () => number;
}): SiteStudioLogger {
  return createCailLogger({
    service: LOG_SERVICE,
    release: options.release ?? LOG_RELEASE,
    env: options.env ?? "production",
    sourceClass: "platform",
    catalog: SITE_STUDIO_EVENT_CATALOG,
    sink: options.sink,
    clock: options.clock,
  });
}

/** The Worker sink is explicit; release/environment are constructor-owned. */
export const log = createSiteStudioLogger({ sink: workersStructuredSink });

export type LoggingVariables = {
  correlation?: CailCorrelation;
};

export function mintCorrelation(): CailCorrelation {
  return correlationFromHeaders({ get: () => null });
}

export function traceFromCorrelation(correlation: CailCorrelation) {
  return {
    trace_id: correlation.trace_id,
    span_id: correlation.span_id,
    trace_flags: correlation.trace_flags,
  } as const;
}

/** Only verified CAIL subjects are linkable principals. Legacy owners stay anonymous. */
export function principalForOwnerId(ownerId?: string): CailPrincipalFields {
  return ownerId && /^cail-[0-9a-f]{32}$/.test(ownerId)
    ? { type: "user", subject: ownerId }
    : { type: "anonymous" };
}

export function httpMethod(method: string): CailHttpMethod {
  const normalized = method.toUpperCase();
  switch (normalized) {
    case "CONNECT":
    case "DELETE":
    case "GET":
    case "HEAD":
    case "OPTIONS":
    case "PATCH":
    case "POST":
    case "PUT":
    case "TRACE":
      return normalized;
    default:
      return "_OTHER";
  }
}

export function terminalForStatus(status: number): CailTerminalFields {
  if (status === 408 || status === 504) return { outcome: "timeout", reason: "timeout" };
  if (status === 429) return { outcome: "denied", reason: "rate_limited" };
  if (status === 401 || status === 403) return { outcome: "denied", reason: "denied" };
  if (status >= 500) return { outcome: "error", reason: "application_failure" };
  if (status >= 400) return { outcome: "client_error", reason: "client_error" };
  return { outcome: "ok", reason: "completed" };
}

export function outcomeForStatus(status: number): CailTerminalFields["outcome"] {
  return terminalForStatus(status).outcome;
}

/** Stable machine type derived only from the exception class, never its message. */
export function errorCodeFrom(error: unknown): string {
  const name =
    error instanceof Error && typeof error.name === "string" && error.name
      ? error.name
      : "error";
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "_")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64);
  return slug || "error";
}

/** Convert Hono syntax to a bounded url.template; never return the raw path. */
export function classifiedRoute(c: Context): string {
  const routes = matchedRoutes(c);
  for (let index = routes.length - 1; index >= 0; index -= 1) {
    const path = routes[index]?.path;
    if (!path || path === "*" || path === "/*") continue;
    const template = path
      .replace(/:([A-Za-z][A-Za-z0-9_]*)/g, "{$1}")
      .replace(/\*/g, "{path}");
    return template.length <= 160 ? template : "/unclassified";
  }
  return "/unclassified";
}

export function withCorrelationFetch(
  correlation: CailCorrelation,
  fetchImpl: typeof fetch = fetch,
): typeof fetch {
  const extra = outboundCorrelationHeaders(correlation);
  const wrapped = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input as RequestInfo, init);
    for (const [name, value] of Object.entries(extra)) {
      request.headers.set(name, value);
    }
    return fetchImpl(request);
  };
  return wrapped as typeof fetch;
}

type DiagnosticSeverity = "info" | "warning" | "error";

export function emitDiagnostic(
  severity: DiagnosticSeverity,
  errorType: string,
  fields: { subject?: string; status?: number; retry_count?: number; req_bytes?: number } = {},
  logger: SiteStudioLogger = log,
): void {
  const event = severity === "info"
    ? SITE_STUDIO_EVENTS.DIAGNOSTIC_INFO
    : severity === "warning"
      ? SITE_STUDIO_EVENTS.DIAGNOSTIC_WARNING
      : SITE_STUDIO_EVENTS.DIAGNOSTIC_ERROR;
  logger.emit(event, {
    product_id: PRODUCT_ID,
    error_type: errorType,
    ...(fields.subject ? { principal: principalForOwnerId(fields.subject) } : {}),
    ...(fields.status !== undefined ? { status: fields.status } : {}),
    ...(fields.retry_count !== undefined ? { retry_count: fields.retry_count } : {}),
    ...(fields.req_bytes !== undefined ? { req_bytes: fields.req_bytes } : {}),
  });
}

type FailureTerminal = Exclude<CailTerminalFields, { outcome: "ok" }>;

/**
 * One admitted build/publish attempt. Success is emitted only after the caller
 * acknowledges its durable mutation; logs remain projections, not the ledger.
 */
export class SiteStudioActionLifecycle {
  readonly actionId = crypto.randomUUID();
  private readonly startedAt: number;
  private admitted = false;
  private mutationAcknowledged = false;
  private terminal = false;

  constructor(
    private readonly fields: {
      principal: CailPrincipalFields;
      correlation: CailCorrelation;
      route: string;
      http_method: CailHttpMethod;
    },
    private readonly logger: SiteStudioLogger = log,
    private readonly clock: () => number = Date.now,
  ) {
    this.startedAt = this.clock();
  }

  admit(): void {
    if (this.admitted) return;
    this.admitted = true;
    this.logger.emit(CAIL_EVENTS.ACTION_ADMITTED, {
      action_id: this.actionId,
      product_id: PRODUCT_ID,
      principal: this.fields.principal,
      request_id: this.fields.correlation.request_id,
      trace: traceFromCorrelation(this.fields.correlation),
      http_method: this.fields.http_method,
      route: this.fields.route,
    });
  }

  acknowledgeMutation(): void {
    this.mutationAcknowledged = true;
  }

  completeSuccess(): void {
    if (!this.admitted || this.terminal) return;
    if (!this.mutationAcknowledged) {
      this.completeFailure(
        { outcome: "error", reason: "application_failure" },
        "mutation_unacknowledged",
      );
      return;
    }
    this.terminal = true;
    this.logger.emit(CAIL_EVENTS.ACTION_TERMINAL, {
      action_id: this.actionId,
      product_id: PRODUCT_ID,
      principal: this.fields.principal,
      request_id: this.fields.correlation.request_id,
      trace: traceFromCorrelation(this.fields.correlation),
      http_method: this.fields.http_method,
      route: this.fields.route,
      terminal: { outcome: "ok", reason: "completed" },
      duration_ms: Math.max(0, this.clock() - this.startedAt),
    });
  }

  completeFailure(terminal: FailureTerminal, errorType?: string): void {
    if (!this.admitted || this.terminal) return;
    this.terminal = true;
    this.logger.emit(CAIL_EVENTS.ACTION_TERMINAL, {
      action_id: this.actionId,
      product_id: PRODUCT_ID,
      principal: this.fields.principal,
      request_id: this.fields.correlation.request_id,
      trace: traceFromCorrelation(this.fields.correlation),
      http_method: this.fields.http_method,
      route: this.fields.route,
      terminal,
      duration_ms: Math.max(0, this.clock() - this.startedAt),
      ...(errorType ? { error_type: errorType } : {}),
    });
  }

  wasAdmitted(): boolean {
    return this.admitted;
  }
}

export function requestLogging(logger: SiteStudioLogger = log) {
  return createMiddleware<{
    Variables: LoggingVariables & { user?: { id: string } };
  }>(async (c, next) => {
    const correlation = correlationFromHeaders(c.req.raw);
    c.set("correlation", correlation);
    const started = Date.now();
    const method = httpMethod(c.req.method);
    const route = classifiedRoute(c);

    logger.emit(CAIL_EVENTS.REQUEST_RECEIVED, {
      request_id: correlation.request_id,
      product_id: PRODUCT_ID,
      http_method: method,
      route,
      trace: traceFromCorrelation(correlation),
    });

    await next();

    const status = c.res?.status ?? 500;
    const terminal = terminalForStatus(status);
    const user = c.get("user") as { id?: string } | undefined;
    const principal = user?.id ? principalForOwnerId(user.id) : undefined;
    const errorType = c.error ? errorCodeFrom(c.error) : undefined;

    const completedBase = {
      request_id: correlation.request_id,
      product_id: PRODUCT_ID,
      http_method: method,
      route,
      status,
      duration_ms: Date.now() - started,
      trace: traceFromCorrelation(correlation),
      ...(principal ? { principal } : {}),
    };
    if (terminal.outcome === "ok") {
      logger.emit(CAIL_EVENTS.REQUEST_COMPLETED, {
        ...completedBase,
        terminal,
      });
    } else {
      logger.emit(CAIL_EVENTS.REQUEST_COMPLETED, {
        ...completedBase,
        terminal,
        ...(errorType ? { error_type: errorType } : {}),
      });
    }

    if (status === 401 || status === 403) {
      logger.emit(CAIL_EVENTS.AUTH_DENIED, {
        request_id: correlation.request_id,
        product_id: PRODUCT_ID,
        principal: principal ?? { type: "anonymous" },
        http_method: method,
        route,
        status,
        terminal: { outcome: "denied", reason: "denied" },
        trace: traceFromCorrelation(correlation),
        ...(errorType ? { error_type: errorType } : {}),
      });
    }
  });
}

export function getCorrelation(c: {
  get: (key: "correlation") => CailCorrelation | undefined;
}): CailCorrelation | undefined {
  return c.get("correlation");
}
