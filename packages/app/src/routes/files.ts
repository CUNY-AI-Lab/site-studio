import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { MAX_UPLOAD_BYTES, PROTECTED_FILE_NAMES } from "../lib/constants";
import { binaryBody, jsonError } from "../lib/http";
import { sanitizeFilePath } from "../lib/path";
import { getUser } from "../lib/session";
import { R2ProjectStorage } from "../storage/r2";
import { buildFileTree, getContentType } from "../lib/path";

const saveFileSchema = z.object({
  path: z.string().min(1),
  content: z.string()
});

const renameFileSchema = z.object({
  oldPath: z.string().min(1),
  newPath: z.string().min(1)
});

function sanitizeUploadName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isFileUpload(value: FormDataEntryValue | null): value is File {
  return !!value && typeof value !== "string" && typeof value.arrayBuffer === "function";
}

function validateUpload(file: File, fileName: string) {
  if (file.size > MAX_UPLOAD_BYTES) {
    jsonError(`File too large. Max ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB`, 400);
  }

  const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")).toLowerCase() : "";
  const allowed = new Set([
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".pdf", ".docx", ".txt", ".csv", ".md", ".json", ".html", ".css", ".js"
  ]);

  if (!allowed.has(ext)) {
    jsonError(`Unsupported file extension: ${ext || "unknown"}`, 400);
  }
}

export function createFileRouter() {
  const app = new Hono<{ Bindings: Env; Variables: { user: { id: string } } }>();

  app.get("/api/projects/:id/files", async (c) => {
    const storage = new R2ProjectStorage(c.env.SITE_STUDIO_BUCKET);
    const user = getUser(c);
    const projectId = c.req.param("id");

    if (!(await storage.projectExists(user.id, projectId))) {
      jsonError("Project not found", 404);
    }

    const files = await storage.listFiles(user.id, projectId);
    return c.json({ files: buildFileTree(files) });
  });

  app.get("/api/projects/:id/file", async (c) => {
    const storage = new R2ProjectStorage(c.env.SITE_STUDIO_BUCKET);
    const user = getUser(c);
    const projectId = c.req.param("id");
    const filePath = sanitizeFilePath(c.req.query("path") || "");

    if (!(await storage.projectExists(user.id, projectId))) {
      jsonError("Project not found", 404);
    }

    const content = await storage.readFile(user.id, projectId, filePath);
    return c.json({ path: filePath, content });
  });

  app.post("/api/projects/:id/file", async (c) => {
    const storage = new R2ProjectStorage(c.env.SITE_STUDIO_BUCKET);
    const user = getUser(c);
    const projectId = c.req.param("id");
    const { path, content } = saveFileSchema.parse(await c.req.json());
    const filePath = sanitizeFilePath(path);

    if (!(await storage.projectExists(user.id, projectId))) {
      jsonError("Project not found", 404);
    }

    await storage.writeFile(user.id, projectId, filePath, content);
    return c.json({ success: true, path: filePath, message: "File saved successfully" });
  });

  app.delete("/api/projects/:id/files", async (c) => {
    const storage = new R2ProjectStorage(c.env.SITE_STUDIO_BUCKET);
    const user = getUser(c);
    const projectId = c.req.param("id");
    const filePath = sanitizeFilePath(c.req.query("path") || "");

    if (PROTECTED_FILE_NAMES.has(filePath.split("/").pop() || "")) {
      jsonError("Cannot delete protected files", 403);
    }

    if (!(await storage.projectExists(user.id, projectId))) {
      jsonError("Project not found", 404);
    }

    await storage.deleteFile(user.id, projectId, filePath);
    return c.json({ success: true, message: "File deleted successfully" });
  });

  app.put("/api/projects/:id/files/rename", async (c) => {
    const storage = new R2ProjectStorage(c.env.SITE_STUDIO_BUCKET);
    const user = getUser(c);
    const projectId = c.req.param("id");
    const { oldPath, newPath } = renameFileSchema.parse(await c.req.json());
    const currentPath = sanitizeFilePath(oldPath);
    const nextPath = sanitizeFilePath(newPath);

    if (PROTECTED_FILE_NAMES.has(currentPath.split("/").pop() || "")) {
      jsonError("Cannot rename protected files", 403);
    }

    if (!(await storage.projectExists(user.id, projectId))) {
      jsonError("Project not found", 404);
    }

    if (!(await storage.fileExists(user.id, projectId, currentPath))) {
      jsonError("File not found", 404);
    }

    if (await storage.fileExists(user.id, projectId, nextPath)) {
      jsonError("A file with that name already exists", 409);
    }

    await storage.renameFile(user.id, projectId, currentPath, nextPath);
    return c.json({ success: true, oldPath: currentPath, newPath: nextPath, message: "File renamed successfully" });
  });

  app.post("/api/projects/:id/upload", async (c) => {
    const storage = new R2ProjectStorage(c.env.SITE_STUDIO_BUCKET);
    const user = getUser(c);
    const projectId = c.req.param("id");
    const form = await c.req.formData();
    const entry = form.get("file");

    if (!isFileUpload(entry)) {
      jsonError("No file uploaded", 400);
    }

    if (!(await storage.projectExists(user.id, projectId))) {
      jsonError("Project not found", 404);
    }

    const sanitized = sanitizeUploadName(entry.name);
    validateUpload(entry, sanitized);

    let filename = sanitized;
    let counter = 1;
    while (await storage.fileExists(user.id, projectId, filename)) {
      const dotIndex = sanitized.lastIndexOf(".");
      const base = dotIndex >= 0 ? sanitized.slice(0, dotIndex) : sanitized;
      const ext = dotIndex >= 0 ? sanitized.slice(dotIndex) : "";
      filename = `${base}_${counter}${ext}`;
      counter += 1;
    }

    const buffer = new Uint8Array(await entry.arrayBuffer());
    await storage.uploadToProject(user.id, projectId, filename, buffer);

    return c.json({
      success: true,
      filename,
      path: filename,
      size: entry.size,
      message: "File uploaded successfully"
    });
  });

  app.get("/api/projects/:id/download", async (c) => {
    const storage = new R2ProjectStorage(c.env.SITE_STUDIO_BUCKET);
    const user = getUser(c);
    const projectId = c.req.param("id");
    const filePath = sanitizeFilePath(c.req.query("path") || "");

    if (!(await storage.projectExists(user.id, projectId))) {
      jsonError("Project not found", 404);
    }

    const buffer = await storage.readFileBuffer(user.id, projectId, filePath);
    return new Response(binaryBody(buffer), {
      headers: {
        "Content-Disposition": `attachment; filename="${filePath.split("/").pop() || "download"}"`,
        "Content-Type": getContentType(filePath),
        "Content-Length": String(buffer.byteLength)
      }
    });
  });

  return app;
}
