# CAIL logging alignment

This source alignment uses the exact published `@cuny-ai-lab/cail-log`
`0.6.0`; the committed Bun lockfile resolves that one version for the app.

## Identity and ownership

- Fleet product: `site-studio`
- Worker service: `site-studio-app`
- Kale project identity: none; Site Studio is not deployed through Kale
- Authenticated principal: a verified durable owner key of
  `cail-<32 lowercase hex>` projects to the schema-2 logging subject
  `cail-v1-<32 lowercase hex>`. This is a log representation only; storage,
  Durable Object and handle keys remain the exact identity `sub`.
  Legacy and anonymous owner identifiers remain anonymous.
- The CAIL Gateway/Cloudflare AI Gateway boundary remains authoritative for
  model-call success, token, quota, latency, and spend records. Site Studio does
  not duplicate those events or use application logs as a spend ledger.

## Event and acknowledgement map

| Boundary | Admission | Terminal or diagnostic acknowledgement |
| --- | --- | --- |
| App HTTP request | `cail.request.received` on entry | `cail.request.completed` after Hono produces a response; `cail.auth.denied` additionally for 401/403 |
| Published-site request | `cail.request.received` on app entry | `cail.request.completed` after the app produces a response |
| Agent build | `cail.action.admitted` immediately before the first mutating tool operation | success only after an awaited R2 mutation and the assistant message's Durable Object SQLite persistence/broadcast; failure/cancellation after an admitted mutation gets one terminal event |
| Publish | `cail.action.admitted` after project and handle validation, before slug reservation | success only after the conditional R2 metadata update acknowledges the live published-state change; failure gets one terminal event |
| Service conditions | none | `site_studio.diagnostic.*`, with cail-log's fixed `Service event recorded.` body and a bounded machine `error.type` |

An HTTP completion means that the Worker produced a response, not that the client
received it. Build and publish action success is narrower: it requires the durable
state acknowledgement that makes the result user-visible on a later request.
Logging failures do not replace R2 or Durable Object state as the source of truth.

The project-scoped Durable Object stores a bounded 48-hour action-attempt
record before an admitted build or publish mutation proceeds. A terminal can
only update an existing admission, and the existing authenticated
`/api/projects/{id}/observability` read returns the versioned authoritative
records. Build and publish remain separate action/route pairs. Exact success and
terminal coverage come from these records rather than either log sink.

After an R2 publish commits, the route retries an identical terminal RPC once
because the first rejection may have an ambiguous outcome. If both attempts
remain unavailable, it returns the committed publish result instead of a false
failure and emits `publish_terminal_record_failed`. The durable record then keeps
an admission without a terminal, which the observability read shows. Product
state remains authoritative.

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

`/api/health` is the versioned liveness response. It contains a static monitor
marker, is smaller than Cloudflare's 10 KB body matching limit, and returns
`Cache-Control: no-store`. It reports the deployed Cloudflare version ID and Git
SHA tag when the version-metadata binding supplies canonical values, and `null`
otherwise; the deploy job's release probe waits for the expected version ID. It
does not probe R2, KV, Durable Objects, or the model gateway. Cloudflare's
native request, error, CPU, and wall-time signals remain the canonical
platform-health layer.

`packages/app/src/lib/observability/contract.ts` holds the runtime values the
app reads: the service name and version, the health path and marker, and the
build and publish action route templates and methods. It defines no monitor,
alert threshold, service-level objective, or saved dashboard query; those remain
operator configuration outside this repository. Site Studio has no spend
threshold ledger. Model accounting remains owned by the Gateway.

At each trusted Worker boundary, the logger uses
`fanoutSinks(workersStructuredSink, createAnalyticsEngineSink(...))`. The
library owns the ordered Analytics Engine columns and the
`environment:product_id` sampling index. Site Studio adds only an invocation-
local 32-point guard, safely below Cloudflare's 250-point limit. The projection
keeps cohort but omits stable subjects, request/action IDs, trace IDs, usage
facts, and Kale project identity.

Analytics Engine counts, rates, and percentiles are weighted cohort diagnostics
using `_sample_interval`; they are never exact lifecycle or accounting facts.
Model spend, enforcement, and the authenticated quota estimate remain at the
Cloudflare AI Gateway boundary for the verified user. The estimate is
display-only and may lag analytics; Site Studio does not reproduce that
accounting or invent model limits. Sandbox settlement and cost are outside this
Site Studio observability contract.

## Decisive sources

- The [CAIL Gateway runtime contract](https://github.com/CUNY-AI-Lab/cail-gateway/blob/main/docs/gateway-contract.md),
  [model-admission contract](https://github.com/CUNY-AI-Lab/cail-gateway/blob/main/docs/model-admission-contract.md),
  and [quota design](https://github.com/CUNY-AI-Lab/cail-gateway/blob/main/docs/quota-design.md)
  define the stable `X-CAIL-App` attribution slug, verified user-bound identity
  forwarding, one-attempt streaming calls, provider-native retention admission,
  and Gateway-owned `GET /v1/quota` spend display. Site Studio keeps
  `site-studio` low-cardinality and leaves model accounting at that boundary.
- [Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
  (updated June 9, 2026) recommends structured JSON but documents that default
  invocation logs include request metadata and the request URL. The Wrangler
  config retains structured custom logs at full sampling and sets
  `observability.logs.invocation_logs=false`.
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
  consecutive-state controls. That drove the fixed liveness marker and the
  small static health body.
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

Site Studio surfaces terminal `quota_exceeded` failures. The
gateway ignores caller-supplied `X-CAIL-Metadata`, so local
purpose/project/course labels must not be described as authoritative cost
attribution.
