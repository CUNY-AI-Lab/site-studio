import { renderNotFoundPage } from "./not-found-page";
import { servedContentHeaders } from "./serving-headers";
// SS-8 served content-type resolver: single source of truth in
// @site-studio/serving-core, shared with the app worker. Imported under this
// worker's public name (getContentType) so callers/tests stay unchanged, then
// re-exported below.
import { getServedContentType as getContentType } from "../../serving-core/src/content-types";
import { looksLikePageNavigation as looksLikePageNavigationCore } from "../../serving-core/src/page-navigation";

export type Env = {
  PUBLIC_DOMAIN?: string;
  SITE_STUDIO_BUCKET: R2Bucket;
};

type ProjectMetadata = {
  id?: string;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
  published?: boolean;
  publishedAt?: string;
  slug?: string;
};

export function sanitizeFilePath(filePath: string): string {
  const normalized = filePath
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");

  if (!normalized) {
    throw new Error("File path is required");
  }

  if (normalized.includes("\0") || normalized.includes("..")) {
    throw new Error("Invalid file path");
  }

  return normalized;
}

export function metadataKey(userId: string, projectId: string): string {
  return `projects/${userId}/${projectId}/.metadata.json`;
}

export function fileKey(userId: string, projectId: string, filePath: string): string {
  return `projects/${userId}/${projectId}/${sanitizeFilePath(filePath)}`;
}

// SS-8 served content-type resolver — re-exported under this worker's public
// name. Both workers now resolve from the one shared table
// (packages/serving-core/src/content-types.ts), so a one-sided edit is
// structurally impossible.
export { getContentType };

export function publishedSortKey(metadata: ProjectMetadata): string {
  return metadata.publishedAt || metadata.updatedAt || metadata.createdAt || "";
}

/**
 * Forwarding pointer written by the app worker's anonymous-data migration
 * (packages/app/src/lib/migration.ts — keep the shape in sync). When an
 * anonymous namespace is re-homed to a CAIL subject, this pointer stays at
 * `projects/<anonUserId>/.migrated.json` forever so previously shared
 * /sites/<anonUserId>/<slug>/ URLs keep serving the live, migrated site.
 */
type MigrationPointer = {
  version: number;
  subject: string;
  migratedAt?: string;
  projects?: Record<string, string>;
  slugs?: Record<string, string>;
};

export async function loadMigrationPointer(
  bucket: R2Bucket,
  userId: string
): Promise<MigrationPointer | null> {
  const object = await bucket.get(`projects/${userId}/.migrated.json`);
  if (!object) {
    return null;
  }

  try {
    const pointer = JSON.parse(await object.text()) as MigrationPointer;
    if (pointer.version !== 1 || typeof pointer.subject !== "string" || !pointer.subject) {
      return null;
    }
    return pointer;
  } catch (error) {
    console.warn(`Skipping invalid migration pointer for ${userId}`, error);
    return null;
  }
}

/**
 * A parsed published request. `kind` distinguishes the canonical handle URL
 * (/u/{handle}/{slug}/) from the legacy owner-id URL (/sites/{userId}/{slug}/).
 * For "handle" requests `owner` holds the handle to be resolved to a subject;
 * for "legacy" requests it holds the owner id directly.
 *
 * SS-16: this ONLY matches the two explicit prefixes. It used to also treat any
 * bare `≥2-segment` path as `{userId}/{slug}` and serve content addressed by
 * raw owner id — with no handle indirection and no 301 to the /u/ form. The /u/
 * scheme exists precisely to keep the CAIL subject out of public URLs; that
 * bare fallback re-leaked it, and if the route pattern were ever broadened to
 * catch bare paths it would silently serve owner-id-addressed content again.
 * The branch is removed: a bare path returns null → the styled 404. The app
 * worker has never had a bare route, so removing it also aligns the two.
 */
