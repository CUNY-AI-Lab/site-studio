import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { authMiddleware } from "./lib/session";
import { csrfProtect, getOrMintCsrfToken, setCsrfCookie } from "./lib/csrf";
import { createAgentRouter, type AgentResolver } from "./routes/agents";
import { createFileRouter } from "./routes/files";
import { createHandleRouter } from "./routes/handles";
import { createHealthRouter } from "./routes/health";
import { createPreviewRouter } from "./routes/preview";
import { createProjectRouter } from "./routes/projects";
import { createPublishRouter } from "./routes/publish";
import { createTemplateRouter } from "./routes/templates";
import { createQuotaRouter } from "./routes/quota";
import { previewTokenAuth } from "./lib/preview-token";
import { requireProject, type RequireProjectVariables } from "./lib/require-project";
import { requestLogging, type LoggingVariables } from "./lib/logging";
import { getServedContentType } from "./lib/content-types";

/**
 * App assembly is injectable only at the SiteBuilderAgent resolver seam so the
 * local browser acceptance can exercise the real middleware and WebSocket route
 * without importing the Durable Object dependency tree. Production uses the
 * default resolver below and has no alternate runtime path.
 */
/**
 * The production ingress mounts the Worker at /site-studio while the assets
 * binding stores the built files from the origin root. Normalize it at the
 * Worker boundary so every route (and the asset fallback) sees root-relative
 * paths, while root-mounted local development remains unchanged.
 */
export function normalizeMountedRequest(
  request: Request,
  env: Pick<Env, "CSRF_COOKIE_PATH">,
): Request {
  const mountPath = env.CSRF_COOKIE_PATH?.trim().replace(/\/+$/, "") || "";
  const requestUrl = new URL(request.url);
  if (
    !mountPath
    || mountPath === "/"
    || (requestUrl.pathname !== mountPath && !requestUrl.pathname.startsWith(`${mountPath}/`))
  ) {
    return request;
  }

  requestUrl.pathname = requestUrl.pathname.slice(mountPath.length) || "/";
  return new Request(requestUrl, request);
}

function assetRequest(c: { req: { raw: Request; url: string }; env: Env }): Request {
  return normalizeMountedRequest(c.req.raw, c.env);
}

/**
 * The asset binding is configured for SPA fallback so extensionless Svelte
 * routes can load the app shell. A missing known static asset must not inherit
 * that fallback: the browser needs a real 404 instead of HTML for a script,
 * stylesheet, image, or other authored static resource.
 */
function isStandaloneStaticAsset(pathname: string): boolean {
  const contentType = getServedContentType(pathname);
  return contentType !== "application/octet-stream" && !contentType.startsWith("text/html");
}

