import { Hono } from "hono";
import { z } from "zod";
import type { Env, ProjectMetadata } from "../types";
import { isSnapshotSkipped } from "../types";
import { getUser } from "../lib/session";
import { R2ProjectStorage } from "../storage/r2";
import { createBlankIndexHtml, getTemplateFiles, isValidTemplate } from "../lib/templates";
import { binaryBody, jsonError } from "../lib/http";
import { sanitizeProjectId } from "../lib/path";

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

function toProjectSummary(id: string, metadata: ProjectMetadata | null) {
  return {
    id,
    name: metadata?.name || id,
    published: metadata?.published || false,
    publishedUrl: metadata?.publishedUrl,
    thumbnailUrl: metadata?.thumbnailUrl
  };
}

export function createProjectRouter() {
  const app = new Hono<{ Bindings: Env; Variables: { user: { id: string } } }>();

  app.get("/api/projects", async (c) => {
    const storage = new R2ProjectStorage(c.env.SITE_STUDIO_BUCKET);
    const user = getUser(c);
    const projectIds = await storage.listProjects(user.id);
    const projects = await Promise.all(
      projectIds.map(async (projectId) => toProjectSummary(projectId, await storage.getProjectMetadata(user.id, projectId)))
    );

    return c.json({ projects });
  });

  app.post("/api/projects", async (c) => {
    const user = getUser(c);
    const storage = new R2ProjectStorage(c.env.SITE_STUDIO_BUCKET);
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

    await storage.createProject(user.id, projectId, name);

    const templateFiles = template ? getTemplateFiles(template) : null;
    if (templateFiles) {
      for (const [filePath, content] of Object.entries(templateFiles)) {
        await storage.writeFile(user.id, projectId, filePath, content);
      }
    } else {
      await storage.writeFile(user.id, projectId, "index.html", createBlankIndexHtml(name));
    }

    return c.json({
      id: projectId,
      name,
      path: projectId
    });
  });

  app.patch("/api/projects/:id", async (c) => {
    const storage = new R2ProjectStorage(c.env.SITE_STUDIO_BUCKET);
    const user = getUser(c);
    const currentId = c.req.param("id");
    const parsed = renameProjectSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      jsonError("Invalid project payload", 400);
    }
    const { name } = parsed.data;
    const nextId = sanitizeProjectId(name);

    if (!(await storage.projectExists(user.id, currentId))) {
      jsonError("Project not found", 404);
    }

    if (currentId !== nextId && (await storage.projectExists(user.id, nextId))) {
      jsonError("Project already exists", 409);
    }

    if (currentId !== nextId) {
      await storage.renameProject(user.id, currentId, nextId);
    }

    const updated = await storage.updateProjectMetadata(user.id, nextId, { name });
    return c.json(toProjectSummary(nextId, updated));
  });

  app.delete("/api/projects/:id", async (c) => {
    const storage = new R2ProjectStorage(c.env.SITE_STUDIO_BUCKET);
    const user = getUser(c);
    const projectId = c.req.param("id");

    if (!(await storage.projectExists(user.id, projectId))) {
      jsonError("Project not found", 404);
    }

    await storage.deleteProject(user.id, projectId);
    return c.json({ success: true, message: "Project deleted successfully" });
  });

  app.get("/api/projects/:id/export", async (c) => {
    const storage = new R2ProjectStorage(c.env.SITE_STUDIO_BUCKET);
    const user = getUser(c);
    const projectId = c.req.param("id");

    if (!(await storage.projectExists(user.id, projectId))) {
      jsonError("Project not found", 404);
    }

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
    const storage = new R2ProjectStorage(c.env.SITE_STUDIO_BUCKET);
    const user = getUser(c);
    const projectId = c.req.param("id");

    if (!(await storage.projectExists(user.id, projectId))) {
      jsonError("Project not found", 404);
    }

    const snapshots = await storage.listSnapshots(user.id, projectId);
    return c.json({ snapshots });
  });

  app.post("/api/projects/:id/snapshots", async (c) => {
    const storage = new R2ProjectStorage(c.env.SITE_STUDIO_BUCKET);
    const user = getUser(c);
    const projectId = c.req.param("id");

    if (!(await storage.projectExists(user.id, projectId))) {
      jsonError("Project not found", 404);
    }

    const parsed = createSnapshotSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      jsonError("Invalid snapshot payload", 400);
    }

    const snapshot = await storage.createSnapshot(user.id, projectId, {
      trigger: "manual",
      label: parsed.data.label
    });

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
    const storage = new R2ProjectStorage(c.env.SITE_STUDIO_BUCKET);
    const user = getUser(c);
    const projectId = c.req.param("id");
    const snapshotId = c.req.param("snapshotId");

    if (!(await storage.projectExists(user.id, projectId))) {
      jsonError("Project not found", 404);
    }

    const targetSnapshot = await storage.getSnapshot(user.id, projectId, snapshotId);
    if (!targetSnapshot) {
      jsonError("Snapshot not found", 404);
    }

    // SS-28: the "before restore" safety snapshot may be skipped if the current
    // project is over the snapshot cap. The restore itself IS the recovery the
    // user asked for, so a skipped safety snapshot must not block it — proceed
    // and report the skip in the response instead of returning a fake snapshot.
    const restorePointResult = await storage.createSnapshot(user.id, projectId, {
      trigger: "restore",
      label: `Before restore to ${targetSnapshot.label || targetSnapshot.id}`,
      restoredFromSnapshotId: snapshotId
    });
    const restorePoint = isSnapshotSkipped(restorePointResult) ? null : restorePointResult;
    const restorePointSkipped = isSnapshotSkipped(restorePointResult);

    const restoredSnapshot = await storage.restoreSnapshot(user.id, projectId, snapshotId);

    return c.json({
      success: true,
      restoredSnapshot,
      restorePoint,
      restorePointSkipped
    });
  });

  return app;
}
