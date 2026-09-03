import { Hono } from "hono";
import { z } from "zod";
import type { Env, ProjectMetadata } from "../types";
import { isSnapshotSkipped } from "../types";
import { getUser } from "../lib/session";
import {
  ProjectExistsError,
  ProjectNotFoundError,
  R2ProjectStorage,
  SnapshotNotFoundError,
} from "../storage/r2";
import { createBlankIndexHtml, getTemplateFiles, isValidTemplate } from "../lib/templates";
import { binaryBody, jsonError } from "../lib/http";
import { sanitizeProjectId } from "../lib/path";
import type { RequireProjectVariables } from "../lib/require-project";
import {
  getLoggingContext,
  serializeSiteStudioLoggingContext,
  type LoggingVariables,
} from "../lib/logging";
import { executeOwnerMutation } from "../lib/owner-mutations";
import { getUserHandle } from "../lib/handles";
import { getPublishedBaseUrl, publishedProjectUrl } from "../lib/published-url";

const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  template: z.string().optional()
});

const renameProjectSchema = z.object({
  name: z.string().min(1).max(100)
});

const createSnapshotSchema = z.object({
  label: z.string().min(1).max(160).optional()
});

function toProjectSummary(
  id: string,
  metadata: ProjectMetadata | null,
  publishedBaseUrl: string,
  handle: string | null,
) {
  const publishedUrl = metadata?.published && metadata.slug && handle
    ? publishedProjectUrl(publishedBaseUrl, handle, metadata.slug)
    : undefined;
  return {
    id,
    name: metadata?.name || id,
    published: metadata?.published || false,
    publishedUrl,
    thumbnailUrl: metadata?.thumbnailUrl
  };
}

function isProjectNotFound(error: Error): boolean {
  // Native DO RPC preserves custom errors as Error with a name-prefixed message.
  return error instanceof ProjectNotFoundError
    || error.message === "ProjectNotFoundError: Project not found";
}

function isSnapshotNotFound(error: Error): boolean {
  return error instanceof SnapshotNotFoundError
    || error.message === "SnapshotNotFoundError: Snapshot not found";
}

