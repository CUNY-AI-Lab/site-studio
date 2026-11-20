import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import type { Env } from "./types";
import {
  type OperatorUnpublishResult,
  type RecoveryCandidateResult,
  type RecoveryRestoreResult,
  operatorUnpublishInputSchema,
  recoveryIdSchema,
} from "./lib/recovery-contract";
import {
  LegacyRecoveryError,
  assertNoSourceHandleExposure,
  assertSameRecovery,
  createPendingRecovery,
  loadRecoveryManifest,
  readRecoveryAuthorization,
  validateStagedRecovery,
} from "./lib/legacy-recovery";
import { normalizePublishedBaseUrl } from "./lib/published-url";
import { resolveHandleOwner } from "./lib/handles";
import { executeOwnerMutation } from "./lib/owner-mutations";
import { R2ProjectStorage } from "./storage/r2";

const restoreInputSchema = z.object({
  recoveryId: recoveryIdSchema,
  targetSubject: z.string().regex(/^cail-[a-f0-9]{32}$/),
  idempotencyKey: z.string().uuid(),
}).strict();
const candidateInputSchema = z.object({ cursor: z.string().min(1).max(512).optional() }).strict();
const CANDIDATE_PAGE_SIZE = 32;
const SITE_OWNER_PATTERN = /^(?:cail-|user_)[a-f0-9]{32}$/;
/** Bounds unpublish-then-recheck rounds when the owner republishes concurrently. */
const MAX_UNPUBLISH_ROUNDS = 4;

async function projectsWithSlug(
  storage: R2ProjectStorage,
  ownerId: string,
  slug: string,
): Promise<string[]> {
  const matches: string[] = [];
  for (const projectId of await storage.listProjects(ownerId)) {
    const metadata = await storage.getProjectMetadata(ownerId, projectId);
    if (metadata?.slug === slug) matches.push(projectId);
  }
  return matches;
}

