import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { matchedRoutes } from "hono/route";
import {
  CAIL_EVENTS,
  correlationFromHeaders,
  createCailLogger,
  extendCailEventCatalog,
  outboundCorrelationHeaders,
  type CailCorrelation,
  type CailTraceFields,
  type CailHttpMethod,
  type CailLogSink,
  type CailLogger,
  type CailPrincipalFields,
  type CailTerminalFields,
} from "@cuny-ai-lab/cail-log";
import {
  OBSERVABILITY_CONTRACT,
  parseCailLogEnvironment,
  PRODUCT_ID,
  serviceUnavailableResponse,
} from "../../../observability-core/src/contract";
import { createSiteStudioBoundarySink } from "../../../observability-core/src/fleet-projection";
import type { ActionAttemptRecorder } from "../../../observability-core/src/action-attempt";
import type { Env } from "../types";

export const LOG_SERVICE = OBSERVABILITY_CONTRACT.services.app.name;
export const LOG_RELEASE = OBSERVABILITY_CONTRACT.services.app.version;
export const CAIL_LOG_SUBJECT_VERSION = "v1";
/**
 * Internal Worker-to-agent forwarding header. The app route overwrites this
 * value from the middleware-verified user before forwarding a request; it is
 * never accepted as caller identity. A missing/invalid value means the
 * connection is intentionally anonymous for operational logging.
 */
export const SITE_STUDIO_VERIFIED_OPERATIONAL_SUBJECT_HEADER =
  "x-site-studio-verified-operational-subject";
export { PRODUCT_ID };

const OPERATIONAL_SUBJECT_RE = new RegExp(
  `^cail-${CAIL_LOG_SUBJECT_VERSION}-[0-9a-f]{32}$`,
);

export const SITE_STUDIO_EVENTS = Object.freeze({
  DIAGNOSTIC_INFO: "site_studio.diagnostic.info",
  DIAGNOSTIC_WARNING: "site_studio.diagnostic.warning",
  DIAGNOSTIC_ERROR: "site_studio.diagnostic.error",
} as const);

export const SITE_STUDIO_EVENT_CATALOG = extendCailEventCatalog({
  [SITE_STUDIO_EVENTS.DIAGNOSTIC_INFO]: {
    source: "platform",
    severity: "info",
    required: ["product_id", "error_type"],
    optional: ["request_id", "action_id", "trace", "principal", "http_method", "route", "status", "duration_ms", "retry_count", "req_bytes"],
  },
  [SITE_STUDIO_EVENTS.DIAGNOSTIC_WARNING]: {
    source: "platform",
    severity: "warn",
    required: ["product_id", "error_type"],
    optional: ["request_id", "action_id", "trace", "principal", "http_method", "route", "status", "duration_ms", "retry_count", "req_bytes"],
  },
  [SITE_STUDIO_EVENTS.DIAGNOSTIC_ERROR]: {
    source: "platform",
    severity: "error",
    required: ["product_id", "error_type"],
    optional: ["request_id", "action_id", "trace", "principal", "http_method", "route", "status", "duration_ms", "retry_count", "req_bytes"],
  },
});

export type SiteStudioLogger = CailLogger<typeof SITE_STUDIO_EVENT_CATALOG, "platform">;

/**
 * A correlation snapshot used by Site Studio's request/connection contexts.
 * `trace` is kept alongside the wire fields so the context has one immutable
 * nested trace object for every diagnostic emission.
 */
export type SiteStudioCorrelation = Readonly<CailCorrelation & {
  trace: CailTraceFields;
}>;

/**
 * Immutable per-invocation diagnostic context. The logger is created at a
 * trusted Worker boundary and the correlation is adopted from that same
 * request before helpers run. Durable Object RPCs carry the serializable
 * fields in `SiteStudioLoggingContextData` and recreate this context there.
 */
export type SiteStudioLoggingContext = Readonly<{
  logger: SiteStudioLogger;
  correlation?: SiteStudioCorrelation;
  operationalSubject?: string;
}>;

/** The JSON-safe portion forwarded across a Durable Object RPC boundary. */
export type SiteStudioLoggingContextData = Readonly<{
  correlation?: CailCorrelation | SiteStudioCorrelation;
  operationalSubject?: string;
}>;

