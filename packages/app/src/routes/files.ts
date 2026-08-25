import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import {
  IMAGE_MAX_UPLOAD_BYTES,
  MAX_UPLOAD_BODY_BYTES,
  MAX_UPLOAD_BYTES,
  PROTECTED_FILE_NAMES
} from "../lib/constants";
import { binaryBody, jsonError } from "../lib/http";
import { isTextContentType, sanitizeFilePath } from "../lib/path";
import { getUser } from "../lib/session";
import { FileExistsError, FileNotFoundError } from "../storage/r2";
import { buildFileTree, getContentType } from "../lib/path";
import {
  imageTypeForExtension,
  isImageExtension,
  sniffImageType
} from "../lib/image-validation";
import { lintProject } from "../lib/a11y-lint";
import type { RequireProjectVariables } from "../lib/require-project";
import { executeOwnerMutation } from "../lib/owner-mutations";
import { readBoundedFormData } from "../lib/multipart";
import { getLoggingContext, serializeSiteStudioLoggingContext, type LoggingVariables } from "../lib/logging";

const saveFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  baseEtag: z.string().min(1)
});

const renameFileSchema = z.object({
  oldPath: z.string().min(1),
  newPath: z.string().min(1)
});

function sanitizeUploadName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isFileUpload(value: FormDataEntryValue | null): value is File {
  return value instanceof File;
}

function fileExtension(fileName: string): string {
  return fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")).toLowerCase() : "";
}

/**
 * Build a well-formed `Content-Disposition: attachment` header for `fileName`.
 *
 * SS-20: interpolating a raw filename into `filename="…"` breaks the header when
 * the name contains a `"` (or a control char / newline) — the quote closes the
 * token early and the tail spills into the header, enabling response-splitting-
 * style spoofing of the download name. We emit BOTH a sanitized ASCII `filename`
 * (quotes/backslashes/control chars stripped) for legacy clients AND the RFC 5987
 * `filename*=UTF-8''<percent-encoded>` form that modern browsers prefer, so the
 * real (possibly non-ASCII) name is conveyed unambiguously.
 */
