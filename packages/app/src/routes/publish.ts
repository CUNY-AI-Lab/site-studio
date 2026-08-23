import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../types";
import {
  getServedContentType,
  MAX_THUMBNAIL_BODY_BYTES,
  MAX_THUMBNAIL_BYTES,
  MAX_THUMBNAIL_DIMENSION
} from "../lib/constants";
import { binaryBody, jsonError } from "../lib/http";
import { getUserHandle, resolveHandleOwner } from "../lib/handles";
import { renderNotFoundPage } from "../lib/not-found-page";
import { servedContentHeaders, servedNotFoundHeaders } from "../lib/serving-headers";
import { looksLikePageNavigation } from "../lib/page-navigation";
import { resolveExtensionlessFile } from "../lib/extensionless";
import { isProtectedServedPath } from "../lib/protected-files";
import { sniffImageType } from "../lib/image-validation";
import { getUser } from "../lib/session";
import { lintProject, type A11yFinding } from "../lib/a11y-lint";
import { R2ProjectStorage } from "../storage/r2";
import type { RequireProjectVariables } from "../lib/require-project";
import { isLoopbackOrigin } from "../lib/csrf";
import { rewriteRootRelativeCssUrls, rewriteRootRelativeHtmlUrls } from "../lib/path";
import { OBSERVABILITY_CONTRACT } from "../../../observability-core/src/contract";
import {
  SiteStudioActionLifecycle,
  createSiteStudioBoundaryContext,
  emitDiagnostic,
  getBoundaryLogger,
  getLoggingContext,
  serializeSiteStudioLoggingContext,
  errorCodeFrom,
  getCorrelation,
  mintCorrelation,
  principalForOperationalSubject,
  type LoggingVariables,
} from "../lib/logging";
import { executeOwnerMutation } from "../lib/owner-mutations";
import { readBoundedFormData } from "../lib/multipart";

const MAX_PUBLISH_A11Y_FINDINGS = 50;

function requiredPositiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) jsonError(`${name} is not configured`, 503);
  return parsed;
}

/**
 * Run the accessibility linter over the project's HTML after a successful
 * publish. Read-only and best-effort: any failure yields an empty array so it
 * can never fail the publish itself.
 */
async function collectPublishA11yFindings(
  storage: R2ProjectStorage,
  userId: string,
  projectId: string
): Promise<A11yFinding[]> {
  try {
    const files = await storage.listFiles(userId, projectId);
    const htmlFiles: Record<string, string> = {};
    for (const file of files) {
      if (!/\.html?$/i.test(file.path)) {
        continue;
      }
      htmlFiles[file.path] = await storage.readFile(userId, projectId, file.path);
    }
    return lintProject(htmlFiles).slice(0, MAX_PUBLISH_A11Y_FINDINGS);
  } catch {
    return [];
  }
}

/**
 * A request "looks like a page navigation" when the visitor is expecting a
 * document (so a styled 404 belongs) rather than an asset like an image/css/js
 * referenced by a tag. We serve HTML only for navigations so a broken
 * <img>/<script>/<link> does not download a full HTML document.
 */
/**
 * Respond to a missing published file. Page navigations get the dignified
 * styled 404 (with a "Go to site home" link); asset requests keep a terse
 * plain-text 404.
 */
function publishedNotFound(c: AppContext, filePath: string, siteRootPath?: string): Response {
  const headers = servedNotFoundHeaders("public, max-age=0, must-revalidate");
  if (looksLikePageNavigation(c.req.header("Accept"), filePath)) {
    return c.html(renderNotFoundPage(siteRootPath, getAppPublicRoot(c)), 404, headers);
  }
  return c.text("Not found", 404, headers);
}

/**
 * Missing file within a resolved published site. A project-supplied 404.html
 * takes precedence (for page navigations); otherwise fall back to the styled
 * 404. Asset requests always get a terse 404.
 */
