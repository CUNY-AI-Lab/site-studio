import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { IMAGE_MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES, PROTECTED_FILE_NAMES } from "../lib/constants";
import { binaryBody, jsonError } from "../lib/http";
import { isTextContentType, sanitizeFilePath } from "../lib/path";
import { getUser } from "../lib/session";
import { FileNotFoundError, R2ProjectStorage } from "../storage/r2";
import { buildFileTree, getContentType } from "../lib/path";
import {
  imageTypeForExtension,
  isImageExtension,
  sniffImageType
} from "../lib/image-validation";
import { lintProject } from "../lib/a11y-lint";

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

function fileExtension(fileName: string): string {
  return fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")).toLowerCase() : "";
}

/**
 * Best-effort extraction of the placehold.co URL from the finding's line. The
 * linter reports a 1-based line number; we grab the placehold.co URL on that
 * line if it's cheap to find, otherwise return null (src is omitted).
 */
function extractPlaceholderSrc(content: string | undefined, line: number | null): string | null {
  if (!content || line == null) {
    return null;
  }
  const lines = content.split("\n");
  const target = lines[line - 1];
  if (!target) {
    return null;
  }
  const match = /https?:\/\/placehold\.co\/[^\s"'<>()]*/i.exec(target);
  return match ? match[0] : null;
}

function validateUpload(file: File, fileName: string) {
  const ext = fileExtension(fileName);
  const isImage = isImageExtension(ext);

  // Images get a tighter cap; everything else keeps the generic 32MB limit.
  const maxBytes = isImage ? IMAGE_MAX_UPLOAD_BYTES : MAX_UPLOAD_BYTES;
  if (file.size > maxBytes) {
    jsonError(`File too large. Max ${maxBytes / (1024 * 1024)}MB`, 400);
  }

  const allowed = new Set([
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".pdf", ".docx", ".txt", ".csv", ".md", ".json", ".html", ".css", ".js"
  ]);

  if (!allowed.has(ext)) {
    jsonError(`Unsupported file extension: ${ext || "unknown"}`, 400);
  }
}

/**
 * For files with an image extension, require the magic bytes to match the
 * extension family (so a ".png" that is really HTML is rejected). Non-image
 * files pass through untouched.
 */
function validateImageBytes(fileName: string, bytes: Uint8Array) {
  const ext = fileExtension(fileName);
  const expected = imageTypeForExtension(ext);
  if (!expected) {
    return;
  }

  const actual = sniffImageType(bytes);
  if (actual !== expected) {
    jsonError(
      `This file has a ${ext} extension but its contents are not a valid ${expected.toUpperCase()} image. Upload a real image file.`,
      400
    );
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

  app.get("/api/projects/:id/images", async (c) => {
    const storage = new R2ProjectStorage(c.env.SITE_STUDIO_BUCKET);
    const user = getUser(c);
    const projectId = c.req.param("id");

    if (!(await storage.projectExists(user.id, projectId))) {
      jsonError("Project not found", 404);
    }

    const files = await storage.listFiles(user.id, projectId);

    // Every image file in the project (any prefix), returned flat with size.
    const images = files
      .filter((file) => isImageExtension(fileExtension(file.name)))
      .map((file) => ({ path: file.path, size: file.size }));

    // Placeholder findings: run the a11y linter over the project's HTML and keep
    // only the placehold.co placeholder rule, enriched with the placeholder src
    // when it can be pulled from the offending line cheaply.
    const htmlFiles: Record<string, string> = {};
    for (const file of files) {
      if (/\.html?$/i.test(file.path)) {
        htmlFiles[file.path] = await storage.readFile(user.id, projectId, file.path);
      }
    }

    const placeholders = lintProject(htmlFiles)
      .filter((finding) => finding.rule === "placeholder-image")
      .map((finding) => {
        const src = extractPlaceholderSrc(htmlFiles[finding.file], finding.line);
        return {
          file: finding.file,
          line: finding.line,
          message: finding.message,
          ...(src ? { src } : {})
        };
      });

    return c.json({ images, placeholders });
  });

  app.get("/api/projects/:id/file", async (c) => {
    const storage = new R2ProjectStorage(c.env.SITE_STUDIO_BUCKET);
    const user = getUser(c);
    const projectId = c.req.param("id");
    const filePath = sanitizeFilePath(c.req.query("path") || "");

    if (!(await storage.projectExists(user.id, projectId))) {
      jsonError("Project not found", 404);
    }

    if (!isTextContentType(getContentType(filePath))) {
      jsonError("Binary files cannot be opened in the text editor. Download the file instead.", 415);
    }

    let content: string;
    try {
      content = await storage.readFile(user.id, projectId, filePath);
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        jsonError("File not found", 404);
      }
      throw error;
    }

    return c.json({
      path: filePath,
      contentType: getContentType(filePath),
      isText: true,
      content
    });
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

    if (!isTextContentType(getContentType(filePath))) {
      jsonError("Binary files cannot be saved through the text editor endpoint.", 415);
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

    // Optional `dir` field lets callers place uploads under a fixed prefix. Only
    // the literal "images" is allowed; anything else is rejected so the field
    // can never be used to write outside a known location.
    const dirEntry = form.get("dir");
    let prefix = "";
    if (dirEntry !== null) {
      if (dirEntry !== "images") {
        jsonError('Invalid upload directory. Only "images" is allowed.', 400);
      }
      prefix = "images/";
    }

    const sanitized = sanitizeUploadName(entry.name);
    validateUpload(entry, sanitized);

    const buffer = new Uint8Array(await entry.arrayBuffer());
    validateImageBytes(sanitized, buffer);

    // Collision-suffix within the target prefix so images/photo.png and
    // photo.png at the root never clobber each other. The write itself is
    // atomic (put-if-absent): rather than probe with fileExists() and then
    // put() — a TOCTOU where two concurrent same-name uploads both see "absent"
    // and the second clobbers the first — we ATTEMPT the conditional write at
    // each candidate and only advance the suffix when the write loses the race.
    const dotIndex = sanitized.lastIndexOf(".");
    const base = dotIndex >= 0 ? sanitized.slice(0, dotIndex) : sanitized;
    const ext = dotIndex >= 0 ? sanitized.slice(dotIndex) : "";

    const MAX_UPLOAD_ATTEMPTS = 50;
    let filename = "";
    let written = false;
    for (let counter = 0; counter < MAX_UPLOAD_ATTEMPTS; counter += 1) {
      const candidate = counter === 0 ? `${prefix}${sanitized}` : `${prefix}${base}_${counter}${ext}`;
      if (await storage.uploadToProjectIfAbsent(user.id, projectId, candidate, buffer)) {
        filename = candidate;
        written = true;
        break;
      }
    }

    if (!written) {
      jsonError("Could not find a free filename for the upload. Rename the file and try again.", 409);
    }

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

    let buffer: Uint8Array;
    try {
      buffer = await storage.readFileBuffer(user.id, projectId, filePath);
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        jsonError("File not found", 404);
      }
      throw error;
    }

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
