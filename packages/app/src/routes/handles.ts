import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { getUser } from "../lib/session";
import { checkHandle, claimHandle, getUserHandle } from "../lib/handles";

/**
 * Public-handle API. All routes require the session (mounted behind
 * authMiddleware in index.ts). Responses expose only the handle string, never
 * the owner/subject id.
 */
export function createHandleRouter() {
  const app = new Hono<{ Bindings: Env; Variables: { user: { id: string } } }>();

  // The current user's handle (or null if they have not claimed one).
  app.get("/api/handle", async (c) => {
    const user = getUser(c);
    const handle = await getUserHandle(c.env.SITE_STUDIO_BUCKET, user.id);
    return c.json({ handle });
  });

  // Validate + availability check for a candidate handle.
  app.get("/api/handle/check", async (c) => {
    const candidate = c.req.query("handle") ?? "";
    const result = await checkHandle(c.env.SITE_STUDIO_BUCKET, candidate);
    return c.json(result);
  });

  // Claim a handle for the current user (claim-once, immutable).
  app.post("/api/handle", async (c) => {
    const user = getUser(c);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_body", message: "Expected a JSON body with a handle." }, 400);
    }

    const parsedBody = z.object({ handle: z.string() }).safeParse(body);
    if (!parsedBody.success) {
      return c.json({ error: "invalid_body", message: "handle must be a string." }, 400);
    }

    const result = await claimHandle(c.env.SITE_STUDIO_BUCKET, user.id, parsedBody.data.handle);
    if (!result.ok) {
      return c.json({ error: "handle_unavailable", message: result.reason }, result.status);
    }

    return c.json({ handle: result.handle, alreadyOwned: result.alreadyOwned });
  });

  return app;
}
