import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createCailClient, CailError } from "@cuny-ai-lab/cail-client";
import type { Env } from "../types";
import { getCailGatewayJwt } from "../lib/session";
import { CAIL_APP_SLUG } from "../lib/model";
import { jsonError } from "../lib/http";

export function createQuotaRouter() {
  const app = new Hono<{ Bindings: Env; Variables: { cailIdentityJwt: string } }>();

  app.get("/api/quota", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const jwt = getCailGatewayJwt(c);
    if (!jwt) jsonError("authentication_required", 401);
    if (!c.env.CAIL_API_BASE) jsonError("Site Studio isn't set up correctly right now. Email ailab@gc.cuny.edu.", 503);

    try {
      const quota = await createCailClient({
        baseUrl: c.env.CAIL_API_BASE.replace(/\/+$/, ""),
        app: CAIL_APP_SLUG,
        allowInsecureLoopback: true
      }).getQuota(jwt);
      return c.json(quota);
    } catch (error) {
      if (error instanceof CailError) {
        const statusValue = error.status >= 400 && error.status <= 599 ? error.status : 503;
        // SAFETY: the range check above constrains the CAIL error status to
        // Hono's content-bearing 4xx/5xx response status range.
        const status = statusValue as ContentfulStatusCode;
        // The client's network_error message names transport internals; show a
        // plain sentence instead. Other envelope messages pass through as-is.
        const message =
          error.code === "network_error"
            ? "Couldn't check your remaining AI time."
            : error.message;
        return c.json({ error: error.code, message }, status);
      }
      throw error;
    }
  });

  return app;
}