/**
 * Connection-local state used by Durable Object agents. PartyServer persists
 * this value on the individual WebSocket connection, so a later connection
 * cannot overwrite the correlation adopted by an earlier turn.
 */
export type SiteStudioConnectionLoggingState = Readonly<{
  correlation: SiteStudioCorrelation;
  operationalSubject?: string;
  /** Current connection's server-verified JWT; persisted only on that socket's attachment. */
  identityJwt?: string;
}>;

/** Only a verified, separately salted operational subject may become a user principal. */
export function isOperationalSubject(value: unknown): value is string {
  return typeof value === "string" && OPERATIONAL_SUBJECT_RE.test(value);
}

/** Clone the primitive correlation fields and deeply freeze its nested trace. */
function cloneAndFreezeCorrelation(correlation: CailCorrelation): SiteStudioCorrelation {
  const trace = Object.freeze({
    trace_id: correlation.trace_id,
    span_id: correlation.span_id,
    trace_flags: correlation.trace_flags,
  });
  return Object.freeze({
    trace_id: correlation.trace_id,
    span_id: correlation.span_id,
    trace_flags: correlation.trace_flags,
    request_id: correlation.request_id,
    ...(correlation.tracestate ? { tracestate: correlation.tracestate } : {}),
    trace,
  });
}

/**
 * Adopt request correlation into immutable per-connection state. The nested
 * correlation is copied and frozen as well, preventing accidental mutation of
 * one socket's request context while another socket is active in the same DO.
 */
export function createSiteStudioConnectionLoggingState(
  request: Request,
  operationalSubject?: unknown,
  identityJwt?: unknown,
): SiteStudioConnectionLoggingState {
  const parsedCorrelation = correlationFromHeaders(request);
  const correlation = cloneAndFreezeCorrelation(parsedCorrelation);
  const forwardedSubject = request.headers.get(SITE_STUDIO_VERIFIED_OPERATIONAL_SUBJECT_HEADER);
  const subject = operationalSubject ?? forwardedSubject;
  const jwt = typeof identityJwt === "string" && identityJwt ? identityJwt : undefined;
  return Object.freeze({
    correlation,
    ...(isOperationalSubject(subject) ? { operationalSubject: subject } : {}),
    ...(jwt ? { identityJwt: jwt } : {}),
  });
}

export function createSiteStudioLogger(options: {
  sink: CailLogSink;
  env: unknown;
  release?: string;
  clock?: () => number;
}): SiteStudioLogger {
  const environment = parseCailLogEnvironment(options.env);
  if (!environment) {
    throw new TypeError("CAIL_LOG_ENV must be exactly production, staging, development, or test");
  }
  return createCailLogger({
    service: LOG_SERVICE,
    release: options.release ?? LOG_RELEASE,
    env: environment,
    sourceClass: "platform",
    subjectVersion: CAIL_LOG_SUBJECT_VERSION,
    catalog: SITE_STUDIO_EVENT_CATALOG,
    sink: options.sink,
    clock: options.clock,
  });
}

export function createSiteStudioBoundaryLogger(
  env: Pick<Env, "CAIL_FLEET_EVENTS" | "CAIL_LOG_ENV">,
): SiteStudioLogger {
  const environment = parseCailLogEnvironment(env.CAIL_LOG_ENV);
  if (!environment) {
    throw new TypeError("CAIL_LOG_ENV must be exactly production, staging, development, or test");
  }
  return createSiteStudioLogger({
    sink: createSiteStudioBoundarySink(env),
    env: environment,
  });
}

export function createSiteStudioLoggingContext(
  logger: SiteStudioLogger,
  data: SiteStudioLoggingContextData = {},
): SiteStudioLoggingContext {
  const correlation = data.correlation
    ? cloneAndFreezeCorrelation(data.correlation)
    : undefined;
  return Object.freeze({
    logger,
    ...(correlation ? { correlation } : {}),
    ...(data.operationalSubject ? { operationalSubject: data.operationalSubject } : {}),
  });
}

export function createSiteStudioBoundaryContext(
  env: Pick<Env, "CAIL_FLEET_EVENTS" | "CAIL_LOG_ENV">,
  data: SiteStudioLoggingContextData = {},
): SiteStudioLoggingContext {
  return createSiteStudioLoggingContext(createSiteStudioBoundaryLogger(env), data);
}