async function missingPublishedFile(
  c: AppContext,
  storage: R2ProjectStorage,
  userId: string,
  projectId: string,
  filePath: string,
  siteRootPath: string
): Promise<Response> {
  if (looksLikePageNavigation(c.req.header("Accept"), filePath)) {
    const custom = await storage.readObject(userId, projectId, "404.html");
    if (custom) {
      // Project-supplied 404.html is agent/student-authored active content served
      // on our origin — §3¾ containment applies (see lib/serving-headers.ts). It
      // goes through the same header builder as a 200 so the content-type,
      // caching validators and CSP match normal published responses.
      const originalBytes = new Uint8Array(await custom.arrayBuffer());
      const originalHtml = new TextDecoder().decode(originalBytes);
      const html = rewriteRootRelativeHtmlUrls(originalHtml, siteRootPath);
      const headers = publishedResponseHeaders("404.html", custom);
      const transformed = html !== originalHtml;
      const content = transformed ? new TextEncoder().encode(html) : originalBytes;
      if (transformed) {
        // The served bytes now include the canonical site mount, so validators
        // from the unrewritten R2 object no longer describe this response.
        headers.delete("ETag");
        headers.delete("Last-Modified");
      }
      return new Response(binaryBody(content), {
        status: 404,
        headers
      });
    }
  }
  return publishedNotFound(c, filePath, siteRootPath);
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function getAppPublicRoot(c: AppContext): string {
  const requestOrigin = new URL(c.req.url).origin;
  if (isLoopbackOrigin(requestOrigin)) {
    return `${requestOrigin}/`;
  }

  const configuredOrigin = c.env.APP_PUBLIC_DOMAIN?.trim();
  return `${normalizeBaseUrl(configuredOrigin || requestOrigin)}/`;
}

function getPublishedBaseUrl(c: AppContext): string {
  const requestOrigin = new URL(c.req.url).origin;
  // Published sites are served by this worker at /u/{handle}/{slug}/. In dev
  // that means the local worker origin; production keeps its configured public
  // domain authoritative because its request origin is never loopback.
  if (isLoopbackOrigin(requestOrigin)) {
    return normalizeBaseUrl(requestOrigin);
  }

  const configuredBaseUrl = c.env.PUBLISHED_BASE_URL?.trim();
  if (configuredBaseUrl) {
    return normalizeBaseUrl(configuredBaseUrl);
  }

  return normalizeBaseUrl(requestOrigin);
}

/**
 * The public ingress strips its mount before forwarding to the Worker. Keep
 * redirects and styled 404 home links rooted at the configured public prefix;
 * loopback development remains mounted at the origin root.
 */
function getPublishedPathPrefix(c: AppContext): string {
  const pathname = new URL(getPublishedBaseUrl(c)).pathname.replace(/\/+$/, "");
  return pathname === "/" ? "" : pathname;
}

type AppContext = Context<{
  Bindings: Env;
  Variables: RequireProjectVariables & LoggingVariables;
}>;

export function createPublishRouter() {
  const app = new Hono<{
    Bindings: Env;
    Variables: RequireProjectVariables & LoggingVariables;
  }>();

  app.post("/api/projects/:id/publish", async (c) => {
    const storage = c.get("storage");
    const user = getUser(c);
    const projectId = c.get("projectId");
    const metadata = await storage.getProjectMetadata(user.id, projectId);

    if (!metadata) {
      jsonError("Project not found", 404);
    }

    // Published URLs live under the user's chosen handle: /u/{handle}/{slug}/.
    // Without a handle there is no canonical address to publish to, so ask the
    // client to claim one first. The handle keeps the CAIL subject out of the
    // public URL entirely.
    const handle = await getUserHandle(c.env.SITE_STUDIO_BUCKET, user.id);
    if (!handle) {
      return c.json(
        {
          error: "handle_required",
          message: "Choose your public address before publishing."
        },
        409
      );
    }

    const desiredSlug = metadata.slug || slugify(metadata.name || projectId) || projectId;
    let url = "";
    const publishAction = new SiteStudioActionLifecycle({
      action: "publish",
      principal: principalForOperationalSubject(user.operationalSubject),
      correlation: getCorrelation(c) ?? mintCorrelation(),
    }, getBoundaryLogger(c) ?? createSiteStudioBoundaryContext(c.env, {
      operationalSubject: user.operationalSubject,
    }).logger);
    const actionAgent = c.env.SITE_BUILDER_AGENT.get(
      c.env.SITE_BUILDER_AGENT.idFromName(`${user.id}:${projectId}`),
    );
    const durableAdmittedAt = Date.now();
    await actionAgent.recordActionAdmission({
      actionId: publishAction.actionId,
      action: "publish",
      route: OBSERVABILITY_CONTRACT.actions.publish.route,
      admittedAt: new Date(durableAdmittedAt).toISOString(),
    });
    publishAction.admit();
    let actionTerminalRecorded = false;

    try {
      let result;
      try {
        result = await executeOwnerMutation(c.env, user.id, {
          type: "publish-project",
          projectId,
          desiredSlug,
          publishedBaseUrl: getPublishedBaseUrl(c),
          handle
        }, serializeSiteStudioLoggingContext(getLoggingContext(c, user.operationalSubject)));
      } catch (error) {
        if (error instanceof Error && error.message.includes("Project not found")) {
          jsonError("Project not found", 404);
        }
        throw error;
      }
      if (!("published" in result)) throw new Error("Unexpected mutation result");
      ({ url } = result.published);
      publishAction.acknowledgeMutation();

      const terminalAt = Date.now();
      const successTerminal = {
        actionId: publishAction.actionId,
        outcome: "ok",
        reason: "completed",
        terminalAt: new Date(terminalAt).toISOString(),
        durationMs: Math.max(0, terminalAt - durableAdmittedAt),
      } as const;
      let durableTerminalRecorded = false;
      for (let attempt = 0; attempt < 2 && !durableTerminalRecorded; attempt += 1) {
        try {
          // The terminal RPC is idempotent for an identical payload. Retry once
          // because an RPC rejection can be ambiguous about whether the first
          // call committed in the project Durable Object.
          await actionAgent.recordActionTerminal(successTerminal);
          durableTerminalRecorded = true;
        } catch {
          // Handled after the bounded retry. The R2 publish is already committed
          // and must not be reported to the user as a failed publish.
        }
      }
      actionTerminalRecorded = true;
      if (durableTerminalRecorded) {
        publishAction.completeSuccess();
      } else {
        emitDiagnostic(
          "error",
          "publish_terminal_record_failed",
          {},
          getLoggingContext(c, user.operationalSubject)
            ?? createSiteStudioBoundaryContext(c.env, {
              operationalSubject: user.operationalSubject,
            }),
        );
      }
      const a11yFindings = await collectPublishA11yFindings(storage, user.id, projectId);

      return c.json({
        success: true,
        message: "Project published successfully",
        url,
        a11yFindings
      });
    } catch (error) {
      if (!actionTerminalRecorded) {
        const terminal = error instanceof HTTPException && error.status < 500
          ? { outcome: "client_error", reason: "client_error" } as const
          : { outcome: "error", reason: "application_failure" } as const;
        const terminalAt = Date.now();
        const errorType = errorCodeFrom(error);
        await actionAgent.recordActionTerminal({
          actionId: publishAction.actionId,
          ...terminal,
          terminalAt: new Date(terminalAt).toISOString(),
          durationMs: Math.max(0, terminalAt - durableAdmittedAt),
          errorType,
        });
        publishAction.completeFailure(terminal, errorType);
      }
      throw error;
    }
  });

  app.post("/api/projects/:id/unpublish", async (c) => {
    const storage = c.get("storage");
    const user = getUser(c);
    const projectId = c.get("projectId");
    const metadata = await storage.getProjectMetadata(user.id, projectId);

    if (!metadata?.published) {
      jsonError("Project is not currently published", 400);
    }

    try {
      await executeOwnerMutation(c.env, user.id, {
        type: "unpublish-project",
        projectId,
        unpublishedAt: new Date().toISOString()
      }, serializeSiteStudioLoggingContext(getLoggingContext(c, user.operationalSubject)));
    } catch (error) {
      if (error instanceof Error && error.message.includes("Project not found")) {
        jsonError("Project not found", 404);
      }
      throw error;
    }

    return c.json({
      success: true,
      message: "Project unpublished successfully"
    });
  });

  app.post("/api/projects/:id/thumbnail", async (c) => {
    const user = getUser(c);
    const projectId = c.get("projectId");
    const form = await readBoundedFormData(
      c.req.raw,
      MAX_THUMBNAIL_BODY_BYTES,
      `Thumbnail too large. Max ${MAX_THUMBNAIL_BYTES / (1024 * 1024)}MB`
    );
    const entry = form.get("image");

    if (!(entry instanceof File)) {
      jsonError("No image uploaded", 400);
    }

    const image = entry;

    if (image.type !== "image/png") {
      jsonError("Only image/png is supported", 400);
    }

    if (image.size > MAX_THUMBNAIL_BYTES) {
      jsonError(`Thumbnail too large. Max ${MAX_THUMBNAIL_BYTES / (1024 * 1024)}MB`, 413);
    }

    const content = new Uint8Array(await image.arrayBuffer());

    // SS-21: don't trust the client-declared type. Thumbnails are PNGs, so sniff
    // the magic bytes and reject anything that isn't a real PNG — the same
    // defense the main upload route applies via validateImageBytes.
    if (sniffImageType(content) !== "png") {
      jsonError("Thumbnail must be a valid PNG image.", 400);
    }
    if (
      content.byteLength < 24 ||
      new DataView(content.buffer, content.byteOffset, content.byteLength).getUint32(8) !== 13 ||
      String.fromCharCode(...content.slice(12, 16)) !== "IHDR"
    ) {
      jsonError("Thumbnail PNG is missing its IHDR dimensions.", 400);
    }
    const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    if (
      width < 1 ||
      height < 1 ||
      width > MAX_THUMBNAIL_DIMENSION ||
      height > MAX_THUMBNAIL_DIMENSION
    ) {
      jsonError(`Thumbnail dimensions must be between 1 and ${MAX_THUMBNAIL_DIMENSION}px.`, 400);
    }

    try {
      await executeOwnerMutation(c.env, user.id, {
        type: "write-thumbnail",
        projectId,
        content,
        admissionId: crypto.randomUUID(),
        maxProjectBytes: requiredPositiveInteger(c.env.SITE_STUDIO_MAX_PROJECT_BYTES, "SITE_STUDIO_MAX_PROJECT_BYTES"),
        maxOwnerBytes: requiredPositiveInteger(c.env.SITE_STUDIO_MAX_OWNER_BYTES, "SITE_STUDIO_MAX_OWNER_BYTES"),
        uploadsPerMinute: requiredPositiveInteger(c.env.SITE_STUDIO_UPLOADS_PER_MINUTE, "SITE_STUDIO_UPLOADS_PER_MINUTE")
      }, serializeSiteStudioLoggingContext(getLoggingContext(c, user.operationalSubject)));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Thumbnail admission failed";
      if (message.includes("rate limit")) jsonError(message, 429);
      if (message.includes("storage quota")) jsonError(message, 413);
      if (message.includes("Project not found") || message.includes("Project metadata not found")) {
        jsonError("Project not found", 404);
      }
      throw error;
    }

    return c.json({
      success: true,
      thumbnailUrl: `/api/projects/${projectId}/thumbnail`
    });
  });

  app.get("/api/projects/:id/thumbnail", async (c) => {
    const storage = c.get("storage");
    const user = getUser(c);
    const projectId = c.get("projectId");
    const thumbnail = await storage.readThumbnail(user.id, projectId);

    if (!thumbnail) {
      jsonError("Thumbnail not found", 404);
    }

    // Owner-only PNG rendered as an <img> in the dashboard — not active
    // content, so it is intentionally NOT sandboxed (that would break the
    // <img>). Add nosniff for hygiene so it can't be sniffed into an active
    // type.
    return new Response(binaryBody(thumbnail), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff"
      }
    });
  });

  // Canonical published URL: /u/{handle}/{slug}/*. Resolve the handle to its
  // owner and serve. The owner id (CAIL subject) never appears in the URL.
  app.get("/u/:handle/:slug", async (c) => {
    return serveByHandle(c, "index.html");
  });

  app.get("/u/:handle/:slug/*", async (c) => {
    const base = `/u/${c.req.param("handle")}/${c.req.param("slug")}/`;
    const url = new URL(c.req.url);
    const filePath = url.pathname.slice(base.length) || "index.html";
    return serveByHandle(c, filePath);
  });

  return app;
}

