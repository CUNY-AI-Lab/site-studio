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

`/api/health` is a liveness response only. It does not probe R2, KV, Durable
Objects, or the model gateway. The publisher has no dedicated health route.
Cloudflare's native request/error/CPU/wall-time signals remain the canonical
platform-health layer; adding dependency probes or exporters would be a separate
operational decision.

## Decisive sources

- The local CAIL gateway `docs/INTEGRATION.md` defines the stable
  `X-CAIL-App` attribution slug, user-bound identity forwarding, single-attempt
  streaming calls, and gateway-owned quota/spend contract. Site Studio keeps
  `site-studio` low-cardinality and leaves model accounting at that boundary.
- [Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
  (updated June 9, 2026) recommends structured JSON but documents that default
  invocation logs include request metadata and the request URL. This implementation
  emits only safe templates. Before a production pilot, operators must either
  disable invocation logs or explicitly accept/redact their raw-URL exposure.
  Changing that production setting is outside this source-only task.
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

No bindings, secrets, ingress, spend rules, Cloudflare observability settings, or
production state are changed here. There is no reviewed-commit dependency blocker:
the exact cail-log commit is available and pinned. The remaining pre-pilot decision
is operational, not a source dependency: Cloudflare invocation-log URL handling.
