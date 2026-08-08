# CAIL logging alignment

This source alignment uses the exact published `@cuny-ai-lab/cail-log`
`0.6.0`; the committed Bun lockfile resolves that one version for the app,
publisher, and shared observability workspace package.

## Identity and ownership

- Fleet product: `site-studio`
- Worker services: `site-studio-app` and `site-studio-publisher`
- Kale project identity: none; Site Studio is not deployed through Kale
- Authenticated principal: a verified durable owner key of
  `cail-<32 lowercase hex>` projects to the schema-2 logging subject
  `cail-v1-<32 lowercase hex>`. This is a log representation only; storage,
  Durable Object, handle, and publisher keys remain the exact identity `sub`.
  Legacy and anonymous owner identifiers remain anonymous.
- The CAIL model gateway remains the owner of model-call success, token, quota,
  latency, and spend records. Site Studio does not duplicate those events or use
  application logs as a spend ledger.

## Event and acknowledgement map

| Boundary | Admission | Terminal or diagnostic acknowledgement |
| --- | --- | --- |
| App HTTP request | `cail.request.received` on entry | `cail.request.completed` after Hono produces a response; `cail.auth.denied` additionally for 401/403 |
| Published-site request | `cail.request.received` on publisher entry | `cail.request.completed` after the publisher produces a response |
| Agent build | `cail.action.admitted` immediately before the first mutating tool operation | success only after an awaited R2 mutation and the assistant message's Durable Object SQLite persistence/broadcast; failure/cancellation after an admitted mutation gets one terminal event |
| Publish | `cail.action.admitted` after project and handle validation, before slug reservation | success only after the conditional R2 metadata update acknowledges the live published-state change; failure gets one terminal event |
| Service conditions | none | `site_studio.diagnostic.*` or `site_studio_publisher.diagnostic.warning`, with cail-log's fixed `Service event recorded.` body and a bounded machine `error.type` |

An HTTP completion means that the Worker produced a response, not that the client
received it. Build and publish action success is narrower: it requires the durable
state acknowledgement that makes the result user-visible on a later request.
Logging failures do not replace R2 or Durable Object state as the source of truth.

The project-scoped Durable Object stores a bounded 48-hour action-attempt
record before an admitted build or publish mutation proceeds. A terminal can
only update an existing admission, and the existing authenticated
`/api/projects/{id}/observability` read returns the versioned authoritative
records. Build and publish remain separate action/route pairs. Exact success and
terminal coverage are calculated from these records rather than either log sink.
This owner-scoped application read is not the external `kale-admin` fleet-data
surface described below.

After an R2 publish commits, the route retries an identical terminal RPC once
because the first rejection may have an ambiguous outcome. If both attempts
remain unavailable, it returns the committed publish result instead of a false
failure and emits `publish_terminal_record_failed`; the lifecycle auditor then
surfaces the missing terminal. Product state remains authoritative.

Routes are fixed templates such as `/api/projects/{id}/publish`,
`/api/agents/site-builder/{project_id}`, and `/u/{handle}/{slug}/{path}`. Events do
not contain prompts, generated content, raw URLs, filenames, request headers,
session identifiers, exception messages, model outputs, or free-form log bodies.
W3C `traceparent` input is parsed into atomic trace fields and outbound model-proxy
requests receive correlation headers. The sampling bit is preserved in
`trace_flags`; adopted or minted request IDs are lowercase UUID v4 values.
Workers Logs and Analytics Engine adapters accept only schema-2 events carrying
same-package-instance provenance from `createCailLogger`.

## Workflow and health inventory

Project and file mutations execute through the owner-scoped
`MutationCoordinator`. Single-object writes retain conditional R2 guards;
multi-object create, rename, delete, restore, and replacement flows use a
Durable Object recovery journal. This is an application recovery boundary for
adopted writes, not a native R2 transaction or protection from out-of-band
bucket changes. Account import remains under its separate anonymous-owner
coordinator and conditional copy contract.
Publishing becomes visible when the slug claim and project metadata update are
acknowledged; it is a live flag over mutable project objects, not an immutable
release generation. Agent messages use the installed `@cloudflare/ai-chat`
`0.9.3` persistence path. Its documented `onChatResponse` hook runs after the
assistant message is persisted, so the implementation completes an admitted build
there without overriding the framework's persistence method.

`/api/health` and the publisher's `/healthz` are versioned liveness responses.
Each contains a static monitor marker, is smaller than Cloudflare's 10 KB body
matching limit, and returns `Cache-Control: no-store`. They do not probe R2, KV,
Durable Objects, or the model gateway. Cloudflare's native request/error/CPU/
wall-time signals remain the canonical platform-health layer.