async function resolvePublishedSite(
  storage: R2ProjectStorage,
  ownerId: string,
  slug: string
): Promise<{ ownerId: string; resolved: { projectId: string } } | null> {
  const resolved = await storage.findPublishedProjectBySlug(ownerId, slug);
  return resolved ? { ownerId, resolved } : null;
}

/** Serve a file for a canonical /u/{handle}/{slug}/ request. */
async function serveByHandle(c: AppContext, rawPath: string) {
  const storage = new R2ProjectStorage(c.env.SITE_STUDIO_BUCKET, getLoggingContext(c));
  const handle = c.req.param("handle");
  const slug = c.req.param("slug");
  if (!handle || !slug) {
    return publishedNotFound(c, rawPath);
  }

  const siteRootPath = `${getPublishedPathPrefix(c)}/u/${handle}/${slug}/`;

  const ownerId = await resolveHandleOwner(c.env.SITE_STUDIO_BUCKET, handle);
  if (!ownerId) {
    return publishedNotFound(c, rawPath);
  }

  const site = await resolvePublishedSite(storage, ownerId, slug);
  if (!site) {
    return publishedNotFound(c, rawPath);
  }

  const url = new URL(c.req.url);
  if (url.pathname === `/u/${handle}/${slug}`) {
    return c.redirect(`${getPublishedPathPrefix(c)}${url.pathname}/${url.search}`, 301);
  }

  return servePublishedFile(c, storage, site.ownerId, site.resolved.projectId, rawPath, siteRootPath);
}