export class SiteStudioRecoveryAdmin extends WorkerEntrypoint<Env> {
  async listLegacyRecoveryCandidates(input: { cursor?: string }): Promise<RecoveryCandidateResult> {
    const parsed = candidateInputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, code: "invalid" };
    try {
      const page = await this.env.SITE_STUDIO_BUCKET.list({
        prefix: "imports/",
        cursor: parsed.data.cursor,
        limit: CANDIDATE_PAGE_SIZE,
      });
      const subjects: string[] = [];
      const seen = new Set<string>();
      for (const object of page.objects) {
        const encoded = object.key.slice("imports/".length);
        let subject: string;
        try {
          subject = decodeURIComponent(encoded);
        } catch {
          return { ok: false, code: "unavailable" };
        }
        if (
          !/^cail-[a-f0-9]{32}$/.test(subject) ||
          encodeURIComponent(subject) !== encoded ||
          seen.has(subject)
        ) {
          return { ok: false, code: "unavailable" };
        }
        seen.add(subject);
        subjects.push(subject);
      }
      return {
        ok: true,
        subjects,
        nextCursor: page.truncated ? page.cursor ?? null : null,
      };
    } catch {
      return { ok: false, code: "unavailable" };
    }
  }

  async restoreLegacyProjects(input: {
    recoveryId: string;
    targetSubject: string;
    idempotencyKey: string;
  }): Promise<RecoveryRestoreResult> {
    const parsed = restoreInputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, code: "invalid" };
    const { recoveryId, targetSubject, idempotencyKey } = parsed.data;

    try {
      const { manifest, sha256: manifestSha256 } = await loadRecoveryManifest(
        this.env.SITE_STUDIO_BUCKET,
        recoveryId,
      );
      const projectCount = manifest.projects.length;
      const fileCount = manifest.objects.length;
      const byteCount = manifest.objects.reduce((total, object) => total + object.size, 0);
      let stored = await readRecoveryAuthorization(this.env.SITE_STUDIO_BUCKET, recoveryId);
      let wasComplete = false;

      if (!stored) {
        await validateStagedRecovery(this.env.SITE_STUDIO_BUCKET, manifest);
        await assertNoSourceHandleExposure(this.env.SITE_STUDIO_BUCKET, manifest.source.owner);

        const claim = await this.env.MIGRATION_COORDINATOR
          .get(this.env.MIGRATION_COORDINATOR.idFromName(manifest.source.owner))
          .claim(manifest.source.owner, targetSubject);
        if (!claim.granted) throw new LegacyRecoveryError("conflict");

        const pending = await createPendingRecovery(this.env.SITE_STUDIO_BUCKET, {
          version: 1,
          recoveryId,
          sourceOwner: manifest.source.owner,
          manifestSha256,
          targetSubject,
          idempotencyKey,
          status: "pending",
          projectCount,
          fileCount,
          byteCount,
          startedAt: new Date().toISOString(),
        });
        assertSameRecovery(pending, { targetSubject, idempotencyKey }, manifestSha256, manifest.source.owner);
        stored = await readRecoveryAuthorization(this.env.SITE_STUDIO_BUCKET, recoveryId);
      } else {
        assertSameRecovery(stored.value, { targetSubject, idempotencyKey }, manifestSha256, manifest.source.owner);
        wasComplete = stored.value.status === "complete";
      }

      if (!stored) throw new LegacyRecoveryError("unavailable");
      if (stored.value.status !== "complete") {
        const namespace = this.env.MUTATION_COORDINATOR;
        if (!namespace) throw new LegacyRecoveryError("unavailable");
        await namespace
          .get(namespace.idFromName(`owner:${targetSubject}`))
          .restoreLegacyProjects(recoveryId, manifest.source.owner, targetSubject);
      }

      const baseUrl = normalizePublishedBaseUrl(this.env.PUBLISHED_BASE_URL ?? "");
      const published = manifest.projects.filter((project) => project.published && project.slug);
      const restoredUrl = published.length === 1 && baseUrl
        ? `${baseUrl}/sites/${manifest.source.owner}/${published[0].slug}/`
        : null;
      return {
        ok: true,
        recoveryId,
        state: wasComplete ? "already_restored" : "restored",
        manifestSha256,
        projectCount,
        fileCount,
        byteCount,
        appUrl: baseUrl ? `${baseUrl}/` : "/",
        restoredUrl,
      };
    } catch (error) {
      if (error instanceof LegacyRecoveryError) return { ok: false, code: error.code };
      return { ok: false, code: "unavailable" };
    }
  }

  /**
   * Take one public `/u/:handle/:slug/` address down for an operator. Each
   * project is unpublished through the owner's ordinary mutation queue, exactly
   * as the owner's unpublish route does, and success is reported only after a
   * fresh read finds nothing published at that address. The owner can publish
   * again; this is not a ban.
   */
  async unpublishPublishedSite(input: { handle: string; slug: string }): Promise<OperatorUnpublishResult> {
    const parsed = operatorUnpublishInputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, code: "invalid" };
    const { handle, slug } = parsed.data;

    try {
      const ownerId = await resolveHandleOwner(this.env.SITE_STUDIO_BUCKET, handle);
      if (!ownerId) return { ok: false, code: "not_found" };
      if (!SITE_OWNER_PATTERN.test(ownerId)) return { ok: false, code: "unavailable" };

      const storage = new R2ProjectStorage(this.env.SITE_STUDIO_BUCKET);
      const unpublishedAt = new Date().toISOString();
      const unpublished: string[] = [];
      for (let round = 0; ; round++) {
        const published = await storage.findPublishedProjectBySlug(ownerId, slug);
        if (!published) break;
        if (round === MAX_UNPUBLISH_ROUNDS) return { ok: false, code: "unavailable" };
        try {
          await executeOwnerMutation(this.env, ownerId, {
            type: "unpublish-project",
            projectId: published.projectId,
            unpublishedAt,
          });
        } catch (error) {
          // A concurrent rename or delete removed this id; read the address again.
          if (error instanceof Error && error.message.includes("Project not found")) continue;
          throw error;
        }
        if (!unpublished.includes(published.projectId)) unpublished.push(published.projectId);
      }

      if (unpublished.length > 0) {
        return { ok: true, state: "unpublished", ownerId, projectIds: unpublished.sort() };
      }
      const existing = await projectsWithSlug(storage, ownerId, slug);
      return existing.length > 0
        ? { ok: true, state: "already_unpublished", ownerId, projectIds: existing }
        : { ok: false, code: "not_found" };
    } catch {
      return { ok: false, code: "unavailable" };
    }
  }
}