export function createProjectRouter() {
  const app = new Hono<{ Bindings: Env; Variables: RequireProjectVariables & LoggingVariables }>();

  app.get("/api/projects", async (c) => {
    const user = getUser(c);
    const logging = getLoggingContext(c, user.operationalSubject);
    const storage = new R2ProjectStorage(c.env.SITE_STUDIO_BUCKET, logging);
    const projectIds = await storage.listProjects(user.id);
    const publishedBaseUrl = getPublishedBaseUrl(c.req.url, c.env.PUBLISHED_BASE_URL);
    const handle = await getUserHandle(c.env.SITE_STUDIO_BUCKET, user.id);
    const projects = await Promise.all(
      projectIds.map(async (projectId) => toProjectSummary(
        projectId,
        await storage.getProjectMetadata(user.id, projectId),
        publishedBaseUrl,
        handle,
      ))
    );

    return c.json({ projects });
  });

  app.post("/api/projects", async (c) => {
    const user = getUser(c);
    const logging = getLoggingContext(c, user.operationalSubject);
    const storage = new R2ProjectStorage(c.env.SITE_STUDIO_BUCKET, logging);
    const parsed = createProjectSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      jsonError("Invalid project payload", 400);
    }
    const { name, template } = parsed.data;
    const projectId = sanitizeProjectId(name);

    if (template && template !== "blank" && !isValidTemplate(template)) {
      jsonError(`Unknown template: ${template}`, 400);
    }

    if (await storage.projectExists(user.id, projectId)) {
      jsonError("Project already exists", 409);
    }

    const templateFiles = template ? getTemplateFiles(template) : null;
    const files = templateFiles ?? { "index.html": createBlankIndexHtml(name) };
    try {
      await executeOwnerMutation(c.env, user.id, {
        type: "create-project",
        projectId,
        name,
        files
      }, serializeSiteStudioLoggingContext(logging));
    } catch (error) {
      if (error instanceof ProjectExistsError || (error instanceof Error && error.message.includes("already exists"))) {
        jsonError("Project already exists", 409);
      }
      throw error;
    }

    return c.json({
      id: projectId,
      name,
      path: projectId
    });
  });

  app.patch("/api/projects/:id", async (c) => {
    const storage = c.get("storage");
    const user = getUser(c);
    const currentId = c.get("projectId");
    const parsed = renameProjectSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      jsonError("Invalid project payload", 400);
    }
    const { name } = parsed.data;
    const nextId = sanitizeProjectId(name);

    if (currentId !== nextId && (await storage.projectExists(user.id, nextId))) {
      jsonError("Project already exists", 409);
    }

    if (currentId !== nextId) {
      try {
        await executeOwnerMutation(c.env, user.id, {
          type: "rename-project",
          projectId: currentId,
          nextProjectId: nextId,
          name
        }, serializeSiteStudioLoggingContext(getLoggingContext(c, user.operationalSubject)));
      } catch (error) {
        if (error instanceof ProjectExistsError || (error instanceof Error && error.message.includes("already exists"))) {
          jsonError("Project already exists", 409);
        }
        if (error instanceof Error && isProjectNotFound(error)) {
          jsonError("Project not found", 404);
        }
        throw error;
      }

    }

    // SS-51: a concurrent DELETE can remove the project between the
    // requireProject preflight and this metadata write; updateProjectMetadata
    // refuses to fabricate a record for an absent project, so surface the same
    // 404 the preflight would have given.
    let updated;
    try {
      if (currentId === nextId) {
        await executeOwnerMutation(c.env, user.id, {
          type: "rename-project-display",
          projectId: nextId,
          name
        }, serializeSiteStudioLoggingContext(getLoggingContext(c, user.operationalSubject)));
      }
      updated = await storage.getProjectMetadata(user.id, nextId);
    } catch (error) {
      if (error instanceof Error && isProjectNotFound(error)) {
        jsonError("Project not found", 404);
      }
      throw error;
    }
    return c.json(toProjectSummary(
      nextId,
      updated,
      getPublishedBaseUrl(c.req.url, c.env.PUBLISHED_BASE_URL),
      await getUserHandle(c.env.SITE_STUDIO_BUCKET, user.id),
    ));
  });

  app.delete("/api/projects/:id", async (c) => {
    const user = getUser(c);
    const projectId = c.get("projectId");

    await executeOwnerMutation(
      c.env,
      user.id,
      { type: "delete-project", projectId },
      serializeSiteStudioLoggingContext(getLoggingContext(c, user.operationalSubject)),
    );

    return c.json({ success: true, message: "Project deleted successfully" });
  });

  app.get("/api/projects/:id/export", async (c) => {
    const storage = c.get("storage");
    const user = getUser(c);
    const projectId = c.get("projectId");

    const archive = await storage.exportProjectZip(user.id, projectId);
    return new Response(binaryBody(archive), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${projectId}.zip"`,
        "Content-Length": String(archive.byteLength)
      }
    });
  });

  app.get("/api/projects/:id/snapshots", async (c) => {
    const storage = c.get("storage");
    const user = getUser(c);
    const projectId = c.get("projectId");

    const snapshots = await storage.listSnapshots(user.id, projectId);
    return c.json({ snapshots });
  });

  app.post("/api/projects/:id/snapshots", async (c) => {
    const user = getUser(c);
    const projectId = c.get("projectId");

    const parsed = createSnapshotSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      jsonError("Invalid snapshot payload", 400);
    }

    let result;
    try {
      result = await executeOwnerMutation(c.env, user.id, {
        type: "create-snapshot",
        projectId,
        trigger: "manual",
        label: parsed.data.label
      }, serializeSiteStudioLoggingContext(getLoggingContext(c, user.operationalSubject)));
    } catch (error) {
      if (error instanceof Error && isProjectNotFound(error)) {
        jsonError("Project not found", 404);
      }
      throw error;
    }
    if (!("snapshot" in result)) throw new Error("Unexpected mutation result");
    const snapshot = result.snapshot;

    // SS-28: a manual snapshot is one the user EXPLICITLY asked for, so an
    // over-cap project should be told the snapshot was too large (413) rather
    // than silently 201-ing with no restore point. (Agent-triggered snapshots
    // skip non-fatally so the mutation still lands — see ensureSnapshot — but
    // the manual endpoint has a user waiting on the result and clearer UX is to
    // surface the failure.)
    if (isSnapshotSkipped(snapshot)) {
      jsonError(
        `Project is too large to snapshot (${snapshot.totalBytes} bytes exceeds the ${snapshot.limitBytes}-byte limit).`,
        413
      );
    }

    return c.json({ snapshot }, 201);
  });

  app.post("/api/projects/:id/snapshots/:snapshotId/restore", async (c) => {
    const storage = c.get("storage");
    const user = getUser(c);
    const projectId = c.get("projectId");
    const snapshotId = c.req.param("snapshotId");

    const targetSnapshot = await storage.getSnapshot(user.id, projectId, snapshotId);
    if (!targetSnapshot) {
      jsonError("Snapshot not found", 404);
    }

    let result;
    try {
      result = await executeOwnerMutation(c.env, user.id, {
        type: "restore-snapshot",
        projectId,
        snapshotId
      }, serializeSiteStudioLoggingContext(getLoggingContext(c, user.operationalSubject)));
    } catch (error) {
      if (error instanceof Error && isProjectNotFound(error)) {
        jsonError("Project not found", 404);
      }
      if (error instanceof Error && isSnapshotNotFound(error)) {
        jsonError("Snapshot not found", 404);
      }
      throw error;
    }
    if (!("restoredSnapshot" in result)) throw new Error("Unexpected mutation result");

    return c.json({
      success: true,
      restoredSnapshot: result.restoredSnapshot,
      restorePoint: result.restorePoint,
      restorePointSkipped: false
    });
  });

  return app;
}