export type ParsedPublishedRequest =
  | { kind: "handle"; handle: string; slug: string; filePath: string }
  | { kind: "legacy"; userId: string; slug: string; filePath: string };

export function parsePublishedRequest(url: URL): ParsedPublishedRequest | null {
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts.length >= 3 && parts[0] === "u") {
    return {
      kind: "handle",
      handle: parts[1],
      slug: parts[2],
      filePath: parts.slice(3).join("/") || "index.html"
    };
  }

  if (parts.length >= 3 && parts[0] === "sites") {
    return {
      kind: "legacy",
      userId: parts[1],
      slug: parts[2],
      filePath: parts.slice(3).join("/") || "index.html"
    };
  }

  return null;
}

/**
 * Two-way handle mapping, read straight from R2 (the publisher has no KV, so
 * the app worker's KV is not available here — the mapping lives in the bucket).
 * Keep the shapes in sync with packages/app/src/lib/handles.ts.
 */
export async function resolveHandleOwner(bucket: R2Bucket, handle: string): Promise<string | null> {
  const object = await bucket.get(`handles/${handle}.json`);
  if (!object) return null;
  try {
    const record = JSON.parse(await object.text()) as { ownerId?: unknown };
    return typeof record.ownerId === "string" && record.ownerId ? record.ownerId : null;
  } catch {
    return null;
  }
}

export async function getUserHandle(bucket: R2Bucket, ownerId: string): Promise<string | null> {
  const object = await bucket.get(`userhandles/${ownerId}.json`);
  if (!object) return null;
  try {
    const record = JSON.parse(await object.text()) as { handle?: unknown };
    return typeof record.handle === "string" && record.handle ? record.handle : null;
  } catch {
    return null;
  }
}

