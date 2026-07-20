import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { addCacheBusterToHtml, collectPreviewResourcePaths } from "../lib/path";
import { getServedContentType } from "../lib/constants";
import { binaryBody } from "../lib/http";
import { renderNotFoundPage } from "../../../serving-core/src/not-found-page";
import { servedContentHeaders } from "../../../serving-core/src/serving-headers";
import { looksLikePageNavigation } from "../../../serving-core/src/page-navigation";
import { resolveExtensionlessFile } from "../../../serving-core/src/extensionless";
import { isProtectedServedPath } from "../../../serving-core/src/protected-files";
import { getUser } from "../lib/session";
import { mintPreviewToken } from "../lib/preview-token";
import { FileNotFoundError, R2ProjectStorage } from "../storage/r2";

type AppContext = Context<{
  Bindings: Env;
  Variables: { user: { id: string }; previewTokenExpiresAt?: number };
}>;

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

  if (isProtectedServedPath(requestedPath)) {
    return previewNotFound(c, requestedPath, siteRootPath);
  }

  if (!(await storage.projectExists(user.id, projectId))) {
    return previewNotFound(c, requestedPath);
  }

  let filePath = requestedPath || "index.html";
  if (!filePath || filePath.endsWith("/")) {
    filePath = `${filePath}index.html`;
  }

  // SS-14 extensionless resolution via the shared helper (try `{path}.html`
  // then `{path}/index.html`). This ALIGNS preview to publish/publisher (the
  // sanctioned S3 behavior change): preview previously only tried
  // `{path}/index.html` and never the flat `{path}.html`. Adapt the
  // throw-on-miss readFileBuffer into a null-returning probe the helper wants.
  const readOrNull = async (candidate: string): Promise<Uint8Array | null> => {
    try {
      return await storage.readFileBuffer(user.id, projectId, candidate);
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        return null;
      }
      throw error;
    }
  };

  const resolved = await resolveExtensionlessFile(filePath, readOrNull);

  if (!resolved) {
    return previewNotFound(c, requestedPath, siteRootPath);
  }

  if (isProtectedServedPath(resolved.filePath)) {
    return previewNotFound(c, requestedPath, siteRootPath);
  }

  let content: Uint8Array | null = resolved.object;
  const resolvedPath = resolved.filePath;

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
    // The ownership check above ensures preview tokens are never minted for a
    // non-owner. Opaque-origin sandbox documents cannot send the session cookie,
    // so carry this short-lived, project-scoped token on rewritten requests.
    const html = new TextDecoder().decode(content);
    const allowedPaths = collectPreviewResourcePaths(html, requestedPath);
    const previewToken = allowedPaths.length > 0
      ? await mintPreviewToken(
          c.env.SESSION_KV,
          user.id,
          projectId,
          allowedPaths,
          c.get("previewTokenExpiresAt") ?? undefined
        )
      : null;
    content = new TextEncoder().encode(
      addCacheBusterToHtml(html, version, previewToken ? { pt: previewToken } : {})
    );
  }

  // Known limitation: url(...) references inside CSS are not rewritten, so
  // nested fonts/background images still need a future CSS-aware pass.

  // §3¾: the preview renders agent/student-authored HTML on our origin. The
  // opaque-origin CSP (see serving-core/serving-headers.ts) makes document.cookie /
  // session / same-origin /api unreachable even on a direct top-level open.
  return new Response(binaryBody(content), {
    headers: {
      "Content-Type": contentType,
      "X-Frame-Options": "SAMEORIGIN",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      ...servedContentHeaders()
    }
  });
}
