import { Hono } from "hono";
import { z } from "zod";
import type { Env, ProjectMetadata } from "../types";
import { isSnapshotSkipped } from "../types";
import { getUser } from "../lib/session";
import { ProjectExistsError, ProjectNotFoundError, R2ProjectStorage } from "../storage/r2";
import { createBlankIndexHtml, getTemplateFiles, isValidTemplate } from "../lib/templates";
import { binaryBody, jsonError } from "../lib/http";
import { sanitizeProjectId } from "../lib/path";
import type { RequireProjectVariables } from "../lib/require-project";
import { clearProjectAgentHistory, moveProjectAgentHistory } from "../lib/agent-porter";

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
  const app = new Hono<{ Bindings: Env; Variables: RequireProjectVariables }>();

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

    try {
      await storage.createProjectIfAbsent(user.id, projectId, name);
    } catch (error) {
      if (error instanceof ProjectExistsError) {
        jsonError("Project already exists", 409);
      }
      throw error;
    }

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
        await storage.renameProject(user.id, currentId, nextId);
      } catch (error) {
        if (error instanceof ProjectExistsError) {
          jsonError("Project already exists", 409);
        }
        throw error;
      }

      // SS-41: the project id is part of the Durable Object name. Move the
      // conversation after storage succeeds so a rename neither strands the
      // old history nor exposes it if the old name is later reused.
      try {
        await moveProjectAgentHistory(c.env, user.id, currentId, nextId);
      } catch (error) {
        console.warn("Failed to move agent history on rename", {
          userId: user.id,
          currentId,
          nextId,
          error
        });
      }
    }

    // SS-51: a concurrent DELETE can remove the project between the
    // requireProject preflight and this metadata write; updateProjectMetadata
    // refuses to fabricate a record for an absent project, so surface the same
    // 404 the preflight would have given.
    let updated;
    try {
      updated = await storage.updateProjectMetadata(user.id, nextId, { name });
    } catch (error) {
      if (error instanceof ProjectNotFoundError) {
        jsonError("Project not found", 404);
      }
      throw error;
    }
    return c.json(toProjectSummary(nextId, updated));
  });

  app.delete("/api/projects/:id", async (c) => {
    const storage = c.get("storage");
    const user = getUser(c);
    const projectId = c.get("projectId");

    await storage.deleteProject(user.id, projectId);

    // SS-41: R2 deletion does not remove the project-named agent Durable
    // Object. Clear its persisted messages best-effort so recreating the same
    // normalized project id cannot resurface the deleted conversation.
    try {
      await clearProjectAgentHistory(c.env, user.id, projectId);
    } catch (error) {
      console.warn("Failed to clear agent history on delete", {
        userId: user.id,
        projectId,
        error
      });
    }
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
    const storage = c.get("storage");
    const user = getUser(c);
    const projectId = c.get("projectId");

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
    const storage = c.get("storage");
    const user = getUser(c);
    const projectId = c.get("projectId");
    const snapshotId = c.req.param("snapshotId");

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