The shared source contract in `packages/observability-core/src/contract.ts`
defines both services, action route templates, dashboard measures/groupings, and
an offline lifecycle-pair auditor. The auditor detects missing or duplicate
request/action events, route drift, and invalid terminal duration in a closed
export window. It evaluates the diagnostic projection, never product state.

Contract version 2 defines the initial operating posture: full-sampled
bounded custom events, invocation logs off, no v1 external exporter, default-
deny `kale-admin` access, a one-minute `ENAM` synthetic profile, rolling 24-hour
SLOs, latency and reliability thresholds, and month-to-date gateway-ledger spend
bands. Its action SLI sub-contract versions admission-window assignment, a
15-minute terminal grace period, exact terminal matching, durable-success
semantics, and separate build/publish denominators.

The initial profile uses one 60-second `ENAM` synthetic check per Worker, a
five-second timeout, two retries, and two consecutive intervals for a state
transition. Reliability uses a rolling 24-hour window evaluated every 15
minutes. Build/publish admissions get a 15-minute terminal grace period.

| Signal | Warning / target | Critical | Minimum sample |
| --- | ---: | ---: | ---: |
| Synthetic availability | below 99.5% | below 99.0% | 100 probes |
| Non-health request reliability | below 99.5% | below 98.0% | 100 requests |
| Build/publish success | below 95.0% | below 80.0% | 10 actions |
| Build/publish terminal coverage | below 99.5% | below 98.0% | 10 actions |

Request p95 latency warns above five seconds for the app and one second for the
publisher. Action p95 warns above ten minutes for build and 30 seconds for
publish; critical latency is twice the warning threshold. Spend is
calendar-month-to-date UTC from the gateway ledger, with bands at 80%, 95%, and
100% of the externally approved product budget.

Contract version 3 adds the fleet projection without changing that privacy
posture. At each trusted Worker boundary, the logger uses
`fanoutSinks(workersStructuredSink, createAnalyticsEngineSink(...))`. The
library owns the ordered Analytics Engine columns and the
`environment:product_id` sampling index. Site Studio adds only an invocation-
local 32-point guard, safely below Cloudflare's 250-point limit. The projection
keeps cohort but omits stable subjects, request/action IDs, trace IDs, usage
facts, and Kale project identity.

Analytics Engine counts, rates, and percentiles are weighted cohort diagnostics
using `_sample_interval`; they are never exact lifecycle or accounting facts.
Model spend and the native $10 model limit come from CAIL gateway/key-service
accounting. Sandbox settlement and cost come from Sandbox accounting. Site
Studio does not reproduce either ledger.

## Decisive sources

- The local CAIL gateway `docs/INTEGRATION.md` defines the stable
  `X-CAIL-App` attribution slug, user-bound identity forwarding, single-attempt
  streaming calls, and gateway-owned quota/spend contract. Site Studio keeps
  `site-studio` low-cardinality and leaves model accounting at that boundary.
