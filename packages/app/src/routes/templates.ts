import { Hono } from "hono";
import type { Env } from "../types";
import { getTemplateCategories } from "../lib/templates";

export function createTemplateRouter() {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/api/templates", (c) => {
    return c.json({
      categories: getTemplateCategories()
    });
  });

  return app;
}
