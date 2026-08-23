import { Hono, type Context } from "hono";
import type { Env } from "../types";
import {
  addCacheBusterToCss,
  addCacheBusterToHtml,
  collectPreviewCssResourcePaths,
  collectPreviewResourcePaths,
  decodeServedPath
} from "../lib/path";
import { getServedContentType } from "../lib/constants";
import { binaryBody } from "../lib/http";
import { renderNotFoundPage } from "../lib/not-found-page";
import { servedContentHeaders, servedNotFoundHeaders } from "../lib/serving-headers";
import { looksLikePageNavigation } from "../lib/page-navigation";
import { resolveExtensionlessFile } from "../lib/extensionless";
import { isProtectedServedPath } from "../lib/protected-files";
import { getUser } from "../lib/session";
import { isLoopbackOrigin } from "../lib/csrf";
import { mintPreviewToken } from "../lib/preview-token";
import { FileNotFoundError, R2ProjectStorage } from "../storage/r2";
import { getLoggingContext, type LoggingVariables } from "../lib/logging";

type AppContext = Context<{
  Bindings: Env;
  Variables: LoggingVariables & { user: { id: string }; previewTokenExpiresAt?: number };
}>;

function previewNotFound(c: AppContext, filePath: string, siteRootPath?: string): Response {
  const headers = servedNotFoundHeaders("no-store");
  if (looksLikePageNavigation(c.req.header("Accept"), filePath)) {
    return c.html(renderNotFoundPage(siteRootPath), 404, headers);
  }
  return c.text("Not found", 404, headers);
}

function getPreviewRootPath(c: AppContext, projectId: string): string {
  const requestOrigin = new URL(c.req.url).origin;
  const configuredMount = c.env.CSRF_COOKIE_PATH?.trim().replace(/\/+$/, "") || "";
  const normalizedMount = configuredMount && configuredMount !== "/"
    ? (configuredMount.startsWith("/") ? configuredMount : `/${configuredMount}`)
    : "";
  const mountPath = isLoopbackOrigin(requestOrigin) ? "" : normalizedMount;
  return `${mountPath}/preview/${projectId}/`;
}

export function createPreviewRouter() {
  const app = new Hono<{ Bindings: Env; Variables: LoggingVariables & { user: { id: string } } }>();

  app.get("/preview/:id", (c) => {
    const url = new URL(c.req.url);
    const projectId = c.req.param("id");
    return c.redirect(`${getPreviewRootPath(c, projectId)}index.html${url.search}`, 308);
  });

  app.get("/preview/:id/*", async (c) => {
    const prefix = `/preview/${c.req.param("id")}/`;
    const url = new URL(c.req.url);
    const rawPath = url.pathname.slice(prefix.length);
    const filePath = decodeServedPath(rawPath);
    if (filePath === null) return previewNotFound(c, rawPath);
    return servePreviewFile(c, filePath);
  });

  return app;
}

async function servePreviewFile(
  c: AppContext,
  requestedPath: string
) {
  const user = getUser(c);
  const storage = new R2ProjectStorage(
    c.env.SITE_STUDIO_BUCKET,
    getLoggingContext(c, user.operationalSubject),
  );
  const projectId = c.req.param("id");
  if (!projectId) {
    return previewNotFound(c, requestedPath);
  }

  const siteRootPath = getPreviewRootPath(c, projectId);

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
  // then `{path}/index.html`). This aligns preview to publish (the sanctioned
  // S3 behavior change): preview previously only tried
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
  // from the authoritative app table, so a given extension renders identically
  // in preview and on the published route.
  const contentType = getServedContentType(resolvedPath);

  c.header("Content-Type", contentType);
  c.header("X-Frame-Options", "SAMEORIGIN");
  c.header("Cache-Control", "no-cache");
  c.header("Pragma", "no-cache");

  const isMarkup = contentType.startsWith("text/html")
    || contentType.startsWith("image/svg+xml");
  if (isMarkup) {
    const version = c.req.query("v") || undefined;
    // The ownership check above ensures preview tokens are never minted for a
    // non-owner. Opaque-origin sandbox documents cannot send the session cookie,
    // so carry this short-lived, project-scoped token on rewritten requests.
    const html = new TextDecoder().decode(content);
    const allowedPaths = await collectPreviewResourcePaths(html, requestedPath, siteRootPath);
    const previewToken = allowedPaths.length > 0
      ? await mintPreviewToken(
          c.env.SESSION_KV,
          user.id,
          projectId,
          allowedPaths,
          c.get("previewTokenExpiresAt") ?? undefined
        )
      : null;
    // Root-relative authored URLs belong to this project, not the app shell.
    // Include the public mount so production ingress requests return to the
    // same preview route after the Worker strips /site-studio internally.
    const rewritten = await addCacheBusterToHtml(
      html,
      version,
      previewToken ? { pt: previewToken } : {},
      siteRootPath,
      requestedPath
    );
    if (rewritten !== html) content = new TextEncoder().encode(rewritten);
  } else if (contentType.startsWith("text/css")) {
    const version = c.req.query("v") || undefined;
    const css = new TextDecoder().decode(content);
    const allowedPaths = collectPreviewCssResourcePaths(css, requestedPath);
    const previewToken = allowedPaths.length > 0
      ? await mintPreviewToken(
          c.env.SESSION_KV,
          user.id,
          projectId,
          allowedPaths,
          c.get("previewTokenExpiresAt") ?? undefined
        )
      : null;
    const rewritten = addCacheBusterToCss(
      css,
      version,
      previewToken ? { pt: previewToken } : {},
      siteRootPath,
      requestedPath
    );
    if (rewritten !== css) content = new TextEncoder().encode(rewritten);
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
      ...servedContentHeaders()
    }
  });
}
