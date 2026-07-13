# Observability source contract design gate

## Boundary

This change settles the source contract for Site Studio Worker logs, liveness
responses, build/publish action telemetry, and dashboard inputs. It covers the
app Worker and published-site Worker. It does not configure a live monitor,
saved dashboard, exporter, retention policy, alert threshold, or deployment.

## Contract and invariants

- Cloudflare custom logs remain enabled and explicitly persisted using the
  structured `cail-log` records. Invocation logs are disabled in source because
  their fetch message contains the raw request URL.
- Custom logs use full source sampling. Lifecycle completeness and per-user
  action reliability cannot be calculated from independently sampled events.
- `GET /api/health` and `GET /healthz` are versioned liveness checks. They make
  no storage or gateway calls, return a stable body marker within the first
  10 KB, and use `Cache-Control: no-store`.
- A 200 liveness response means that the Worker loaded and dispatched the
  request. It does not claim R2, KV, Durable Object, or model-gateway readiness.
- Build and publish are the only product action kinds. Each kind owns one fixed
  route template. An admitted action emits at most one terminal event, and
  success requires an acknowledged durable mutation.
- Dashboard views consume stable structured fields only: `event.name`,
  `service.name`, `cail.product.id`, `url.template`, `cail.outcome`,
  `http.response.status_code`, `duration_ms`, and bounded `error.type`.
- Logs contain no prompts, generated content, raw URLs, filenames, headers,
  session identifiers, exception messages, or model cost. Gateway model-call
  accounting remains authoritative.

## Evidence and decisions

- Cloudflare Workers Logs documents `observability.logs.invocation_logs=false`
  and states that fetch invocation messages include the request URL. Structured
  JSON custom logs are indexed for field queries.
- Cloudflare Query Builder supports counts, grouped fields, and duration
  percentiles, so no application-owned metrics backend is needed.
- Cloudflare health monitors evaluate an expected status and a relatively
  static body substring within the first 10 KB. The source contract supplies
  both, without configuring a live monitor.
- Cloudflare caching guidance says a 200 without an explicit directive can be
  cached heuristically; health responses therefore return `no-store`.
- SvelteKit server tracing is experimental, has runtime overhead, and applies
  to server-rendered SvelteKit work. Site Studio uses `adapter-static`; request
  and action telemetry belongs at the Worker boundary.
- Cloudflare OTLP export is provider-specific and currently beta. The stable
  source contract remains transport-neutral structured logs.

## Correctness plan

Tests must fail if either Wrangler source enables invocation logs or samples
custom events, if either liveness response changes schema/marker/cache posture,
if action kinds drift from their route templates, or if emitted event fields no
longer satisfy the dashboard contract. Existing privacy, correlation,
admission, persistence-acknowledgement, and one-terminal tests remain required.

## Risks and rollback

Disabling invocation logs removes Cloudflare's raw invocation record, including
some platform-enriched request metadata. Native Worker metrics and errors remain
available, and the application emits safe request terminals. Rollback is a
single Wrangler source change, but accepting raw-URL collection would require a
new explicit privacy decision.

No live state is read or written. No credentials are required. Remaining CAIL
policy inputs are retention duration, alert thresholds, monitor cadence and
regions, the publisher monitor's approved ingress/hostname, and whether/where to
export the already-defined events.