export function createApp(agentResolver?: AgentResolver) {
  const app = new Hono<{
    Bindings: Env;
    Variables: RequireProjectVariables & LoggingVariables & { sessionId: string };
  }>();

  // Fleet logging standard (cail-log): adopt/mint correlation at the fetch
  // boundary and emit ONE wide `request.completed` / `auth.denied` event per
  // request — metadata only (subject, classified route, status, outcome,
  // duration), never content. Registered first so it wraps every route,
  // including the error and not-found paths.
  app.use("*", requestLogging());

  // Credentialed CORS follows docs/security-and-recovery.md (browser and
  // serving defenses): strict allowlist, never wildcard or reflected origin.
  // Pinned by test.
const allowedOrigins = new Set([
	"http://localhost:5173",
	"http://127.0.0.1:5173",
	"https://tools.ailab.gc.cuny.edu"
]);

app.use("/api/*", cors({
  origin: (origin) => (origin && allowedOrigins.has(origin) ? origin : null),
  credentials: true
}));
app.use("/preview/*", cors({
  origin: (origin) => (origin && allowedOrigins.has(origin) ? origin : null),
  credentials: true
}));

  app.use("/api/csrf", authMiddleware);
  app.use("/api/projects", authMiddleware);
  app.use("/api/projects/*", authMiddleware);
  app.use("/api/handle", authMiddleware);
  app.use("/api/handle/*", authMiddleware);
  app.use("/api/quota", authMiddleware);
  app.use("/api/agents/site-builder/*", authMiddleware);
  app.use("/api/agents/site-builder/:projectId", authMiddleware);
  app.use("/preview/*", previewTokenAuth);
  app.use("/preview/:id", previewTokenAuth);
  app.use("/preview/*", authMiddleware);
  app.use("/preview/:id", authMiddleware);

  // CSRF (rules 2+3) on every state-changing /api route. Registered after the
  // authMiddleware entries so the session user is resolved first; the middleware
  // itself no-ops on GET/HEAD/OPTIONS, so reads, GET /api/csrf, and CORS
  // preflights stay open. WebSocket upgrades are GET and are gated separately
  // (rule 4) in routes/agents.ts.
  app.use("/api/*", csrfProtect);

  // One ownership/existence gate for every project-scoped API. Keep this at app
  // assembly so new project routes cannot bypass it and each request performs a
  // single R2 existence probe.
  app.use("/api/projects/:id", requireProject());
  app.use("/api/projects/:id/*", requireProject());

  // Token issuance for the local CSRF contract (docs/security-and-recovery.md,
  // browser and serving defenses): GET /api/csrf mints/looks-up the stable
  // per-session R2 token and DELIVERS it via a path-scoped Set-Cookie
  // (setCsrfCookie) — never in the response body. A body token would be readable
  // by any same-origin sibling or published-site script that fetches this
  // endpoint with the ambient session cookie, defeating the contract. The body
  // is 204 with no token anywhere.
  app.get("/api/csrf", async (c) => {
    const user = c.get("user");
    const token = await getOrMintCsrfToken(c.env.SITE_STUDIO_BUCKET, user.id);
    setCsrfCookie(c, token);
    return c.body(null, 204);
  });

  app.route("/", createHealthRouter());
  app.route("/", createTemplateRouter());
  app.route("/", createQuotaRouter());
  app.route("/", createAgentRouter(agentResolver));
  app.route("/", createProjectRouter());
  app.route("/", createFileRouter());
  app.route("/", createHandleRouter());
  app.route("/", createPublishRouter());
  app.route("/", createPreviewRouter());

  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json({ error: error.message }, error.status);
    }

    // No ad-hoc console logging here: the requestLogging boundary middleware
    // emits the single structured wide event for this request (status 500,
    // outcome "error", error_code from the error class) after this handler
    // shapes the response. Raw error objects can interpolate user content and
    // never reach the logs.
    return c.json({ error: "Internal server error" }, 500);
  });

app.notFound(async (c) => {
  const pathname = new URL(c.req.url).pathname;
  const isWorkerRoute = pathname === "/api"
    || pathname.startsWith("/api/")
    || pathname === "/preview"
    || pathname.startsWith("/preview/")
    || pathname === "/u"
    || pathname.startsWith("/u/")
    // Retired owner-addressed public URLs must be an explicit 404, never the
    // Svelte SPA fallback.
    || pathname === "/sites"
    || pathname.startsWith("/sites/");

  if (!isWorkerRoute && c.env.ASSETS) {
    const assetResponse = await c.env.ASSETS.fetch(assetRequest(c));
    const assetContentType = assetResponse.headers.get("content-type")?.toLowerCase() || "";
    if (
      isStandaloneStaticAsset(pathname)
      && (assetResponse.status === 200 || assetResponse.status === 304)
      && assetContentType.startsWith("text/html")
    ) {
      return c.json(
        { error: "Not found" },
        404,
        {
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY"
        }
      );
    }
    return assetResponse;
  }

  return c.json(
    { error: "Not found" },
    404,
    {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY"
    }
  );
});

  return app;
}

const app = createApp();
export default app;