/** Read and return a file within an already-resolved published project. */
async function servePublishedFile(
  c: AppContext,
  storage: R2ProjectStorage,
  userId: string,
  projectId: string,
  rawPath: string,
  siteRootPath: string
) {
  if (isProtectedServedPath(rawPath)) {
    return missingPublishedFile(c, storage, userId, projectId, rawPath, siteRootPath);
  }

  // SS-14 extensionless resolution — one shared helper for preview and publish:
  // try `{path}.html`, then `{path}/index.html`.
  const resolved = await resolveExtensionlessFile(rawPath || "index.html", (candidate) =>
    storage.readObject(userId, projectId, candidate)
  );

  if (!resolved) {
    return missingPublishedFile(c, storage, userId, projectId, rawPath, siteRootPath);
  }

  if (isProtectedServedPath(resolved.filePath)) {
    return missingPublishedFile(c, storage, userId, projectId, rawPath, siteRootPath);
  }

  const contentType = getServedContentType(resolved.filePath);
  const originalBytes = new Uint8Array(await resolved.object.arrayBuffer());
  let content = originalBytes;
  let transformed = false;
  const isMarkup = contentType.startsWith("text/html")
    || contentType.startsWith("image/svg+xml")
    || contentType.startsWith("application/xml");
  if (isMarkup || contentType.startsWith("text/css")) {
    const originalText = new TextDecoder().decode(originalBytes);
    const rewritten = isMarkup
      ? rewriteRootRelativeHtmlUrls(originalText, siteRootPath)
      : rewriteRootRelativeCssUrls(originalText, siteRootPath);
    if (rewritten !== originalText) {
      content = new TextEncoder().encode(rewritten);
      transformed = true;
    }
  }
  const headers = publishedResponseHeaders(resolved.filePath, resolved.object);
  if (transformed) {
    // The served bytes now include the canonical site mount, so validators
    // from the unrewritten R2 object no longer describe this response.
    headers.delete("ETag");
    headers.delete("Last-Modified");
  } else if (publishedObjectNotModified(c.req.raw, resolved.object)) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(binaryBody(content), {
    headers
  });
}

