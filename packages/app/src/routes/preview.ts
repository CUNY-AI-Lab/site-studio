import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { addCacheBusterToHtml, getContentType, isTextContentType } from "../lib/path";
import { binaryBody, jsonError } from "../lib/http";
import { getUser } from "../lib/session";
import { R2ProjectStorage } from "../storage/r2";

type AppContext = Context<{ Bindings: Env; Variables: { user: { id: string } } }>;

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
    jsonError("Project not found", 404);
  }

  if (!(await storage.projectExists(user.id, projectId))) {
    jsonError("Project not found", 404);
  }

  let filePath = requestedPath || "index.html";
  if (!filePath || filePath.endsWith("/")) {
    filePath = `${filePath}index.html`;
  }

  let content = await storage.readFileBuffer(user.id, projectId, filePath).catch(async () => {
    if (!filePath.includes(".")) {
      return storage.readFileBuffer(user.id, projectId, `${filePath}/index.html`);
    }
    throw new Error("Not found");
  });

  const resolvedPath = (await storage.fileExists(user.id, projectId, filePath))
    ? filePath
    : `${filePath}/index.html`;
  const contentType = getContentType(resolvedPath);

  c.header("Content-Type", isTextContentType(contentType) ? `${contentType}; charset=utf-8` : contentType);
  c.header("X-Frame-Options", "SAMEORIGIN");
  c.header("Cache-Control", "no-cache");
  c.header("Pragma", "no-cache");

  if (contentType === "text/html") {
    const version = c.req.query("v") || undefined;
    content = new TextEncoder().encode(addCacheBusterToHtml(new TextDecoder().decode(content), version));
  }

  return new Response(binaryBody(content), {
    headers: {
      "Content-Type": isTextContentType(contentType) ? `${contentType}; charset=utf-8` : contentType,
      "X-Frame-Options": "SAMEORIGIN",
      "Cache-Control": "no-cache",
      Pragma: "no-cache"
    }
  });
}
