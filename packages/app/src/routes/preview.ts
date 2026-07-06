import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { addCacheBusterToHtml, getContentType, isTextContentType } from "../lib/path";
import { binaryBody } from "../lib/http";
import { renderNotFoundPage } from "../lib/not-found-page";
import { servedContentHeaders } from "../lib/serving-headers";
import { getUser } from "../lib/session";
import { FileNotFoundError, R2ProjectStorage } from "../storage/r2";

type AppContext = Context<{ Bindings: Env; Variables: { user: { id: string } } }>;

/**
 * A preview request "looks like a page navigation" when the visitor expects a
 * document, so a styled 404 belongs (it renders inside the editor iframe).
 * Asset requests (css/js/images) keep a terse 404 so a broken tag does not
 * download a full HTML document.
 */
function looksLikePageNavigation(c: AppContext, filePath: string): boolean {
  const accept = c.req.header("Accept") || "";
  if (accept.includes("text/html")) {
    return true;
  }
  const path = filePath.trim();
  return path === "" || path.endsWith("/") || path.endsWith(".html") || path.endsWith(".htm");
}

function previewNotFound(c: AppContext, filePath: string, siteRootPath?: string): Response {
  if (looksLikePageNavigation(c, filePath)) {
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

  const contentType = getContentType(resolvedPath);

  c.header("Content-Type", isTextContentType(contentType) ? `${contentType}; charset=utf-8` : contentType);
  c.header("X-Frame-Options", "SAMEORIGIN");
  c.header("Cache-Control", "no-cache");
  c.header("Pragma", "no-cache");

  if (contentType === "text/html") {
    const version = c.req.query("v") || undefined;
    content = new TextEncoder().encode(addCacheBusterToHtml(new TextDecoder().decode(content), version));
  }

  // §3¾: the preview renders agent/student-authored HTML on our origin. The
  // opaque-origin CSP (see lib/serving-headers.ts) makes document.cookie /
  // session / same-origin /api unreachable even on a direct top-level open.
  return new Response(binaryBody(content), {
    headers: {
      "Content-Type": isTextContentType(contentType) ? `${contentType}; charset=utf-8` : contentType,
      "X-Frame-Options": "SAMEORIGIN",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      ...servedContentHeaders(contentType)
    }
  });
}
