# Observability source contract design gate

## Boundary

This change settles the source contract for Site Studio Worker logs, liveness
responses, build/publish action telemetry, monitor payloads, SLOs, alerts, and
dashboard inputs. It covers the app Worker and published-site Worker. It does
not create a live monitor, saved dashboard, exporter, retention policy, or
deployment.

## Contract and invariants

- Cloudflare custom logs remain enabled and explicitly persisted using the
  structured `cail-log` records. Invocation logs are disabled in source because
  their fetch message contains the raw request URL.
- Custom logs use full source sampling. Lifecycle completeness and per-user
  action reliability cannot be calculated from independently sampled events.
- Observability resources default-deny unless the viewer has the `kale-admin`
  role. The initial telemetry version uses Cloudflare-native logs and metrics
  only; it has no external exporter.
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

## Initial operating profile

The shared contract encodes one standalone HTTPS Health Check per Worker. Each
check runs every 60 seconds from Eastern North America (`ENAM`), with a five-
second timeout, two retries, and two consecutive failed or successful intervals
before a state transition. Cloudflare runs a selected region from three data
centers and decides regional health by majority. One CUNY-local region gives an
independent quorum without multiplying probe traffic across every region. Checks
require status 200, the service's fixed body marker, TLS validation, and no
redirect following. Health notifications cover both failure and recovery.

Reliability uses a rolling 24-hour window evaluated every 15 minutes. Two
consecutive breached evaluations alert unless the contract names an immediate
telemetry-integrity failure. Initial thresholds are deliberately conservative:

| Signal | Warning / target | Critical | Minimum sample |
| --- | ---: | ---: | ---: |
| Synthetic availability | below 99.5% | below 99.0% | 100 probes |
| Non-health request reliability | below 99.5% | below 98.0% | 100 requests |
| Build/publish success | below 95.0% | below 80.0% | 10 actions |
| Build/publish terminal coverage | below 99.5% | below 98.0% | 10 actions |

Request reliability excludes denied and client-error outcomes from its
denominator; its numerator is `ok`. Request p95 latency warns above five seconds
for the app and one second for the publisher, and becomes critical at twice the
warning threshold. Action p95 latency warns above ten minutes for build and 30
seconds for publish, and becomes critical at twice the warning threshold. Low-
volume windows stay visible as insufficient data instead of being called healthy
or unhealthy.

Spend is calendar-month-to-date UTC, summed from the CAIL gateway usage ledger
for `product_id=site-studio`. It warns at 80%, becomes critical at 95%, and is
exhausted at 100% of `monthly_budget_micro_usd`. Site Studio logs are never a
spend ledger. The approved product-wide monthly budget is a named CAIL policy
input: the local budget plan defines a per-user 30-day tripwire but leaves the
institutional monthly load open.

## Versioned action denominator

Build and publish are always separate series. Version 1 assigns an action to the
window containing its `cail.action.admitted` event. An admission is eligible only
when it is at least 15 minutes before the window end, allowing its terminal grace
period to expire. Every unique eligible admission is in the denominator,
including failed and cancelled actions; read-only chat never admitted as an
action is not.

Success requires exactly one matching `cail.action.terminal` with outcome `ok`.
Coverage requires exactly one matching terminal with any outcome. A terminal
matches on service, fixed route template, action ID, principal type and subject,
plus request ID when present. Success continues to mean an acknowledged durable
mutation. Duplicate admissions or terminals, route drift, and unknown action
routes are immediate telemetry-quality criticals rather than successes. These
rules live in the versioned TypeScript contract and have compile/runtime tests.

## Evidence and decisions

- Cloudflare Workers Logs documents `observability.logs.invocation_logs=false`
  and states that fetch invocation messages include the request URL. Structured
  JSON custom logs are indexed for field queries.
- Cloudflare Query Builder supports counts, grouped fields, and duration
  percentiles, so no application-owned metrics backend is needed.
- Cloudflare health monitors evaluate an expected status and a relatively
  static body substring within the first 10 KB. The source contract supplies
  both and an API-ready standalone Health Check payload, without configuring a
  live monitor. Cloudflare's documented examples use 60-second intervals and
  five-second timeouts; region checks use three data centers and majority state.
- Cloudflare recommends multi-window, multi-burn-rate traffic alerts, but also
  warns that short high-sensitivity alerts are a poor fit for low traffic. Site
  Studio therefore starts with a 24-hour product window, sample floors, and two
  consecutive 15-minute evaluations. Native monitor state changes remain the
  fast outage signal.
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

No live state is read or written. No credentials are required. Remaining inputs
are the actual production hostnames/ingress, notification recipients, the
institution-approved retention duration, the approved product-wide monthly
budget in micro-dollars, secrets, and deployment authorization. Thresholds,
cadence, region, access posture, sampling, and the no-exporter v1 decision are no
longer open.
