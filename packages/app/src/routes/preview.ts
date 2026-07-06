import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { addCacheBusterToHtml } from "../lib/path";
import { getServedContentType } from "../lib/constants";
import { binaryBody } from "../lib/http";
import { renderNotFoundPage } from "../lib/not-found-page";
import { servedContentHeaders } from "../lib/serving-headers";
import { looksLikePageNavigation } from "../../../serving-core/src/page-navigation";
import { getUser } from "../lib/session";
import { FileNotFoundError, R2ProjectStorage } from "../storage/r2";

type AppContext = Context<{ Bindings: Env; Variables: { user: { id: string } } }>;

function previewNotFound(c: AppContext, filePath: string, siteRootPath?: string): Response {
  if (looksLikePageNavigation(c.req.header("Accept"), filePath)) {
    return c.html(renderNotFoundPage(siteRootPath), 404);
  }
  return c.text("Not found", 404);
}

export function createPreviewRouter() {
  const app = new Hono<{ Bindings: Env; Variables: { user: { id: string } } }>();

  app.get("/preview/:id", async (c) => {
    return servePreviewFile(c, "index.html");
  });

  app.get("/preview/:id/*", async (c) => {
    const prefix = `/preview/${c.req.param("id")}/`;
    const url = new URL(c.req.url);
    const filePath = url.pathname.slice(prefix.length) || "index.html";
    return servePreviewFile(c, filePath);
  });

  return app;
}

async function servePreviewFile(
  c: AppContext,
  requestedPath: string
) {
  const storage = new R2ProjectStorage(c.env.SITE_STUDIO_BUCKET);
  const user = getUser(c);
  const projectId = c.req.param("id");
  if (!projectId) {
    return previewNotFound(c, requestedPath);
  }

  const siteRootPath = `/preview/${projectId}/`;

  if (!(await storage.projectExists(user.id, projectId))) {
    return previewNotFound(c, requestedPath);
  }

  let filePath = requestedPath || "index.html";
  if (!filePath || filePath.endsWith("/")) {
    filePath = `${filePath}index.html`;
  }

  const primaryPath = filePath;
  const fallbackPath = !filePath.includes(".") ? `${filePath}/index.html` : null;

  let content: Uint8Array | null = null;
  let resolvedPath = primaryPath;

  try {
    content = await storage.readFileBuffer(user.id, projectId, primaryPath);
  } catch (error) {
    if (!(error instanceof FileNotFoundError)) {
      throw error;
    }
  }

  if (!content && fallbackPath) {
    try {
      content = await storage.readFileBuffer(user.id, projectId, fallbackPath);
      resolvedPath = fallbackPath;
    } catch (error) {
      if (!(error instanceof FileNotFoundError)) {
        throw error;
      }
    }
  }

  if (!content) {
    return previewNotFound(c, requestedPath, siteRootPath);
  }

  // SS-8: the served content-type (with `; charset=utf-8` on text types) comes
  // from the same authoritative table both workers use, so a given extension
  // renders identically in the preview and on the published origins.
  const contentType = getServedContentType(resolvedPath);

  c.header("Content-Type", contentType);
  c.header("X-Frame-Options", "SAMEORIGIN");
  c.header("Cache-Control", "no-cache");
  c.header("Pragma", "no-cache");

  if (contentType.startsWith("text/html")) {
    const version = c.req.query("v") || undefined;
    content = new TextEncoder().encode(addCacheBusterToHtml(new TextDecoder().decode(content), version));
  }

  // §3¾: the preview renders agent/student-authored HTML on our origin. The
  // opaque-origin CSP (see lib/serving-headers.ts) makes document.cookie /
  // session / same-origin /api unreachable even on a direct top-level open.
  return new Response(binaryBody(content), {
    headers: {
      "Content-Type": contentType,
      "X-Frame-Options": "SAMEORIGIN",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      ...servedContentHeaders(contentType)
    }
  });
}