function publishedObjectNotModified(request: Request, object: R2ObjectBody): boolean {
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch !== null) {
    if (ifNoneMatch.trim() === "*") return true;
    if (!object.etag) return false;
    const current = object.etag.replace(/^W\//, "").replace(/^"|"$/g, "");
    return ifNoneMatch.split(",").some((candidate) =>
      candidate.trim().replace(/^W\//, "").replace(/^"|"$/g, "") === current
    );
  }

  const ifModifiedSince = request.headers.get("If-Modified-Since");
  if (!ifModifiedSince || !object.uploaded) return false;
  const since = Date.parse(ifModifiedSince);
  if (!Number.isFinite(since)) return false;
  return Math.floor(object.uploaded.getTime() / 1000) <= Math.floor(since / 1000);
}

/**
 * Build the Content-Type, caching validators, and §3¾ containment headers for
 * a served published byte — SS-8 (content type), SS-15 (ETag / Last-Modified /
 * mandatory revalidation), and the CSP sandbox composed on top.
 */
export function publishedResponseHeaders(filePath: string, object: R2ObjectBody): Headers {
  const contentType = getServedContentType(filePath);
  const headers = new Headers({ "Content-Type": contentType });

  if (object.etag) {
    headers.set("ETag", object.etag);
  }
  if (object.uploaded) {
    headers.set("Last-Modified", object.uploaded.toUTCString());
  }

  // Published keys are mutable: editing styles.css or hero.png changes the
  // bytes at the same URL. Require revalidation on every use so validators can
  // produce a cheap 304 without allowing an hour of stale public content.
  headers.set("Cache-Control", "public, max-age=0, must-revalidate");

  // §3¾: agent/student-authored bytes on our origin get the opaque-origin
  // containment (sandbox allow-scripts + nosniff + no-referrer). These COMPOSE
  // with the caching validators above — the CSP/security keys and the caching
  // keys are disjoint, so neither clobbers the other.
  for (const [key, value] of Object.entries(servedContentHeaders())) {
    headers.set(key, value);
  }
  return headers;
}
