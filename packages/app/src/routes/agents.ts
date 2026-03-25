import { getAgentByName } from "agents";
import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { jsonError } from "../lib/http";
import { getUser } from "../lib/session";
import { sanitizeProjectId } from "../lib/path";
import { R2ProjectStorage } from "../storage/r2";

function agentInstanceName(userId: string, projectId: string): string {
  return `${userId}:${projectId}`;
}

export function createAgentRouter() {
  const app = new Hono<{ Bindings: Env; Variables: { user: { id: string } } }>();

  async function handleAgentRequest(c: Context<{ Bindings: Env; Variables: { user: { id: string } } }>) {
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

    const stub = await getAgentByName(
      c.env.SITE_BUILDER_AGENT,
      agentInstanceName(user.id, projectId),
      {
        props: {
          userId: user.id,
          projectId
        }
      }
    );

    return stub.fetch(c.req.raw);
  }

  app.all("/api/agents/site-builder/:projectId", handleAgentRequest);
  app.all("/api/agents/site-builder/:projectId/*", handleAgentRequest);

  return app;
}
