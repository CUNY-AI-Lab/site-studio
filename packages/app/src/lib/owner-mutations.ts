import type { Env, ProjectSnapshot, SnapshotResult } from "../types";
import { isSnapshotSkipped } from "../types";
import {
  FileExistsError,
  ProjectExistsError,
  ProjectNotFoundError,
  R2ProjectStorage,
  SlugReservationLostError
} from "../storage/r2";

export type OwnerMutation =
  | { type: "create-project"; projectId: string; name: string; files: Record<string, string> }
  | { type: "rename-project"; projectId: string; nextProjectId: string; name: string }
  | { type: "rename-project-display"; projectId: string; name: string }
  | { type: "delete-project"; projectId: string }
  | { type: "publish-project"; projectId: string; desiredSlug: string; publishedBaseUrl: string; handle: string }
  | { type: "unpublish-project"; projectId: string; unpublishedAt: string }
  | { type: "write-file"; projectId: string; path: string; content: string; baseEtag?: string }
  | { type: "write-file-if-absent"; projectId: string; path: string; content: string }
  | { type: "delete-file"; projectId: string; path: string }
  | { type: "rename-file"; projectId: string; oldPath: string; newPath: string }
  | ({ type: "upload-if-absent"; projectId: string; path: string; content: Uint8Array } & UploadPolicy)
  | ({ type: "write-thumbnail"; projectId: string; content: Uint8Array } & UploadPolicy)
  | { type: "create-snapshot"; projectId: string; label?: string; trigger: "agent" | "manual" }
  | { type: "restore-snapshot"; projectId: string; snapshotId: string }
  | { type: "replace-files"; projectId: string; files: Record<string, string>; label?: string };

export type OwnerMutationResult =
  | { etag: string | null }
  | { written: boolean }
  | { snapshot: SnapshotResult }
  | { restoredSnapshot: ProjectSnapshot; restorePoint: ProjectSnapshot }
  | { published: { slug: string; url: string } }
  | { ok: true };

type Journal =
  | { type: "create"; projectId: string }
  | { type: "delete"; projectId: string }
  | { type: "rename-project"; projectId: string; nextProjectId: string; name: string; slug?: string; stage: "preparing" | "committing" }
  | { type: "rename-file"; projectId: string; oldPath: string; newPath: string; stage: "preparing" | "committing" }
  | { type: "restore" | "replace-files"; projectId: string; restorePointId: string };

export interface MutationJournalStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

const JOURNAL_KEY = "owner-mutation";
const UPLOAD_ADMISSIONS_KEY = "upload-admissions";

type UploadPolicy = {
  maxProjectBytes: number;
  maxOwnerBytes: number;
  uploadsPerMinute: number;
  now?: number;
};

export class OwnerMutationService {
  private readonly storage: R2ProjectStorage;

  constructor(private readonly bucket: R2Bucket, private readonly journalStore: MutationJournalStore) {
    this.storage = new R2ProjectStorage(bucket);
  }

