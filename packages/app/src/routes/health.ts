import { Hono } from "hono";
import type { Env } from "../types";

export function createHealthRouter() {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      service: "site-studio-app",
      timestamp: new Date().toISOString()
    })
  );

  return app;
}