export function serializeSiteStudioLoggingContext(
  context: SiteStudioLoggingContext | undefined,
): SiteStudioLoggingContextData | undefined {
  if (!context) return undefined;
  const correlation = context.correlation
    ? cloneAndFreezeCorrelation(context.correlation)
    : undefined;
  return Object.freeze({
    ...(correlation ? { correlation } : {}),
    ...(context.operationalSubject ? { operationalSubject: context.operationalSubject } : {}),
  });
}

export function withOperationalSubject(
  context: SiteStudioLoggingContext | undefined,
  operationalSubject?: string,
): SiteStudioLoggingContext | undefined {
  if (!context) return undefined;
  return createSiteStudioLoggingContext(context.logger, {
    correlation: context.correlation,
    operationalSubject,
  });
}

export type LoggingVariables = {
  correlation?: CailCorrelation;
  logger?: SiteStudioLogger;
};

export function getLoggingContext(c: {
  get: (key: "logger" | "correlation") => unknown;
}, operationalSubject?: string): SiteStudioLoggingContext | undefined {
  const logger = c.get("logger") as SiteStudioLogger | undefined;
  if (!logger) return undefined;
  return createSiteStudioLoggingContext(logger, {
    correlation: c.get("correlation") as CailCorrelation | undefined,
    operationalSubject,
  });
}

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
/**
 * Build the log principal from the VERIFIED operational subject (`log_sub`).
 *
 * The operational subject is derived at the identity boundary under a separate
 * salt and is deliberately NOT a reversible transform of the ownership
 * subject. This function used to relabel an ownership subject `cail-<hex>` as
 * `cail-v1-<same hex>`, which put the durable project-owner key into every log
 * line in recoverable form and produced a principal that did not match the one
 * other CAIL services log for the same person.
 *
 * An ownership subject passed here yields an anonymous principal by design.
 */
