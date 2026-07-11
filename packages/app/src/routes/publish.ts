import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { getServedContentType } from "../lib/constants";
import { binaryBody, jsonError } from "../lib/http";
import { loadMigrationPointer } from "../lib/migration";
import { getUserHandle, resolveHandleOwner } from "../lib/handles";
import { renderNotFoundPage } from "../../../serving-core/src/not-found-page";
import { servedContentHeaders } from "../../../serving-core/src/serving-headers";
import { looksLikePageNavigation } from "../../../serving-core/src/page-navigation";
import { resolveExtensionlessFile } from "../../../serving-core/src/extensionless";
import { isProtectedServedPath } from "../../../serving-core/src/protected-files";
import { sniffImageType } from "../lib/image-validation";
import { getUser } from "../lib/session";
import { lintProject, type A11yFinding } from "../lib/a11y-lint";
import { R2ProjectStorage } from "../storage/r2";
import type { RequireProjectVariables } from "../lib/require-project";
import { isLoopbackOrigin } from "../lib/csrf";

const MAX_PUBLISH_A11Y_FINDINGS = 50;

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
  if (looksLikePageNavigation(c.req.header("Accept"), filePath)) {
    return c.html(renderNotFoundPage(siteRootPath), 404);
  }
  return c.text("Not found", 404);
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
      // on our origin — §3¾ containment applies (see serving-core/serving-headers.ts). It
      // goes through the same header builder as a 200 so the content-type,
      // caching validators, and CSP match the publisher's notFoundResponse.
      return new Response(binaryBody(new Uint8Array(await custom.arrayBuffer())), {
        status: 404,
        headers: publishedResponseHeaders("404.html", custom)
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

type AppContext = Context<{ Bindings: Env; Variables: RequireProjectVariables }>;

export function createPublishRouter() {
  const app = new Hono<{ Bindings: Env; Variables: RequireProjectVariables }>();

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
          message: "Choose your public handle before publishing."
        },
        409
      );
    }

    const desiredSlug = metadata.slug || slugify(metadata.name || projectId) || projectId;
    const slug = await storage.resolvePublishedSlug(user.id, desiredSlug, projectId);
    const url = `${getPublishedBaseUrl(c)}/u/${handle}/${slug}/`;

    await storage.updateProjectMetadata(user.id, projectId, {
      published: true,
      publishedUrl: url,
      publishedAt: new Date().toISOString(),
      slug
    });

    const a11yFindings = await collectPublishA11yFindings(storage, user.id, projectId);

    return c.json({
      success: true,
      message: "Project published successfully",
      url,
      a11yFindings
    });
  });

  app.post("/api/projects/:id/unpublish", async (c) => {
    const storage = c.get("storage");
    const user = getUser(c);
    const projectId = c.get("projectId");
    const metadata = await storage.getProjectMetadata(user.id, projectId);

    if (!metadata?.published) {
      jsonError("Project is not currently published", 400);
    }

    await storage.updateProjectMetadata(user.id, projectId, {
      published: false,
      publishedUrl: undefined,
      unpublishedAt: new Date().toISOString()
    });

    return c.json({
      success: true,
      message: "Project unpublished successfully"
    });
  });

  app.post("/api/projects/:id/thumbnail", async (c) => {
    const storage = c.get("storage");
    const user = getUser(c);
    const projectId = c.get("projectId");
    const form = await c.req.formData();
    const entry = form.get("image");

    if (!entry || typeof entry === "string") {
      jsonError("No image uploaded", 400);
    }

    const image = entry as File;

    if (image.type !== "image/png") {
      jsonError("Only image/png is supported", 400);
    }

    const content = new Uint8Array(await image.arrayBuffer());

    // SS-21: don't trust the client-declared type. Thumbnails are PNGs, so sniff
    // the magic bytes and reject anything that isn't a real PNG — the same
    // defense the main upload route applies via validateImageBytes.
    if (sniffImageType(content) !== "png") {
      jsonError("Thumbnail must be a valid PNG image.", 400);
    }

    await storage.writeThumbnail(user.id, projectId, content);
    await storage.updateProjectMetadata(user.id, projectId, {
      thumbnailUrl: `/api/projects/${projectId}/thumbnail`
    });

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
        "Cache-Control": "public, max-age=60",
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

  // Legacy published URL: /sites/{ownerId}/{slug}/*. Kept working. If the
  // resolved owner has a handle we 301 to the equivalent /u/ address;
  // otherwise (pre-handle sites) we serve content directly.
  app.get("/sites/:userId/:slug", async (c) => {
    return serveLegacySite(c, "index.html");
  });

  app.get("/sites/:userId/:slug/*", async (c) => {
    const base = `/sites/${c.req.param("userId")}/${c.req.param("slug")}/`;
    const url = new URL(c.req.url);
    const filePath = url.pathname.slice(base.length) || "index.html";
    return serveLegacySite(c, filePath);
  });

  return app;
}

/**
 * Resolve a published project under `userId`, following the migration
 * forwarding pointer (lib/migration.ts) so re-homed anonymous namespaces keep
 * serving. Returns the effective owner id (post-migration) and the resolved
 * project, or null when nothing matches.
 */
async function resolvePublishedSite(
  storage: R2ProjectStorage,
  bucket: R2Bucket,
  requestedUserId: string,
  slug: string
): Promise<{ ownerId: string; resolved: { projectId: string } } | null> {
  let userId = requestedUserId;
  let resolved = await storage.findPublishedProjectBySlug(userId, slug);

  if (!resolved) {
    const pointer = await loadMigrationPointer(bucket, userId);
    if (pointer) {
      userId = pointer.subject;
      resolved = await storage.findPublishedProjectBySlug(userId, pointer.slugs[slug] ?? slug);
    }
  }

  return resolved ? { ownerId: userId, resolved } : null;
}

/** Serve a file for a canonical /u/{handle}/{slug}/ request. */
async function serveByHandle(c: AppContext, rawPath: string) {
  const storage = new R2ProjectStorage(c.env.SITE_STUDIO_BUCKET);
  const handle = c.req.param("handle");
  const slug = c.req.param("slug");
  if (!handle || !slug) {
    return publishedNotFound(c, rawPath);
  }

  const siteRootPath = `/u/${handle}/${slug}/`;

  const ownerId = await resolveHandleOwner(c.env.SITE_STUDIO_BUCKET, handle);
  if (!ownerId) {
    return publishedNotFound(c, rawPath);
  }

  const site = await resolvePublishedSite(storage, c.env.SITE_STUDIO_BUCKET, ownerId, slug);
  if (!site) {
    return publishedNotFound(c, rawPath);
  }

  return servePublishedFile(c, storage, site.ownerId, site.resolved.projectId, rawPath, siteRootPath);
}

/**
 * Serve a legacy /sites/{ownerId}/{slug}/ request. If the (post-migration)
 * owner has a handle, 301 to the equivalent /u/{handle}/{slug}/{filePath}
 * preserving the sub-path and query string. Only owners with NO handle serve
 * content directly, so pre-handle published sites keep working unchanged.
 */
async function serveLegacySite(c: AppContext, rawPath: string) {
  const storage = new R2ProjectStorage(c.env.SITE_STUDIO_BUCKET);
  const requestedUserId = c.req.param("userId");
  const slug = c.req.param("slug");
  if (!requestedUserId || !slug) {
    return publishedNotFound(c, rawPath);
  }

  const siteRootPath = `/sites/${requestedUserId}/${slug}/`;

  const site = await resolvePublishedSite(storage, c.env.SITE_STUDIO_BUCKET, requestedUserId, slug);
  if (!site) {
    return publishedNotFound(c, rawPath);
  }

  // If the resolved owner has a handle, the canonical home is /u/{handle}/…;
  // redirect there so a single public address wins and the owner id stops
  // appearing in the URL. `slug` is the legacy-URL slug; keep it as the /u/
  // slug so shared deep links resolve unchanged (the /u/ handler re-resolves).
  const handle = await getUserHandle(c.env.SITE_STUDIO_BUCKET, site.ownerId);
  if (handle) {
    const url = new URL(c.req.url);
    // Preserve the exact sub-path from the request (not the "index.html"
    // default) and the query string, so deep links redirect faithfully.
    const base = `/sites/${requestedUserId}/${slug}/`;
    const subPath = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : "";
    const location = `/u/${handle}/${slug}/${subPath}${url.search}`;
    return c.redirect(location, 301);
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

  // SS-14 extensionless resolution — one shared helper for all three serving
  // paths (preview, publish, publisher worker): try `{path}.html`, then
  // `{path}/index.html`. See packages/serving-core/src/extensionless.ts.
  const resolved = await resolveExtensionlessFile(rawPath || "index.html", (candidate) =>
    storage.readObject(userId, projectId, candidate)
  );

  if (!resolved) {
    return missingPublishedFile(c, storage, userId, projectId, rawPath, siteRootPath);
  }

  if (isProtectedServedPath(resolved.filePath)) {
    return missingPublishedFile(c, storage, userId, projectId, rawPath, siteRootPath);
  }

  return new Response(binaryBody(new Uint8Array(await resolved.object.arrayBuffer())), {
    headers: publishedResponseHeaders(resolved.filePath, resolved.object)
  });
}

/**
 * Build the Content-Type, caching validators, and §3¾ containment headers for
 * a served published byte. Deliberately mirrors the publisher worker's
 * responseHeaders() (packages/worker/src/index.ts) so both origins emit the
 * SAME header set for the same file — SS-8 (content type), SS-15 (ETag /
 * Last-Modified / HTML max-age=300), and the CSP sandbox composed on top.
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

  // SS-15: HTML is short-lived (edits should surface quickly); stable asset
  // filenames get a short revalidatable cache. Same posture as the publisher.
  if (contentType.startsWith("text/html")) {
    headers.set("Cache-Control", "public, max-age=300");
  } else {
    headers.set("Cache-Control", "public, max-age=3600");
  }

  // §3¾: agent/student-authored bytes on our origin get the opaque-origin
  // containment (sandbox allow-scripts + nosniff + no-referrer). These COMPOSE
  // with the caching validators above — the CSP/security keys and the caching
  // keys are disjoint, so neither clobbers the other. serveByHandle (/u/) and
  // serveLegacySite (/sites/) both funnel through here, covering every byte.
  for (const [key, value] of Object.entries(servedContentHeaders())) {
    headers.set(key, value);
  }
  return headers;
}