  private async prefixBytes(prefix: string): Promise<number> {
    let total = 0;
    let cursor: string | undefined;
    do {
      const listed = await this.bucket.list({ prefix, cursor });
      total += listed.objects.reduce((sum, object) => sum + object.size, 0);
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    return total;
  }

  private async putJournal(journal: Journal): Promise<void> {
    await this.journalStore.put(JOURNAL_KEY, journal);
  }

  private async clearJournal(): Promise<void> {
    await this.journalStore.delete(JOURNAL_KEY);
  }

  private async checkUploadAdmission(
    ownerId: string,
    projectId: string,
    additionalBytes: number,
    policy: UploadPolicy
  ): Promise<{ recent: number[]; now: number }> {
    const now = policy.now ?? Date.now();
    const prior = await this.journalStore.get<number[]>(UPLOAD_ADMISSIONS_KEY) ?? [];
    const recent = prior.filter((timestamp) => timestamp > now - 60_000);
    if (recent.length >= policy.uploadsPerMinute) {
      throw new Error("Upload rate limit exceeded. Try again in a minute.");
    }
    const projectBytes = await this.prefixBytes(`projects/${ownerId}/${projectId}/`);
    if (projectBytes + additionalBytes > policy.maxProjectBytes) {
      throw new Error("Project storage quota exceeded.");
    }
    const ownerBytes =
      await this.prefixBytes(`projects/${ownerId}/`) +
      await this.prefixBytes(`snapshots/${ownerId}/`) +
      await this.prefixBytes(`uploads/${ownerId}/`);
    if (ownerBytes + additionalBytes > policy.maxOwnerBytes) {
      throw new Error("Owner storage quota exceeded.");
    }
    return { recent, now };
  }

  private async recordUploadAdmission(recent: number[], now: number): Promise<void> {
    await this.journalStore.put(UPLOAD_ADMISSIONS_KEY, [...recent, now]);
  }

  private async requireProject(ownerId: string, projectId: string): Promise<void> {
    if (!(await this.storage.projectExists(ownerId, projectId))) {
      throw new ProjectNotFoundError(projectId);
    }
  }

  async recover(ownerId: string): Promise<void> {
    const journal = await this.journalStore.get<Journal>(JOURNAL_KEY);
    if (!journal) return;

    switch (journal.type) {
      case "create":
      case "delete":
        await this.storage.deleteProject(ownerId, journal.projectId);
        break;
      case "rename-project":
        if (journal.stage === "preparing") {
          if (journal.slug) {
            await this.storage.transferPublishedSlugReservation(
              ownerId,
              journal.slug,
              journal.nextProjectId,
              journal.projectId
            );
          }
          await this.storage.deleteProject(ownerId, journal.nextProjectId);
        } else {
          await this.storage.deleteProject(ownerId, journal.projectId);
          await this.storage.updateProjectMetadata(ownerId, journal.nextProjectId, { name: journal.name });
        }
        break;
      case "rename-file":
        if (journal.stage === "preparing") {
          if (await this.storage.fileExists(ownerId, journal.projectId, journal.oldPath)) {
            await this.storage.deleteFile(ownerId, journal.projectId, journal.newPath);
          }
        } else {
          await this.storage.deleteFile(ownerId, journal.projectId, journal.oldPath);
        }
        break;
      case "restore":
      case "replace-files":
        await this.storage.restoreSnapshot(ownerId, journal.projectId, journal.restorePointId);
        break;
    }
    await this.clearJournal();
  }

  async execute(ownerId: string, operation: OwnerMutation): Promise<OwnerMutationResult> {
    await this.recover(ownerId);

    switch (operation.type) {
      case "create-project": {
        try {
          await this.storage.createProjectIfAbsent(ownerId, operation.projectId, operation.name);
          // Record compensation only after the conditional metadata claim proves
          // this operation owns the new namespace. A crash before this write may
          // leave an empty visible project, but recovery can never delete a
          // destination created by another writer during the ambiguous window.
          await this.putJournal({ type: "create", projectId: operation.projectId });
          for (const [path, content] of Object.entries(operation.files)) {
            await this.storage.writeFile(ownerId, operation.projectId, path, content);
          }
          await this.clearJournal();
          return { ok: true };
        } catch (error) {
          if (error instanceof ProjectExistsError) {
            await this.clearJournal();
            throw error;
          }
          await this.recover(ownerId).catch(() => undefined);
          throw error;
        }
      }
      case "rename-project": {
        const sourceMetadata = await this.storage.getProjectMetadata(ownerId, operation.projectId);
        if (!sourceMetadata) throw new ProjectNotFoundError(operation.projectId);
        const journal: Extract<Journal, { type: "rename-project" }> = {
          type: "rename-project",
          projectId: operation.projectId,
          nextProjectId: operation.nextProjectId,
          name: operation.name,
          ...(sourceMetadata.published && sourceMetadata.slug ? { slug: sourceMetadata.slug } : {}),
          stage: "preparing"
        };
        try {
          await this.storage.renameProject(ownerId, operation.projectId, operation.nextProjectId, {
            afterTargetClaim: async () => this.putJournal(journal),
            beforeSourceDelete: async () => {
              if (journal.slug) {
                await this.storage.transferPublishedSlugReservation(
                  ownerId,
                  journal.slug,
                  operation.projectId,
                  operation.nextProjectId
                );
              }
              await this.putJournal({ ...journal, stage: "committing" });
            }
          });
        } catch (error) {
          if (error instanceof ProjectExistsError) {
            await this.clearJournal();
          } else {
            await this.recover(ownerId).catch(() => undefined);
          }
          throw error;
        }
        await this.storage.updateProjectMetadata(ownerId, operation.nextProjectId, { name: operation.name });
        await this.clearJournal();
        return { ok: true };
      }
      case "delete-project":
        await this.putJournal({ type: "delete", projectId: operation.projectId });
        await this.storage.deleteProject(ownerId, operation.projectId);
        await this.clearJournal();
        return { ok: true };
      case "rename-project-display":
        await this.requireProject(ownerId, operation.projectId);
        await this.storage.updateProjectMetadata(ownerId, operation.projectId, { name: operation.name });
        return { ok: true };
      case "publish-project": {
        await this.requireProject(ownerId, operation.projectId);
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const claim = await this.storage.resolvePublishedSlug(
            ownerId,
            operation.desiredSlug,
            operation.projectId
          );
          const url = `${operation.publishedBaseUrl.replace(/\/+$/, "")}/u/${operation.handle}/${claim.slug}/`;
          try {
            await this.storage.updateProjectMetadataForSlugClaim(ownerId, operation.projectId, claim, {
              published: true,
              publishedUrl: url,
              publishedAt: new Date().toISOString(),
              slug: claim.slug
            });
            return { published: { slug: claim.slug, url } };
          } catch (error) {
            if (!(error instanceof SlugReservationLostError) || attempt === 4) throw error;
          }
        }
        throw new Error("Could not settle published slug");
      }
      case "unpublish-project":
        await this.requireProject(ownerId, operation.projectId);
        await this.storage.updateProjectMetadata(ownerId, operation.projectId, {
          published: false,
          publishedUrl: undefined,
          unpublishedAt: operation.unpublishedAt
        });
        return { ok: true };
      case "write-file": {
        await this.requireProject(ownerId, operation.projectId);
        const etag = operation.baseEtag === undefined
          ? await this.storage.writeFile(ownerId, operation.projectId, operation.path, operation.content)
          : await this.storage.writeFileIfMatch(ownerId, operation.projectId, operation.path, operation.content, operation.baseEtag);
        return { etag };
      }
      case "write-file-if-absent":
        await this.requireProject(ownerId, operation.projectId);
        return { etag: await this.storage.writeFileIfAbsent(ownerId, operation.projectId, operation.path, operation.content) };
      case "delete-file":
        await this.requireProject(ownerId, operation.projectId);
        await this.storage.deleteFile(ownerId, operation.projectId, operation.path);
        return { ok: true };
      case "rename-file": {
        await this.requireProject(ownerId, operation.projectId);
        const journal: Extract<Journal, { type: "rename-file" }> = { ...operation, stage: "preparing" };
        try {
          await this.storage.renameFile(ownerId, operation.projectId, operation.oldPath, operation.newPath, {
            // renameFile invokes this only after its conditional destination
            // claim. From that point, recovery can safely complete by deleting
            // the source; before it, no destructive journal exists.
            beforeSourceDelete: async () => this.putJournal({ ...journal, stage: "committing" })
          });
        } catch (error) {
          if (error instanceof FileExistsError) await this.clearJournal();
          throw error;
        }
        await this.clearJournal();
        return { ok: true };
      }
      case "upload-if-absent": {
        await this.requireProject(ownerId, operation.projectId);
        const admission = await this.checkUploadAdmission(
          ownerId,
          operation.projectId,
          operation.content.byteLength,
          operation
        );
        const written = await this.storage.uploadToProjectIfAbsent(
          ownerId,
          operation.projectId,
          operation.path,
          operation.content
        );
        if (written) await this.recordUploadAdmission(admission.recent, admission.now);
        return { written };
      }
      case "write-thumbnail": {
        await this.requireProject(ownerId, operation.projectId);
        const existing = await this.bucket.head(`projects/${ownerId}/${operation.projectId}/.thumbnail.png`);
        const additionalBytes = Math.max(0, operation.content.byteLength - (existing?.size ?? 0));
        const admission = await this.checkUploadAdmission(ownerId, operation.projectId, additionalBytes, operation);
        await this.storage.writeThumbnail(ownerId, operation.projectId, operation.content);
        await this.storage.updateProjectMetadata(ownerId, operation.projectId, {
          thumbnailUrl: `/api/projects/${operation.projectId}/thumbnail`
        });
        await this.recordUploadAdmission(admission.recent, admission.now);
        return { ok: true };
      }
      case "create-snapshot":
        await this.requireProject(ownerId, operation.projectId);
        return { snapshot: await this.storage.createSnapshot(ownerId, operation.projectId, { trigger: operation.trigger, label: operation.label }) };
      case "restore-snapshot": {
        await this.requireProject(ownerId, operation.projectId);
        const target = await this.storage.getSnapshot(ownerId, operation.projectId, operation.snapshotId);
        if (!target) throw new Error("Snapshot not found");
        const restorePoint = await this.storage.createSnapshot(ownerId, operation.projectId, {
          trigger: "restore",
          label: `Before restore to ${target.label || target.id}`,
          restoredFromSnapshotId: operation.snapshotId
        });
        if (isSnapshotSkipped(restorePoint)) throw new Error("A restore safety point is required before destructive restore.");
        await this.putJournal({ type: "restore", projectId: operation.projectId, restorePointId: restorePoint.id });
        try {
          const restoredSnapshot = await this.storage.restoreSnapshot(ownerId, operation.projectId, operation.snapshotId);
          await this.clearJournal();
          return { restoredSnapshot, restorePoint };
        } catch (error) {
          await this.recover(ownerId).catch(() => undefined);
          throw error;
        }
      }
      case "replace-files": {
        await this.requireProject(ownerId, operation.projectId);
        const restorePoint = await this.storage.createSnapshot(ownerId, operation.projectId, {
          trigger: "agent",
          label: operation.label || "Before replacing project files"
        });
        if (isSnapshotSkipped(restorePoint)) throw new Error("A restore safety point is required before replacing project files.");
        await this.putJournal({ type: "replace-files", projectId: operation.projectId, restorePointId: restorePoint.id });
        try {
          for (const file of await this.storage.listFiles(ownerId, operation.projectId)) {
            await this.storage.deleteFile(ownerId, operation.projectId, file.path);
          }
          for (const [path, content] of Object.entries(operation.files)) {
            await this.storage.writeFile(ownerId, operation.projectId, path, content);
          }
          await this.clearJournal();
          return { ok: true };
        } catch (error) {
          await this.recover(ownerId).catch(() => undefined);
          throw error;
        }
      }
    }
  }
}

export async function executeOwnerMutation(env: Env, ownerId: string, operation: OwnerMutation): Promise<OwnerMutationResult> {
  const namespace = env.MUTATION_COORDINATOR;
  if (!namespace) throw new Error("MUTATION_COORDINATOR is not configured");
  const id = namespace.idFromName(`owner:${ownerId}`);
  return namespace.get(id).execute(ownerId, operation);
}