export function principalForOperationalSubject(
  operationalSubject?: string,
): CailPrincipalFields {
  if (isOperationalSubject(operationalSubject)) {
    return { type: "user", subject: operationalSubject };
  }
  return { type: "anonymous" };
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

type DiagnosticTarget = SiteStudioLogger | SiteStudioLoggingContext;

export function emitDiagnostic(
  severity: DiagnosticSeverity,
  errorType: string,
  fields: {
    operationalSubject?: string;
    status?: number;
    retry_count?: number;
    req_bytes?: number;
  } = {},
  target: DiagnosticTarget | undefined,
): void {
  if (!target) return;
  let context: SiteStudioLoggingContext | undefined;
  let logger: SiteStudioLogger;
  if ("logger" in target) {
    context = target;
    logger = target.logger;
  } else {
    logger = target;
  }
  const event = severity === "info"
    ? SITE_STUDIO_EVENTS.DIAGNOSTIC_INFO
    : severity === "warning"
      ? SITE_STUDIO_EVENTS.DIAGNOSTIC_WARNING
      : SITE_STUDIO_EVENTS.DIAGNOSTIC_ERROR;
  logger.emit(event, {
    product_id: PRODUCT_ID,
    error_type: errorType,
    ...(fields.operationalSubject || context?.operationalSubject
      ? { principal: principalForOperationalSubject(fields.operationalSubject ?? context?.operationalSubject) }
      : {}),
    ...(context?.correlation
      ? {
          request_id: context.correlation.request_id,
          trace: traceFromCorrelation(context.correlation),
        }
      : {}),
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
  private admittedAt: number | undefined;
  private admitted = false;
  private mutationAcknowledged = false;
  private terminal = false;

  constructor(
    private readonly fields: {
      action: keyof typeof OBSERVABILITY_CONTRACT.actions;
      principal: CailPrincipalFields;
      correlation: CailCorrelation;
    },
    private readonly logger: SiteStudioLogger,
    private readonly clock: () => number = Date.now,
    private readonly recorder?: ActionAttemptRecorder,
  ) {
  }

  admit(): void {
    if (this.admitted) return;
    const admittedAt = this.clock();
    const action = OBSERVABILITY_CONTRACT.actions[this.fields.action];
    this.recorder?.admit({
      actionId: this.actionId,
      action: this.fields.action,
      route: action.route,
      admittedAt: new Date(admittedAt).toISOString(),
    });
    this.admittedAt = admittedAt;
    this.admitted = true;
    this.logger.emit(CAIL_EVENTS.ACTION_ADMITTED, {
      action_id: this.actionId,
      product_id: PRODUCT_ID,
      principal: this.fields.principal,
      request_id: this.fields.correlation.request_id,
      trace: traceFromCorrelation(this.fields.correlation),
      http_method: action.method,
      route: action.route,
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
    const terminalAt = this.clock();
    const action = OBSERVABILITY_CONTRACT.actions[this.fields.action];
    this.recorder?.terminal({
      actionId: this.actionId,
      outcome: "ok",
      reason: "completed",
      terminalAt: new Date(terminalAt).toISOString(),
      durationMs: Math.max(0, terminalAt - (this.admittedAt ?? terminalAt)),
    });
    this.terminal = true;
    this.logger.emit(CAIL_EVENTS.ACTION_TERMINAL, {
      action_id: this.actionId,
      product_id: PRODUCT_ID,
      principal: this.fields.principal,
      request_id: this.fields.correlation.request_id,
      trace: traceFromCorrelation(this.fields.correlation),
      http_method: action.method,
      route: action.route,
      terminal: { outcome: "ok", reason: "completed" },
      duration_ms: Math.max(0, terminalAt - (this.admittedAt ?? terminalAt)),
    });
  }

  completeFailure(terminal: FailureTerminal, errorType?: string): void {
    if (!this.admitted || this.terminal) return;
    const terminalAt = this.clock();
    const action = OBSERVABILITY_CONTRACT.actions[this.fields.action];
    this.recorder?.terminal({
      actionId: this.actionId,
      outcome: terminal.outcome,
      reason: terminal.reason,
      terminalAt: new Date(terminalAt).toISOString(),
      durationMs: Math.max(0, terminalAt - (this.admittedAt ?? terminalAt)),
      ...(errorType ? { errorType } : {}),
    });
    this.terminal = true;
    this.logger.emit(CAIL_EVENTS.ACTION_TERMINAL, {
      action_id: this.actionId,
      product_id: PRODUCT_ID,
      principal: this.fields.principal,
      request_id: this.fields.correlation.request_id,
      trace: traceFromCorrelation(this.fields.correlation),
      http_method: action.method,
      route: action.route,
      terminal,
      duration_ms: Math.max(0, terminalAt - (this.admittedAt ?? terminalAt)),
      ...(errorType ? { error_type: errorType } : {}),
    });
  }

  wasAdmitted(): boolean {
    return this.admitted;
  }
}

export function requestLogging(logger?: SiteStudioLogger) {
  return createMiddleware<{
    Bindings: Env;
    Variables: LoggingVariables & { user?: { id: string } };
  }>(async (c, next) => {
    const environment = parseCailLogEnvironment(c.env.CAIL_LOG_ENV);
    if (!environment) return serviceUnavailableResponse();

    const boundaryLogger = logger ?? createSiteStudioBoundaryLogger({
      ...c.env,
      CAIL_LOG_ENV: environment,
    });
    c.set("logger", boundaryLogger);
    const correlation = correlationFromHeaders(c.req.raw);
    c.set("correlation", correlation);
    const started = Date.now();
    const method = httpMethod(c.req.method);
    const route = classifiedRoute(c);

    boundaryLogger.emit(CAIL_EVENTS.REQUEST_RECEIVED, {
      request_id: correlation.request_id,
      product_id: PRODUCT_ID,
      http_method: method,
      route,
      trace: traceFromCorrelation(correlation),
    });

    await next();

    const status = c.res?.status ?? 500;
    const terminal = terminalForStatus(status);
    const user = c.get("user") as
      | { id?: string; operationalSubject?: string }
      | undefined;
    const principal = user?.operationalSubject
      ? principalForOperationalSubject(user.operationalSubject)
      : undefined;
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
      boundaryLogger.emit(CAIL_EVENTS.REQUEST_COMPLETED, {
        ...completedBase,
        terminal,
      });
    } else {
      boundaryLogger.emit(CAIL_EVENTS.REQUEST_COMPLETED, {
        ...completedBase,
        terminal,
        ...(errorType ? { error_type: errorType } : {}),
      });
    }

    if (status === 401 || status === 403) {
      boundaryLogger.emit(CAIL_EVENTS.AUTH_DENIED, {
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

export function getBoundaryLogger(c: {
  get: (key: "logger") => SiteStudioLogger | undefined;
}): SiteStudioLogger | undefined {
  return c.get("logger");
}
