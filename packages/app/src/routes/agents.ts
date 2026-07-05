import { getAgentByName } from "agents";
import { Hono, type Context } from "hono";
import type { Env, SiteBuilderAgentProps } from "../types";
import { CSRF_ERROR_BODY, getCsrfToken, verifyWsUpgrade } from "../lib/csrf";
import { jsonError } from "../lib/http";
import { getCailIdentityJwt, getUser } from "../lib/session";
import { sanitizeProjectId } from "../lib/path";
import { R2ProjectStorage } from "../storage/r2";

type AgentRouterVariables = { user: { id: string }; cailIdentityJwt?: string };

function agentInstanceName(userId: string, projectId: string): string {
  return `${userId}:${projectId}`;
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
    const storage = new R2ProjectStorage(c.env.SITE_STUDIO_BUCKET);

    if (!(await storage.projectExists(user.id, projectId))) {
      return jsonError("Project not found", 404);
    }

    // Forward the verified caller JWT into the Durable Object so the model call
    // can present it to the CAIL model proxy. Captured at connection time; on a
    // long-lived WebSocket it can outlive the JWT's ~5-min TTL (see PR flag).
    const props: SiteBuilderAgentProps = {
      userId: user.id,
      projectId,
      identityJwt: getCailIdentityJwt(c) ?? undefined
    };

    return getAgentByName(
      c.env.SITE_BUILDER_AGENT,
      agentInstanceName(user.id, projectId),
      { props }
    );
  }

  async function handleAgentRequest(c: Context<{ Bindings: Env; Variables: AgentRouterVariables }>) {
    // Rule 4 (docs/INTEGRATION.md §3¾): origin-check + token-gate WebSocket
    // upgrades BEFORE accepting. The browser enforces no same-origin policy on
    // WS handshakes, and the identity JWT is captured once at accept with no
    // second chance, so this boundary is the only place the check can live.
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
      const user = getUser(c);
      const url = new URL(c.req.url);
      const accepted = verifyWsUpgrade({
        // Browsers always send Origin on WS upgrades; a present-but-foreign
        // Origin fails even with a valid token. An absent Origin (non-browser
        // test client) is accepted only when the token itself is valid.
        origin: c.req.header("Origin") ?? null,
        requestOrigin: url.origin,
        appPublicDomain: c.env.APP_PUBLIC_DOMAIN,
        presentedToken: url.searchParams.get("csrf"),
        expectedToken: await getCsrfToken(c.env.SESSION_KV, user.id)
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
      return stub.fetch(new Request(url.toString(), c.req.raw));
    }

    // Non-WS requests: mutations (POSTs) to this route are covered by the
    // app-level csrfProtect middleware in app.ts like every other /api route.
    const stub = await loadAgentStub(c);
    if (stub instanceof Response) {
      return stub;
    }

    return stub.fetch(c.req.raw);
  }

  app.get("/api/projects/:projectId/observability", async (c) => {
    const stub = await loadAgentStub(c);
    if (stub instanceof Response) {
      return stub;
    }

    return c.json(await stub.getObservability());
  });

  app.all("/api/agents/site-builder/:projectId", handleAgentRequest);
  app.all("/api/agents/site-builder/:projectId/*", handleAgentRequest);

  return app;
}
