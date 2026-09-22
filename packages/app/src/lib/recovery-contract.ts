import { z } from "zod";

export const recoveryIdSchema = z.string().uuid();
export const manifestSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const anonymousOwnerSchema = z.string().regex(/^user_[a-f0-9]{32}$/);
const safeSegmentSchema = z.string().min(1).max(200).refine(
  (value) => value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\") && !value.includes("\0"),
  "Unsafe path segment",
);
const relativePathSchema = z.string().min(1).max(1024).refine((value) => {
  if (value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}, "Unsafe relative path");

export const legacyRecoveryManifestSchema = z.object({
  version: z.literal(1),
  recoveryId: recoveryIdSchema,
  source: z.object({
    account: z.string().regex(/^[a-f0-9]{32}$/),
    bucket: z.string().min(1).max(128),
    owner: anonymousOwnerSchema,
    prefix: z.string().min(1),
  }).strict(),
  projects: z.array(z.object({
    id: safeSegmentSchema,
    published: z.boolean(),
    slug: safeSegmentSchema.optional(),
  }).strict()).min(1).max(100),
  objects: z.array(z.object({
    projectId: safeSegmentSchema,
    path: relativePathSchema,
    size: z.number().int().nonnegative(),
    sha256: manifestSha256Schema,
    contentType: z.string().min(1).max(200).optional(),
  }).strict()).min(1).max(10_000),
}).strict().superRefine((manifest, context) => {
  if (manifest.source.prefix !== `projects/${manifest.source.owner}/`) {
    context.addIssue({ code: "custom", path: ["source", "prefix"], message: "Source prefix does not match owner" });
  }
  const projectIds = new Set<string>();
  for (const [index, project] of manifest.projects.entries()) {
    if (projectIds.has(project.id)) {
      context.addIssue({ code: "custom", path: ["projects", index, "id"], message: "Duplicate project" });
    }
    projectIds.add(project.id);
    if (project.published && !project.slug) {
      context.addIssue({ code: "custom", path: ["projects", index, "slug"], message: "Published project requires a slug" });
    }
    if (!project.published && project.slug !== undefined) {
      context.addIssue({ code: "custom", path: ["projects", index, "slug"], message: "Private project cannot declare a public slug" });
    }
  }
  const objectKeys = new Set<string>();
  const metadataProjects = new Set<string>();
  for (const [index, object] of manifest.objects.entries()) {
    if (!projectIds.has(object.projectId)) {
      context.addIssue({ code: "custom", path: ["objects", index, "projectId"], message: "Unknown project" });
    }
    const key = `${object.projectId}/${object.path}`;
    if (objectKeys.has(key)) {
      context.addIssue({ code: "custom", path: ["objects", index, "path"], message: "Duplicate object" });
    }
    objectKeys.add(key);
    if (object.path === ".metadata.json") metadataProjects.add(object.projectId);
  }
  for (const [index, project] of manifest.projects.entries()) {
    if (!metadataProjects.has(project.id)) {
      context.addIssue({ code: "custom", path: ["projects", index], message: "Project metadata is missing" });
    }
  }
});

export type LegacyRecoveryManifest = z.infer<typeof legacyRecoveryManifestSchema>;

export type RecoveryAdminFailureCode = "invalid" | "conflict" | "unavailable";
export type RecoveryCandidateResult =
  | { ok: true; subjects: string[]; nextCursor: string | null }
  | { ok: false; code: "invalid" | "unavailable" };
export type RecoveryRestoreResult =
  | {
      ok: true;
      recoveryId: string;
      state: "restored" | "already_restored";
      manifestSha256: string;
      projectCount: number;
      fileCount: number;
      byteCount: number;
      appUrl: string;
      restoredUrl: string | null;
    }
  | { ok: false; code: RecoveryAdminFailureCode };

export interface SiteStudioRecoveryAdminContract {
  listLegacyRecoveryCandidates(input: { cursor?: string }): Promise<RecoveryCandidateResult>;
  restoreLegacyProjects(input: {
    recoveryId: string;
    targetSubject: string;
    idempotencyKey: string;
  }): Promise<RecoveryRestoreResult>;
}

export type SiteStudioLegacyRecovery = SiteStudioRecoveryAdminContract;
