import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { getContentType } from "../lib/path";
import { binaryBody, jsonError } from "../lib/http";
import { getUser } from "../lib/session";
import { R2ProjectStorage } from "../storage/r2";

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
  const legacyConfiguredBaseUrl = c.env.R2_PUBLIC_DOMAIN?.trim();
  if (legacyConfiguredBaseUrl) {
    return normalizeBaseUrl(legacyConfiguredBaseUrl);
  }

  const configuredBaseUrl = c.env.PUBLISHED_BASE_URL?.trim();
  if (configuredBaseUrl) {
    return normalizeBaseUrl(configuredBaseUrl);
  }

  return normalizeBaseUrl(new URL(c.req.url).origin);
}

type AppContext = Context<{ Bindings: Env; Variables: { user: { id: string } } }>;

export function createPublishRouter() {
  const app = new Hono<{ Bindings: Env; Variables: { user: { id: string } } }>();

  app.post("/api/projects/:id/publish", async (c) => {
    const storage = new R2ProjectStorage(c.env.SITE_STUDIO_BUCKET);
    const user = getUser(c);
    const projectId = c.req.param("id");
    const metadata = await storage.getProjectMetadata(user.id, projectId);

    if (!metadata) {
      jsonError("Project not found", 404);
    }

    const desiredSlug = metadata.slug || slugify(metadata.name || projectId) || projectId;
    const slug = await storage.resolvePublishedSlug(user.id, desiredSlug, projectId);
    const url = `${getPublishedBaseUrl(c)}/sites/${user.id}/${slug}/`;

    await storage.updateProjectMetadata(user.id, projectId, {
      published: true,
      publishedUrl: url,
      publishedAt: new Date().toISOString(),
      slug
    });

    return c.json({
      success: true,
      message: "Project published successfully",
      url
    });
  });

  app.post("/api/projects/:id/unpublish", async (c) => {
    const storage = new R2ProjectStorage(c.env.SITE_STUDIO_BUCKET);
    const user = getUser(c);
    const projectId = c.req.param("id");
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
    const storage = new R2ProjectStorage(c.env.SITE_STUDIO_BUCKET);
    const user = getUser(c);
    const projectId = c.req.param("id");
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
    const storage = new R2ProjectStorage(c.env.SITE_STUDIO_BUCKET);
    const user = getUser(c);
    const projectId = c.req.param("id");
    const thumbnail = await storage.readThumbnail(user.id, projectId);

    if (!thumbnail) {
      jsonError("Thumbnail not found", 404);
    }

    return new Response(binaryBody(thumbnail), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=60"
      }
    });
  });

  app.get("/sites/:userId/:slug", async (c) => {
    return servePublishedFile(c, "index.html");
  });

  app.get("/sites/:userId/:slug/*", async (c) => {
    const base = `/sites/${c.req.param("userId")}/${c.req.param("slug")}/`;
    const url = new URL(c.req.url);
    const filePath = url.pathname.slice(base.length) || "index.html";
    return servePublishedFile(c, filePath);
  });

  return app;
}

async function servePublishedFile(
  c: AppContext,
  rawPath: string
) {
  const storage = new R2ProjectStorage(c.env.SITE_STUDIO_BUCKET);
  const userId = c.req.param("userId");
  const slug = c.req.param("slug");
  if (!userId || !slug) {
    jsonError("Published site not found", 404);
  }
  const resolved = await storage.findPublishedProjectBySlug(userId, slug);

  if (!resolved) {
    jsonError("Published site not found", 404);
  }

  let filePath = rawPath || "index.html";

  if (!(await storage.fileExists(userId, resolved.projectId, filePath))) {
    if (!filePath.endsWith(".html")) {
      const indexPath = filePath === "index.html" ? "index.html" : `${filePath.replace(/\/$/, "")}/index.html`;
      if (await storage.fileExists(userId, resolved.projectId, indexPath)) {
        filePath = indexPath;
      } else {
        jsonError("Not found", 404);
      }
    } else {
      jsonError("Not found", 404);
    }
  }

  const content = await storage.readFileBuffer(userId, resolved.projectId, filePath);
  const contentType = getContentType(filePath);
  const headers = new Headers({
    "Content-Type": contentType
  });
  if (!contentType.startsWith("text/html")) {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  }
  return new Response(binaryBody(content), { headers });
}
