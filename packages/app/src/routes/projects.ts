import { Hono } from "hono";
import { z } from "zod";
import type { Env, ProjectMetadata } from "../types";
import { getUser } from "../lib/session";
import { R2ProjectStorage } from "../storage/r2";
import { createBlankIndexHtml } from "../lib/templates";
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
    const { name, template } = createProjectSchema.parse(await c.req.json());
    const projectId = sanitizeProjectId(name);

    if (template && template !== "blank") {
      jsonError("Only the blank template is available in the new app right now", 400);
    }

    if (await storage.projectExists(user.id, projectId)) {
      jsonError("Project already exists", 409);
    }

    await storage.createProject(user.id, projectId, name);
    await storage.writeFile(user.id, projectId, "index.html", createBlankIndexHtml(name));

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
    const { name } = renameProjectSchema.parse(await c.req.json());
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

    const restorePoint = await storage.createSnapshot(user.id, projectId, {
      trigger: "restore",
      label: `Before restore to ${targetSnapshot.label || targetSnapshot.id}`,
      restoredFromSnapshotId: snapshotId
    });

    const restoredSnapshot = await storage.restoreSnapshot(user.id, projectId, snapshotId);

    return c.json({
      success: true,
      restoredSnapshot,
      restorePoint
    });
  });

  return app;
}
