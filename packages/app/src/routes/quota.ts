import { Hono } from "hono";
import { createCailClient, CailError } from "@cuny-ai-lab/cail-client";
import type { Env } from "../types";
import { getCailIdentityJwt } from "../lib/session";
import { CAIL_APP_SLUG } from "../lib/model";
import { jsonError } from "../lib/http";

export function createQuotaRouter() {
  const app = new Hono<{ Bindings: Env; Variables: { cailIdentityJwt: string } }>();

  app.get("/api/quota", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const jwt = getCailIdentityJwt(c);
    if (!jwt) jsonError("authentication_required", 401);
    if (!c.env.CAIL_API_BASE) jsonError("CAIL_API_BASE is not configured", 503);

    try {
      const quota = await createCailClient({
        baseUrl: c.env.CAIL_API_BASE.replace(/\/+$/, ""),
        app: CAIL_APP_SLUG,
        allowInsecureLoopback: true
      }).getQuota({ kind: "jwt", token: jwt });
      const { subject: _subject, ...publicQuota } = quota;
      return c.json(publicQuota);
    } catch (error) {
      if (error instanceof CailError) {
        const status = error.status >= 400 && error.status <= 599 ? error.status : 503;
        return c.json({ error: error.code, message: error.message }, status as any);
      }
      throw error;
    }
  });

  return app;
}