- [Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
  (updated June 9, 2026) recommends structured JSON but documents that default
  invocation logs include request metadata and the request URL. Both Wrangler
  sources explicitly retain structured custom logs at full sampling and set
  `observability.logs.invocation_logs=false`.
- [Cloudflare Query Builder](https://developers.cloudflare.com/workers/observability/query-builder/)
  (updated April 23, 2026) supports counts, grouping, and duration percentiles
  over structured fields. The source contract records those dashboard-ready
  measures without creating or mutating a live saved query.
- [Workers Analytics Engine write guidance](https://developers.cloudflare.com/workers/examples/analytics-engine/)
  (updated April 2026) documents non-blocking binding writes and the single
  index used as the sampling key. The source adapter uses the pinned
  cail-log projection instead of defining local column positions.
- [Workers Analytics Engine sampling](https://developers.cloudflare.com/analytics/analytics-engine/sampling/)
  and [SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)
  (updated April 23, 2026) require `_sample_interval` weighting for counts,
  sums, averages, and quantiles. This rules out exact action coverage and
  identifiable-user conclusions from the fleet dataset.
- [Workers Analytics Engine limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/)
  (updated April 23, 2026) allows 250 points per Worker invocation, one index,
  20 blobs, and 20 doubles, with three-month provider retention. Site Studio's
  source guard caps its projection at 32 points and leaves institutional
  retention approval separate.
- [SQLite-backed Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
  (updated May 27, 2026) is transactional, strongly consistent, and private to
  one object instance. [Durable Object RPC](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/)
  (updated April 21, 2026) provides ordered calls to public object methods. The
  existing owner/project agent object therefore owns the action denominator and
  terminal store without a new binding or route.
- [Cloudflare Load Balancing monitors](https://developers.cloudflare.com/load-balancing/monitors/create-monitor/)
  (updated April 16, 2026) evaluate expected status and a relatively static body
  substring within the first 10 KB and document interval, timeout, retry, and
  consecutive-state controls. That drove the fixed liveness markers and the
  conservative one-minute monitor profile.
- [Cloudflare Health Check regions](https://developers.cloudflare.com/health-checks/concepts/health-checks-regions/)
  (updated April 16, 2026) documents three data centers per selected region and
  majority health. The initial CUNY-centered check uses `ENAM`; adding every
  region would add traffic without improving the initial source seam.
- [Cloudflare Health Check notifications](https://developers.cloudflare.com/health-checks/how-to/health-checks-notifications/)
  (updated April 16, 2026) supports state-change notification after regional
  majority. The source recipe notifies for failure and recovery while leaving
  actual recipients external.
- [Cloudflare HTTP traffic alerts](https://developers.cloudflare.com/notifications/reference/traffic-alerts/)
  (updated April 24, 2026) recommends multi-window burn-rate alerting and warns
  about high sensitivity on low traffic. That drove explicit sample floors and
  two consecutive evaluations alongside the fast native health transition.
- [Cloudflare cache configuration](https://developers.cloudflare.com/workers/cache/configuration/)
  (updated July 6, 2026) documents heuristic caching for a 200 without an
  explicit directive. Health responses therefore use `Cache-Control: no-store`.
- [Cloudflare Workers Observability](https://developers.cloudflare.com/workers/observability/)
  (updated July 3, 2026) documents native metrics and tracing. It kept health and
  infrastructure collection out of the application event catalog.
- [Cloudflare OTLP export](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/)
  (updated July 5, 2026) supports logs and traces but not metrics and is marked
  beta. No provider-specific exporter was added to application source.
- [Cloudflare Agents chat persistence](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/)
  and [autonomous responses](https://developers.cloudflare.com/agents/communication-channels/chat/autonomous-responses/)
  (updated June 26, 2026) informed the durable-message acknowledgement. Their
  hook guidance matches the installed `@cloudflare/ai-chat` version; Site Studio
  uses the hook without overriding framework persistence.
- [SvelteKit observability](https://svelte.dev/docs/kit/observability) documents
  experimental server tracing with nontrivial overhead. Site Studio uses
  `adapter-static`, so no Svelte server or browser telemetry was added; the
  Worker boundaries remain authoritative.
- [Hono route helper](https://hono.dev/docs/helpers/route) replaced deprecated
  request route access with `matchedRoutes()` for safe templates.
- The stable [OpenTelemetry Logs data model](https://opentelemetry.io/docs/specs/otel/logs/data-model/)
  supports event names as schema identifiers and top-level trace correlation.
  [OpenTelemetry semantic conventions](https://opentelemetry.io/docs/specs/semconv/)
  are versioned; the [HTTP conventions](https://opentelemetry.io/docs/specs/semconv/http/)
  retain migration/unstable guidance, so the canonical CAIL catalog remains the
  application contract instead of copying provider fields ad hoc.
- The [W3C Trace Context Recommendation](https://www.w3.org/TR/trace-context/)
  (November 23, 2021) requires interoperable trace propagation and cautions
  against placing personally identifiable information in trace fields.
- The [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
  drove bounded validation, exclusion of secrets and personal content, and the
  rule that logging failure must not break the application workflow.

## Source-ready boundary

No dataset, binding, secret, ingress, spend rule, live Cloudflare setting, saved
query, monitor, exporter, or production state is created here. The source
declares a compatible dependency range and the committed lockfile records the
reviewed resolution. Fleet projection remains inert unless an
operator provisions or confirms the `cail_fleet_events_v1` Analytics Engine
dataset and binds it to both Workers as `CAIL_FLEET_EVENTS`. Production
hostnames/ingress, notification recipients, institution-approved retention,
the approved monthly product budget, secrets, and deployment authorization also
remain external.

Site Studio surfaces terminal `quota_exceeded` failures and proxies the typed
Cloudflare-managed `GET /quota` usage estimate to the authenticated UI. The
gateway ignores caller-supplied `X-CAIL-Metadata`, so local
purpose/project/course labels must not be described as authoritative cost
attribution.
