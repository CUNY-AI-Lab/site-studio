/**
 * Structured logging for the site-studio worker, via the shared
 * `@cuny-ai-lab/cail-log` primitive (CAIL fleet logging standard).
 *
 * ONE wide event per unit of work: the request-boundary middleware below emits
 * a single `request.completed` (or `auth.denied`) event when the response is
 * known, carrying only the typed safe-to-log allowlist — the pseudonymous
 * subject (NEVER email), correlation ids, the CLASSIFIED route (a Hono route
 * pattern, never a raw URL), method, status, outcome, and duration. Prompts,
 * completions, file contents, emails, keys, and header values are structurally
 * impossible to log: the logger has no free-text parameter and drops unknown
 * keys.
 *
 * Correlation follows the fleet contract ("adopt, never regenerate"): inbound
 * `traceparent` / `X-CAIL-Request-Id` are adopted at the boundary, stored on
 * the request context, forwarded to the SiteBuilderAgent Durable Object, and
 * attached (via {@link withCorrelationFetch}) to every outbound CAIL
 * gateway/model-proxy call so one user action is followable end to end.
 */

import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import {
  CAIL_EVENTS,
  correlationFromHeaders,
  createCailLogger,
  outboundCorrelationHeaders,
  type CailCorrelation,
  type CailLogger,
  type CailOutcome,
} from "@cuny-ai-lab/cail-log";

/** The fleet service slug for every event this worker emits. */
export const LOG_SERVICE = "site-studio";

/**
 * The one process-wide logger. Default sink: one JSON object per event on
 * `console.log`, which Workers Logs indexes per key.
 */
export const log: CailLogger = createCailLogger({ service: LOG_SERVICE });

/** Context variables the boundary middleware provides to downstream handlers. */
export type LoggingVariables = {
  correlation?: CailCorrelation;
};

/** Mint a fresh correlation (used when no inbound headers exist, e.g. a DO woken without a captured request). */
export function mintCorrelation(): CailCorrelation {
  return correlationFromHeaders({ get: () => null });
}

/** Normalized outcome for an HTTP status (fleet vocabulary). */
export function outcomeForStatus(status: number): CailOutcome {
  if (status >= 500) return "error";
  if (status === 401 || status === 403) return "denied";
  if (status >= 400) return "client_error";
  return "ok";
}

/**
 * Stable, content-free machine code for an error: the error CLASS name,
 * slugified. Never the error message — messages can interpolate user input.
 */
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

/**
 * The CLASSIFIED route label for a request: the matched Hono route pattern
 * (e.g. `/api/projects/:id/files`), never the raw URL (which can carry user
 * content in path segments or query strings). Falls back to "unclassified"
 * when only wildcard middleware matched (assets, 404s).
 */
export function classifiedRoute(c: Context): string {
  const routes = c.req.matchedRoutes;
  for (let i = routes.length - 1; i >= 0; i -= 1) {
    const path = routes[i]?.path;
    if (path && path !== "*" && path !== "/*") {
      return path;
    }
  }
  return "unclassified";
}

/**
 * Wrap a fetch implementation so every outbound call carries this request's
 * correlation (`traceparent` + `X-CAIL-Request-Id`), letting the CAIL
 * gateway/model proxy log spend under the same trace. Used for the AI-SDK
 * chat path and the image generation/moderation calls.
 */
export function withCorrelationFetch(
  correlation: CailCorrelation,
  fetchImpl: typeof fetch = fetch
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

/**
 * Request-boundary middleware: adopt/mint correlation at entry, expose it via
 * `c.get("correlation")`, and emit exactly ONE wide event once the response is
 * known. 401/403 responses are emitted as `auth.denied`; everything else as
 * `request.completed`. Hono's per-frame error handling means `await next()`
 * resolves even when a handler throws (app.onError shapes the response first),
 * so `c.res.status` and `c.error` are always available here.
 */
export function requestLogging() {
  return createMiddleware<{
    Variables: LoggingVariables & { user?: { id: string } };
  }>(async (c, next) => {
    const correlation = correlationFromHeaders(c.req.raw);
    c.set("correlation", correlation);
    const started = Date.now();

    await next();

    const status = c.res?.status ?? 500;
    const outcome = outcomeForStatus(status);
    // The session user is set by authMiddleware during next(); its id is the
    // pseudonymous CAIL subject (or an anonymous `user_…` id) — never email.
    const user = c.get("user") as { id?: string } | undefined;

    const level = outcome === "error" ? "error" : outcome === "ok" ? "info" : "warn";
    const event = outcome === "denied" ? CAIL_EVENTS.AUTH_DENIED : CAIL_EVENTS.REQUEST_COMPLETED;

    log.log(level, event, {
      ...correlation,
      subject: typeof user?.id === "string" ? user.id : undefined,
      http_method: c.req.method,
      route: classifiedRoute(c),
      status,
      outcome,
      duration_ms: Date.now() - started,
      error_code: c.error ? errorCodeFrom(c.error) : undefined,
    });
  });
}

/** The verified per-request correlation, when the boundary middleware ran. */
export function getCorrelation(c: {
  get: (key: "correlation") => CailCorrelation | undefined;
}): CailCorrelation | undefined {
  return c.get("correlation");
}
