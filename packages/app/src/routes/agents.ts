import { getAgentByName } from "agents";
import { Hono, type Context } from "hono";
import type { Env, SiteBuilderAgentProps } from "../types";
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