export async function listProjects(bucket: R2Bucket, userId: string): Promise<string[]> {
  const prefix = `projects/${userId}/`;
  const ids = new Set<string>();
  let cursor: string | undefined;

  do {
    const listed = await bucket.list({
      prefix,
      delimiter: "/",
      cursor
    });

    for (const delimited of listed.delimitedPrefixes || []) {
      const trimmed = delimited.slice(prefix.length).replace(/\/$/, "");
      if (trimmed) {
        ids.add(trimmed);
      }
    }

    for (const object of listed.objects) {
      const relative = object.key.slice(prefix.length);
      const [projectId] = relative.split("/");
      // Dotfile entries (e.g. the migration pointer .migrated.json) are
      // system objects, never projects.
      if (projectId && !projectId.startsWith(".")) {
        ids.add(projectId);
      }
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return [...ids].sort();
}

export async function getProjectMetadata(
  bucket: R2Bucket,
  userId: string,
  projectId: string
): Promise<ProjectMetadata | null> {
  const object = await bucket.get(metadataKey(userId, projectId));
  if (!object) {
    return null;
  }

  try {
    return JSON.parse(await object.text()) as ProjectMetadata;
  } catch (error) {
    console.warn(`Skipping invalid project metadata: ${metadataKey(userId, projectId)}`, error);
    return null;
  }
}

export async function findPublishedProject(
  bucket: R2Bucket,
  userId: string,
  requestedSlug: string
): Promise<{ projectId: string; metadata: ProjectMetadata } | null> {
  const projectIds = await listProjects(bucket, userId);
  const matches: Array<{ projectId: string; metadata: ProjectMetadata }> = [];

  for (const projectId of projectIds) {
    const metadata = await getProjectMetadata(bucket, userId, projectId);
    if (!metadata?.published) {
      continue;
    }

    if (metadata.slug === requestedSlug || (!metadata.slug && projectId === requestedSlug)) {
      matches.push({ projectId, metadata });
    }
  }

  if (matches.length === 0) {
    return null;
  }

  // SS-13 tiebreaker: on equal published timestamps, break by projectId so the
  // choice is DETERMINISTIC and identical to the app worker's
  // findPublishedProjectBySlug. Without the secondary key two same-timestamp
  // duplicates could resolve to different projects on the two origins.
  matches.sort((left, right) => {
    const publishedOrder = publishedSortKey(right.metadata).localeCompare(publishedSortKey(left.metadata));
    if (publishedOrder !== 0) {
      return publishedOrder;
    }
    return right.projectId.localeCompare(left.projectId);
  });
  return matches[0] || null;
}

export async function readObject(
  bucket: R2Bucket,
  userId: string,
  projectId: string,
  filePath: string
): Promise<R2ObjectBody | null> {
  return bucket.get(fileKey(userId, projectId, filePath));
}

export function responseHeaders(filePath: string, object: R2ObjectBody): Headers {
  const contentType = getContentType(filePath);
  const headers = new Headers({
    "Content-Type": contentType,
    ETag: object.etag
  });

  if (object.uploaded) {
    headers.set("Last-Modified", object.uploaded.toUTCString());
  }

  if (contentType.startsWith("text/html")) {
    headers.set("Cache-Control", "public, max-age=300");
  } else {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  }

  // §3¾: every project-supplied byte served here (200 responses AND a custom
  // 404.html, both of which build headers through this helper) is
  // agent/student-authored active content on our origin — force the opaque
  // origin so it can never read our cookie/session. The styled fallback 404
  // builds its own headers and is intentionally NOT covered (it is our own
  // trusted markup, not user bytes). See serving-headers.ts.
  for (const [key, value] of Object.entries(servedContentHeaders(contentType))) {
    headers.set(key, value);
  }

  return headers;
}

/**
 * A request "looks like a page navigation" when the visitor is expecting a
 * document (so a styled 404 belongs) rather than an asset like an image/css/js
 * referenced by a tag. We serve HTML only for navigations so a broken
 * <img>/<script>/<link> does not download a full HTML document.
 */
export function looksLikePageNavigation(request: Request, filePath: string): boolean {
  return looksLikePageNavigationCore(request.headers.get("Accept"), filePath);
}

/** The site's root path for a "Go to site home" link, if we know it. */
export function siteRootPath(userId?: string, slug?: string): string | undefined {
  return userId && slug ? `/sites/${userId}/${slug}/` : undefined;
}

/**
 * The raw sub-path of a legacy /sites/{userId}/{slug}/… (or bare
 * /{userId}/{slug}/…) request — everything after the slug segment, with no
 * `index.html` default. Used to build a faithful 301 to the /u/ canonical URL.
 */
export function legacySubPath(url: URL): string {
  const parts = url.pathname.split("/").filter(Boolean);
  const skip = parts[0] === "sites" ? 3 : 2; // drop [sites,]userId,slug
  return parts.slice(skip).join("/");
}

/**
 * Styled/terse fallback 404 for the publisher. Page navigations get the
 * dignified HTML document (with a home link when available); asset requests
 * keep a terse plain-text 404.
 */
export function fallbackNotFoundResponse(
  request: Request,
  filePath: string,
  rootPath?: string
): Response {
  if (looksLikePageNavigation(request, filePath)) {
    return new Response(renderNotFoundPage(rootPath), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
  return new Response("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}

/**
 * Missing file within a resolved published site. A project-supplied 404.html
 * wins ONLY for page navigations; otherwise fall back to the styled/terse
 * response.
 *
 * SS-27: this used to serve the custom 404.html for ANY miss, including a
 * broken <img>/<script>/<link>, so an asset request could download a full HTML
 * document. Gating on looksLikePageNavigation (matching the app worker) keeps
 * asset misses terse and reserves the styled HTML for real navigations.
 */
export async function notFoundResponse(
  bucket: R2Bucket,
  userId: string,
  projectId: string,
  request: Request,
  filePath: string,
  rootPath?: string
): Promise<Response> {
  if (looksLikePageNavigation(request, filePath)) {
    const custom404 = await readObject(bucket, userId, projectId, "404.html");
    if (custom404) {
      return new Response(custom404.body, {
        status: 404,
        headers: responseHeaders("404.html", custom404)
      });
    }
  }

  return fallbackNotFoundResponse(request, filePath, rootPath);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parsed = parsePublishedRequest(url);
    if (!parsed) {
      // No site context to link back to — styled/terse 404 with no home link.
      return fallbackNotFoundResponse(request, url.pathname);
    }

    // Canonical /u/{handle}/{slug}/ — resolve the handle to its owner id first;
    // the owner id (CAIL subject) never appears in the URL.
    let ownerId: string;
    let rootPath: string | undefined;
    if (parsed.kind === "handle") {
      const owner = await resolveHandleOwner(env.SITE_STUDIO_BUCKET, parsed.handle);
      if (!owner) {
        return fallbackNotFoundResponse(request, parsed.filePath);
      }
      ownerId = owner;
      rootPath = `/u/${parsed.handle}/${parsed.slug}/`;
    } else {
      ownerId = parsed.userId;
      rootPath = siteRootPath(parsed.userId, parsed.slug);
    }

    let resolved = await findPublishedProject(env.SITE_STUDIO_BUCKET, ownerId, parsed.slug);

    if (!resolved) {
      // The owner id in the URL may be an anonymous namespace re-homed to a
      // CAIL subject; follow the forwarding pointer so old links keep working.
      const pointer = await loadMigrationPointer(env.SITE_STUDIO_BUCKET, ownerId);
      if (pointer) {
        ownerId = pointer.subject;
        const mappedSlug = pointer.slugs?.[parsed.slug] ?? parsed.slug;
        resolved = await findPublishedProject(env.SITE_STUDIO_BUCKET, ownerId, mappedSlug);
      }
    }

    if (!resolved) {
      // Unknown site: the slug does not resolve, so we cannot promise a home
      // link points at a live page. Styled/terse 404 without a home link.
      return fallbackNotFoundResponse(request, parsed.filePath);
    }

    // Legacy /sites/ (and bare) URLs: if the resolved owner has a handle, the
    // canonical home is /u/{handle}/…; 301 there, preserving sub-path + query.
    // Owners with no handle keep serving legacy content directly.
    if (parsed.kind === "legacy") {
      const handle = await getUserHandle(env.SITE_STUDIO_BUCKET, ownerId);
      if (handle) {
        // Preserve the exact sub-path from the request (not the defaulted
        // filePath) and the query string, so deep links redirect faithfully.
        const subPath = legacySubPath(url);
        const location = `/u/${handle}/${parsed.slug}/${subPath}${url.search}`;
        return Response.redirect(new URL(location, url).toString(), 301);
      }
    }

    let filePath = parsed.filePath || "index.html";
    let object = await readObject(env.SITE_STUDIO_BUCKET, ownerId, resolved.projectId, filePath);

    if (!object && !filePath.endsWith(".html")) {
      const htmlPath = `${filePath}.html`;
      object = await readObject(env.SITE_STUDIO_BUCKET, ownerId, resolved.projectId, htmlPath);
      if (object) {
        filePath = htmlPath;
      }
    }

    if (!object && !filePath.endsWith(".html")) {
      const indexPath = filePath === "index.html" ? "index.html" : `${filePath.replace(/\/$/, "")}/index.html`;
      object = await readObject(env.SITE_STUDIO_BUCKET, ownerId, resolved.projectId, indexPath);
      if (object) {
        filePath = indexPath;
      }
    }

    if (!object) {
      return notFoundResponse(
        env.SITE_STUDIO_BUCKET,
        ownerId,
        resolved.projectId,
        request,
        parsed.filePath,
        rootPath
      );
    }

    return new Response(object.body, {
      status: 200,
      headers: responseHeaders(filePath, object)
    });
  }
};
