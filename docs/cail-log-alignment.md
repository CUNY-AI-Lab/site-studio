# CAIL logging alignment

This source alignment uses `@cuny-ai-lab/cail-log` at the reviewed immutable commit
`862067d3ac83d0cde456eb38d3a6bad6df0476e5`. Both Bun workspace dependencies pin
that full SHA.

## Identity and ownership

- Fleet product: `site-studio`
- Worker services: `site-studio-app` and `site-studio-publisher`
- Kale project identity: none; Site Studio is not deployed through Kale
- Authenticated principal: only a verified `cail-` subject with 32 lowercase hex
  characters. Legacy and anonymous owner identifiers remain anonymous.
- The CAIL model gateway remains the owner of model-call success, token, quota,
  latency, and spend records. Site Studio does not duplicate those events or use
  application logs as a spend ledger.

## Event and acknowledgement map

| Boundary | Admission | Terminal or diagnostic acknowledgement |
| --- | --- | --- |
| App HTTP request | `cail.request.received` on entry | `cail.request.completed` after Hono produces a response; `cail.auth.denied` additionally for 401/403 |
| Published-site request | `cail.request.received` on publisher entry | `cail.request.completed` after the publisher produces a response |
| Agent build | `cail.action.admitted` immediately before the first mutating tool operation | success only after an awaited R2 mutation and the assistant message's Durable Object SQLite persistence/broadcast; failure/cancellation after an admitted mutation gets one terminal event |
| Publish | `cail.action.admitted` after project and handle validation, before slug reservation | success only after the conditional R2 metadata update acknowledges the published generation; failure gets one terminal event |
| Service conditions | none | fixed-body `site_studio.diagnostic.*` or `site_studio_publisher.diagnostic.warning`, with a bounded machine `error.type` |

An HTTP completion means that the Worker produced a response, not that the client
received it. Build and publish action success is narrower: it requires the durable
state acknowledgement that makes the result user-visible on a later request.
Logging failures do not replace R2 or Durable Object state as the source of truth.

Routes are fixed templates such as `/api/projects/{id}/publish`,
`/api/agents/site-builder/{project_id}`, and `/u/{handle}/{slug}/{path}`. Events do
not contain prompts, generated content, raw URLs, filenames, request headers,
session identifiers, exception messages, model outputs, or free-form log bodies.
W3C `traceparent` input is parsed into atomic trace fields and outbound model-proxy
requests receive correlation headers.

## Workflow and health inventory

Project mutations await R2 `put`, conditional metadata writes, deletes, or copy
operations. Publishing becomes visible when the slug claim and project metadata
generation are committed. Agent messages use the installed `@cloudflare/ai-chat`
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

## Decisive sources

- The local CAIL gateway `docs/INTEGRATION.md` defines the stable
  `X-CAIL-App` attribution slug, user-bound identity forwarding, single-attempt
  streaming calls, and gateway-owned quota/spend contract. Site Studio keeps
  `site-studio` low-cardinality and leaves model accounting at that boundary.
- [Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
  (updated June 9, 2026) recommends structured JSON but documents that default
  invocation logs include request metadata and the request URL. Both Wrangler
  sources now explicitly retain structured custom logs at full sampling and set
  `observability.logs.invocation_logs=false`.
- [Cloudflare Query Builder](https://developers.cloudflare.com/workers/observability/query-builder/)
  (updated April 23, 2026) supports counts, grouping, and duration percentiles
  over structured fields. The source contract records those dashboard-ready
  measures without creating or mutating a live saved query.
- [Cloudflare Load Balancing monitors](https://developers.cloudflare.com/load-balancing/monitors/create-monitor/)
  (updated April 16, 2026) evaluate expected status and a relatively static body
  substring within the first 10 KB. That drove the fixed liveness markers.
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
  hook guidance now matches the upgraded `@cloudflare/ai-chat` version and replaced
  the earlier persistence override.
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
  retain migration/unstable guidance, so the reviewed CAIL catalog remains the
  application contract instead of copying provider fields ad hoc.
- The [W3C Trace Context Recommendation](https://www.w3.org/TR/trace-context/)
  (November 23, 2021) requires interoperable trace propagation and cautions
  against placing personally identifiable information in trace fields.
- The [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
  drove bounded validation, exclusion of secrets and personal content, and the
  rule that logging failure must not break the application workflow.

## Source-ready boundary

No bindings, secrets, ingress, spend rules, live Cloudflare settings, saved
queries, monitors, exporters, or production state are changed here. There is no
reviewed-commit dependency blocker: the exact cail-log commit is available and
pinned. Source privacy, health, action seams, and dashboard fields are settled.
Remaining operations-owned policy inputs are retention duration, alert
thresholds, monitor cadence/regions, the publisher monitor's approved
ingress/hostname, and whether/where to export the events.
