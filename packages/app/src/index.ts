import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { authMiddleware } from "./lib/session";
import { SiteBuilderAgent } from "./agents/site-builder";
import { createAgentRouter } from "./routes/agents";
import { createFileRouter } from "./routes/files";
import { createHandleRouter } from "./routes/handles";
import { createHealthRouter } from "./routes/health";
import { createPreviewRouter } from "./routes/preview";
import { createProjectRouter } from "./routes/projects";
import { createPublishRouter } from "./routes/publish";
import { createTemplateRouter } from "./routes/templates";

const app = new Hono<{ Bindings: Env; Variables: { sessionId: string; user: { id: string; createdAt: string } } }>();

const allowedOrigins = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://tools.ailab.gc.cuny.edu",
  "https://tools.cuny.qzz.io"
]);

app.use("/api/*", cors({
  origin: (origin) => (origin && allowedOrigins.has(origin) ? origin : null),
  credentials: true
}));
app.use("/preview/*", cors({
  origin: (origin) => (origin && allowedOrigins.has(origin) ? origin : null),
  credentials: true
}));

app.use("/api/projects", authMiddleware);
app.use("/api/projects/*", authMiddleware);
app.use("/api/handle", authMiddleware);
app.use("/api/handle/*", authMiddleware);
app.use("/api/agents/site-builder/*", authMiddleware);
app.use("/api/agents/site-builder/:projectId", authMiddleware);
app.use("/preview/*", authMiddleware);
app.use("/preview/:id", authMiddleware);

app.route("/", createHealthRouter());
app.route("/", createTemplateRouter());
app.route("/", createAgentRouter());
app.route("/", createProjectRouter());
app.route("/", createFileRouter());
app.route("/", createHandleRouter());
app.route("/", createPublishRouter());
app.route("/", createPreviewRouter());

app.onError((error, c) => {
  if (error instanceof HTTPException) {
    return c.json({ error: error.message }, error.status);
  }

  console.error("site-studio-app error", error);
  return c.json({ error: "Internal server error" }, 500);
});

app.notFound(async (c) => {
  const pathname = new URL(c.req.url).pathname;
  const isWorkerRoute = pathname === "/api"
    || pathname.startsWith("/api/")
    || pathname === "/preview"
    || pathname.startsWith("/preview/")
    || pathname === "/sites"
    || pathname.startsWith("/sites/")
    || pathname === "/u"
    || pathname.startsWith("/u/");

  if (!isWorkerRoute && c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }

  return c.json({ error: "Not found" }, 404);
});

export default app;
export { SiteBuilderAgent };