function contentDispositionAttachment(fileName: string): string {
  // ASCII fallback: drop anything that could break the quoted-string token.
  const asciiFallback =
    // eslint-disable-next-line no-control-regex
    fileName.replace(/["\\\r\n\x00-\x1f\x7f]/g, "").replace(/[^\x20-\x7e]/g, "_") || "download";
  // RFC 5987: percent-encode the UTF-8 name; encodeURIComponent leaves a handful
  // of sub-delims that are legal in ext-value, so it is safe as-is here.
  const encoded = encodeURIComponent(fileName);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
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

function requiredPositiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    jsonError(`${name} is not configured`, 503);
  }
  return parsed;
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
  const app = new Hono<{ Bindings: Env; Variables: RequireProjectVariables & LoggingVariables }>();

  app.get("/api/projects/:id/files", async (c) => {
    const storage = c.get("storage");
    const user = getUser(c);
    const projectId = c.get("projectId");

    const files = await storage.listFiles(user.id, projectId);
    return c.json({ files: buildFileTree(files) });
  });

  app.get("/api/projects/:id/images", async (c) => {
    const storage = c.get("storage");
    const user = getUser(c);
    const projectId = c.get("projectId");

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
        return src
          ? { file: finding.file, line: finding.line, message: finding.message, src }
          : { file: finding.file, line: finding.line, message: finding.message };
      });

    return c.json({ images, placeholders });
  });

  app.get("/api/projects/:id/file", async (c) => {
    const storage = c.get("storage");
    const user = getUser(c);
    const projectId = c.get("projectId");
    const filePath = sanitizeFilePath(c.req.query("path") || "");

    if (!isTextContentType(getContentType(filePath))) {
      jsonError("Binary files cannot be opened in the text editor. Download the file instead.", 415);
    }

    const file = await storage.readFileWithEtag(user.id, projectId, filePath);
    if (!file) {
      jsonError("File not found", 404);
    }

    return c.json({
      path: filePath,
      contentType: getContentType(filePath),
      isText: true,
      content: file.content,
      etag: file.etag
    });
  });

  app.post("/api/projects/:id/file", async (c) => {
    const storage = c.get("storage");
    const user = getUser(c);
    const projectId = c.get("projectId");
    const parsed = saveFileSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      jsonError("Invalid file payload", 400);
    }
    const { path, content, baseEtag } = parsed.data;
    const filePath = sanitizeFilePath(path);

    // SS-18: protected system files (.metadata.json, .thumbnail.png) were guarded
    // on delete/rename but NOT on write, so a caller could overwrite their own
    // project's .metadata.json and flip published/slug. Reject writes
    // to any protected basename here, matching the delete/rename guards.
    if (PROTECTED_FILE_NAMES.has(filePath.split("/").pop() || "")) {
      jsonError("Cannot overwrite protected files", 403);
    }

    if (!isTextContentType(getContentType(filePath))) {
      jsonError("Binary files cannot be saved through the text editor endpoint.", 415);
    }

    // Editor saves always carry the ETag returned by the corresponding read.
    // Creation is a separate write-file-if-absent mutation; this route never
    // turns missing concurrency state into an unconditional overwrite.
    const result = await executeOwnerMutation(c.env, user.id, {
      type: "write-file",
      projectId,
      path: filePath,
      content,
      baseEtag
    }, serializeSiteStudioLoggingContext(getLoggingContext(c, user.operationalSubject)));
    if (!("etag" in result)) throw new Error("Unexpected mutation result");
    const etag = result.etag;
    if (etag === null) {
      const current = await storage.readFileWithEtag(user.id, projectId, filePath);
      return c.json({
        error: "file_conflict",
        message: "This file changed since you opened it. Reload to get the latest version.",
        etag: current?.etag ?? null
      }, 409);
    }

    return c.json({
      success: true,
      path: filePath,
      message: "File saved successfully",
      etag
    });
  });

  app.delete("/api/projects/:id/files", async (c) => {
    const user = getUser(c);
    const projectId = c.get("projectId");
    const filePath = sanitizeFilePath(c.req.query("path") || "");

    if (PROTECTED_FILE_NAMES.has(filePath.split("/").pop() || "")) {
      jsonError("Cannot delete protected files", 403);
    }

    await executeOwnerMutation(
      c.env,
      user.id,
      { type: "delete-file", projectId, path: filePath },
      serializeSiteStudioLoggingContext(getLoggingContext(c, user.operationalSubject)),
    );
    return c.json({ success: true, message: "File deleted successfully" });
  });

  app.put("/api/projects/:id/files/rename", async (c) => {
    const storage = c.get("storage");
    const user = getUser(c);
    const projectId = c.get("projectId");
    const parsed = renameFileSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      jsonError("Invalid rename payload", 400);
    }
    const { oldPath, newPath } = parsed.data;
    const currentPath = sanitizeFilePath(oldPath);
    const nextPath = sanitizeFilePath(newPath);

    if (PROTECTED_FILE_NAMES.has(currentPath.split("/").pop() || "")) {
      jsonError("Cannot rename protected files", 403);
    }

    if (!(await storage.fileExists(user.id, projectId, currentPath))) {
      jsonError("File not found", 404);
    }

    if (await storage.fileExists(user.id, projectId, nextPath)) {
      jsonError("A file with that name already exists", 409);
    }

    // SS-50: the fileExists preflights above are advisory only. The atomic
    // destination claim inside renameFile is authoritative — losing it means a
    // concurrent write or rename took the destination after the preflight.
    try {
      await executeOwnerMutation(c.env, user.id, {
        type: "rename-file",
        projectId,
        oldPath: currentPath,
        newPath: nextPath
      }, serializeSiteStudioLoggingContext(getLoggingContext(c, user.operationalSubject)));
    } catch (error) {
      if (error instanceof FileExistsError || (error instanceof Error && error.message.includes("already exists"))) {
        jsonError("A file with that name already exists", 409);
      }
      throw error;
    }
    return c.json({ success: true, oldPath: currentPath, newPath: nextPath, message: "File renamed successfully" });
  });

  app.post("/api/projects/:id/upload", async (c) => {
    const user = getUser(c);
    const projectId = c.get("projectId");

    // SS-29 pre-buffer guard (defense-in-depth layered on the per-file storage
    // caps below). Plain `formData()` buffers the multipart body before any
    // `file.size` check, so reject declared over-ceiling bodies early using
    // the declared Content-Length, BEFORE buffering. The ceiling is the largest
    // per-file cap plus a multipart-envelope margin so a valid 32MB file is not
    // false-rejected by framing overhead. A missing/unparseable Content-Length
    // uses boundedFormData, which streams into a capped buffer before parsing.
    const form = await readBoundedFormData(
      c.req.raw,
      MAX_UPLOAD_BODY_BYTES,
      `Upload too large. Max ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB`
    );
    const entry = form.get("file");

    if (!isFileUpload(entry)) {
      jsonError("No file uploaded", 400);
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
    const uploadPath = `${prefix}${sanitized}`;
    if (PROTECTED_FILE_NAMES.has(uploadPath.split("/").pop() || "")) {
      jsonError("Cannot upload protected files", 403);
    }
    validateUpload(entry, sanitized);

    const buffer = new Uint8Array(await entry.arrayBuffer());
    validateImageBytes(sanitized, buffer);

    const uploadPolicy = {
      maxProjectBytes: requiredPositiveInteger(
        c.env.SITE_STUDIO_MAX_PROJECT_BYTES,
        "SITE_STUDIO_MAX_PROJECT_BYTES"
      ),
      maxOwnerBytes: requiredPositiveInteger(
        c.env.SITE_STUDIO_MAX_OWNER_BYTES,
        "SITE_STUDIO_MAX_OWNER_BYTES"
      ),
      uploadsPerMinute: requiredPositiveInteger(
        c.env.SITE_STUDIO_UPLOADS_PER_MINUTE,
        "SITE_STUDIO_UPLOADS_PER_MINUTE"
      )
    };

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
    const uploadAdmissionId = crypto.randomUUID();
    let filename = "";
    let written = false;
    for (let counter = 0; counter < MAX_UPLOAD_ATTEMPTS; counter += 1) {
      const candidate = counter === 0 ? `${prefix}${sanitized}` : `${prefix}${base}_${counter}${ext}`;
      let result;
      try {
        result = await executeOwnerMutation(c.env, user.id, {
          type: "upload-if-absent",
          projectId,
          path: candidate,
          content: buffer,
          admissionId: uploadAdmissionId,
          ...uploadPolicy
        }, serializeSiteStudioLoggingContext(getLoggingContext(c, user.operationalSubject)));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Upload admission failed";
        if (message.includes("rate limit")) jsonError(message, 429);
        if (message.includes("storage quota")) jsonError(message, 413);
        throw error;
      }
      if (!("written" in result)) throw new Error("Unexpected mutation result");
      if (result.written) {
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
    const storage = c.get("storage");
    const user = getUser(c);
    const projectId = c.get("projectId");
    const filePath = sanitizeFilePath(c.req.query("path") || "");

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
        "Content-Disposition": contentDispositionAttachment(filePath.split("/").pop() || "download"),
        "Content-Type": getContentType(filePath),
        "Content-Length": String(buffer.byteLength)
      }
    });
  });

  return app;
}
