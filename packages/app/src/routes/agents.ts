import { getAgentByName } from "agents";
import { Hono, type Context } from "hono";
import type { Env, SiteBuilderAgentProps } from "../types";
import { CSRF_ERROR_BODY, getCsrfToken, verifyWsUpgrade } from "../lib/csrf";
import { jsonError } from "../lib/http";
import { getCailGatewayJwt, getUser } from "../lib/session";
import { sanitizeProjectId } from "../lib/path";
import { R2ProjectStorage } from "../storage/r2";
import { SITE_STUDIO_AGENT_PROPS_HEADER } from "../lib/agent-identity";
import {
  getCorrelation,
  getLoggingContext,
  isOperationalSubject,
  SITE_STUDIO_VERIFIED_OPERATIONAL_SUBJECT_HEADER,
  type LoggingVariables,
} from "../lib/logging";
import { outboundCorrelationHeaders } from "@cuny-ai-lab/cail-log";

type AgentRouterVariables = LoggingVariables & { user: { id: string }; cailIdentityJwt?: string };

function agentInstanceName(userId: string, projectId: string): string {
  return `${userId}:${projectId}`;
}

/**
 * Correlation propagation (cail-log L7, "adopt, never regenerate"): stamp the
 * request forwarded into the SiteBuilderAgent Durable Object with this
 * request's `traceparent` + `X-CAIL-Request-Id` so the agent's events — and
 * its onward CAIL gateway/model-proxy calls — share the boundary's trace.
 */
function withCorrelationHeaders(
  request: Request,
  c: Context<{ Bindings: Env; Variables: AgentRouterVariables }>,
  operationalSubject?: string,
  identityJwt?: string | null,
): Request {
  const correlation = getCorrelation(c);
  const forwarded = new Request(request);
  // This header is an internal server-owned channel. Always overwrite a
  // caller-supplied value so a browser cannot choose the log principal; an
  // absent verified subject is represented by deletion and must clear any
  // previous connection state at the agent boundary.
  forwarded.headers.delete(SITE_STUDIO_VERIFIED_OPERATIONAL_SUBJECT_HEADER);
  if (isOperationalSubject(operationalSubject)) {
    forwarded.headers.set(SITE_STUDIO_VERIFIED_OPERATIONAL_SUBJECT_HEADER, operationalSubject);
  }
  // PartyServer's props header is also a server-owned channel here. Drop any
  // browser-supplied value before carrying the current middleware-selected JWT
  // to this connection; a missing token deliberately clears prior state.
  forwarded.headers.delete(SITE_STUDIO_AGENT_PROPS_HEADER);
  if (typeof identityJwt === "string" && identityJwt) {
    forwarded.headers.set(SITE_STUDIO_AGENT_PROPS_HEADER, JSON.stringify({ identityJwt }));
  }
  if (correlation) {
    for (const [name, value] of Object.entries(outboundCorrelationHeaders(correlation))) {
      forwarded.headers.set(name, value);
    }
  }
  return forwarded;
}

function noStoreResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function createAgentRouter() {
  const app = new Hono<{ Bindings: Env; Variables: AgentRouterVariables }>();

  async function loadAgentStub(c: Context<{ Bindings: Env; Variables: AgentRouterVariables }>) {
    const user = getUser(c);
    const rawProjectId = c.req.param("projectId");

    if (!rawProjectId) {
      return jsonError("Project not found", 404);
    }

    const projectId = sanitizeProjectId(rawProjectId);
    const storage = new R2ProjectStorage(
      c.env.SITE_STUDIO_BUCKET,
      getLoggingContext(c, user.operationalSubject),
    );

    if (!(await storage.projectExists(user.id, projectId))) {
      return jsonError("Project not found", 404);
    }

    // Forward the verified caller JWT into the Durable Object so a new socket's
    // connection-local state can present it to the CAIL model proxy. Later
    // user-driven turns use the authenticated refresh route below to replace
    // that state on the same socket.
    const props: SiteBuilderAgentProps = {
      userId: user.id,
      projectId,
      identityJwt: getCailGatewayJwt(c) ?? undefined,
      ...(isOperationalSubject(user.operationalSubject)
        ? { operationalSubject: user.operationalSubject }
        : {}),
    };

    return getAgentByName(
      c.env.SITE_BUILDER_AGENT,
      agentInstanceName(user.id, projectId),
      { props }
    );
  }

  async function handleAgentRequest(c: Context<{ Bindings: Env; Variables: AgentRouterVariables }>) {
    const user = getUser(c);
    // Rule 4 (docs/INTEGRATION.md §3¾): origin-check + token-gate WebSocket
    // upgrades BEFORE accepting. The browser enforces no same-origin policy on
    // WS handshakes. The identity JWT is captured on connect, then replaced by
    // the authenticated refresh route immediately before each model frame.
    //
    // Judgment call on "gate the first state-changing WS message on your CSRF
    // token": the WS message protocol is owned by @cloudflare/ai-chat, so we
    // cannot inject a per-message token check without forking it. Token
    // possession is instead proven at accept — the `?csrf=` param must match
    // the session token before the upgrade is forwarded — which satisfies the
    // contract at the connection boundary: no state-changing message can exist
    // on the wire before the token has been verified.
    const upgrade = c.req.header("Upgrade") ?? "";
    if (upgrade.toLowerCase() === "websocket") {
      const url = new URL(c.req.url);
      const accepted = verifyWsUpgrade({
        // Browsers always send Origin on WS upgrades; a present-but-foreign
        // Origin fails even with a valid token. An absent Origin (non-browser
        // test client) is accepted only when the token itself is valid.
        origin: c.req.header("Origin") ?? null,
        requestOrigin: url.origin,
        appPublicDomain: c.env.APP_PUBLIC_DOMAIN,
        presentedToken: url.searchParams.get("csrf"),
        expectedToken: await getCsrfToken(c.env.SITE_STUDIO_BUCKET, user.id)
      });

      if (!accepted) {
        return c.json(CSRF_ERROR_BODY, 403);
      }

      const stub = await loadAgentStub(c);
      if (stub instanceof Response) {
        return stub;
      }

      // Strip the csrf param before forwarding so the token never reaches the
      // Durable Object (or its logs/history).
      url.searchParams.delete("csrf");
      return stub.fetch(
        withCorrelationHeaders(
          new Request(url.toString(), c.req.raw),
          c,
          user.operationalSubject,
          getCailGatewayJwt(c),
        ),
      );
    }

    // Non-WS requests: mutations (POSTs) to this route are covered by the
    // app-level csrfProtect middleware in app.ts like every other /api route.
    const stub = await loadAgentStub(c);
    if (stub instanceof Response) {
      return stub;
    }

    return stub.fetch(
      withCorrelationHeaders(c.req.raw, c, user.operationalSubject, getCailGatewayJwt(c)),
    );
  }

  async function refreshAgentCredential(c: Context<{ Bindings: Env; Variables: AgentRouterVariables }>) {
    const gatewayJwt = getCailGatewayJwt(c);
    if (!gatewayJwt) {
      return new Response(JSON.stringify({ error: "authentication_required" }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    }

    const user = getUser(c);
    const stub = await loadAgentStub(c);
    if (stub instanceof Response) {
      return noStoreResponse(stub);
    }

    // The Gateway leg is selected by verified Doorway middleware on this
    // ordinary HTTP request and forwarded through the server-owned props
    // channel. The browser receives only the empty success response.
    const request = new Request(c.req.raw);
    const response = await stub.fetch(
      withCorrelationHeaders(request, c, user.operationalSubject, gatewayJwt),
    );
    return noStoreResponse(response);
  }

  app.get("/api/projects/:projectId/observability", async (c) => {
    const stub = await loadAgentStub(c);
    if (stub instanceof Response) {
      return stub;
    }

    return c.json(await stub.getObservability());
  });

  app.post("/api/agents/site-builder/:projectId/refresh-credential", refreshAgentCredential);
  app.all("/api/agents/site-builder/:projectId", handleAgentRequest);
  app.all("/api/agents/site-builder/:projectId/*", handleAgentRequest);

  return app;
}
