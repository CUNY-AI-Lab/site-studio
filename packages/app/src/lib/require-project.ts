import { createMiddleware } from "hono/factory";
import type { Env, User } from "../types";
import { R2ProjectStorage } from "../storage/r2";
import { jsonError } from "./http";
import { getUser } from "./session";
import {
  createSiteStudioBoundaryContext,
  getLoggingContext,
  type LoggingVariables,
} from "./logging";

export type RequireProjectVariables = LoggingVariables & {
  user: User;
  storage: R2ProjectStorage;
  projectId: string;
};

export function requireProject() {
  return createMiddleware<{ Bindings: Env; Variables: RequireProjectVariables }>(async (c, next) => {
    const user = getUser(c);
    const storage = new R2ProjectStorage(
      c.env.SITE_STUDIO_BUCKET,
      getLoggingContext(c, user.operationalSubject) ?? createSiteStudioBoundaryContext(c.env),
    );
    const projectId = c.req.param("id");
    if (!projectId) {
      jsonError("Project not found", 404);
    }

    // SS-33: routes under /api/projects/:id must agree on the same load-or-404
    // gate before any file/metadata writes. This prevents helpers like thumbnail
    // upload from fabricating project metadata through updateProjectMetadata's
    // legacy default-record path.
    if (!(await storage.projectExists(user.id, projectId))) {
      jsonError("Project not found", 404);
    }

    c.set("storage", storage);
    c.set("projectId", projectId);
    await next();
  });
}
