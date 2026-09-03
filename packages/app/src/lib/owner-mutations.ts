import type { Env, ProjectSnapshot, SnapshotResult } from "../types";
import { isSnapshotSkipped } from "../types";
import {
  FileExistsError,
  ProjectExistsError,
  ProjectNotFoundError,
  R2ProjectStorage,
  SnapshotNotFoundError,
  SlugReservationLostError
} from "../storage/r2";
import {
  type SiteStudioLoggingContext,
  type SiteStudioLoggingContextData,
} from "./logging";

export type OwnerMutation =
  | { type: "create-project"; projectId: string; name: string; files: Record<string, string> }
  | { type: "rename-project"; projectId: string; nextProjectId: string; name: string }
  | { type: "rename-project-display"; projectId: string; name: string }
  | { type: "delete-project"; projectId: string }
  | { type: "publish-project"; projectId: string; desiredSlug: string }
  | { type: "unpublish-project"; projectId: string; unpublishedAt: string }
  | { type: "write-file"; projectId: string; path: string; content: string; baseEtag: string }
  | { type: "write-file-if-absent"; projectId: string; path: string; content: string }
  | { type: "delete-file"; projectId: string; path: string }
  | { type: "rename-file"; projectId: string; oldPath: string; newPath: string }
  | { type: "upload-if-absent"; projectId: string; path: string; content: ReadableStream<Uint8Array> }
  | { type: "write-thumbnail"; projectId: string; content: Uint8Array }
  | { type: "create-snapshot"; projectId: string; label?: string; trigger: "agent" | "manual" }
  | { type: "restore-snapshot"; projectId: string; snapshotId: string }
  | { type: "replace-files"; projectId: string; files: Record<string, string>; label?: string };

export type OwnerMutationResult =
  | { etag: string | null }
  | { written: boolean }
  | { snapshot: SnapshotResult }
  | { restoredSnapshot: ProjectSnapshot; restorePoint: ProjectSnapshot }
  | { published: { slug: string } }
  | { ok: true };

type Journal =
  | { type: "create"; projectId: string; operationId?: string }
  | { type: "delete"; projectId: string }
  | {
      type: "rename-project";
      projectId: string;
      nextProjectId: string;
      name: string;
      operationId: string;
      slug?: string;
      /** Optional for compatibility with journals written before this field. */
      published?: boolean;
      stage: "preparing" | "activating" | "committing";
    }
  | {
      type: "rename-file";
      projectId: string;
      oldPath: string;
      newPath: string;
      operationId: string;
      stage: "preparing" | "committing";
    }
  | { type: "restore" | "replace-files"; projectId: string; restorePointId: string };

export interface MutationJournalStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface ProjectHistoryLifecycle {
  clear(ownerId: string, projectId: string): Promise<void>;
  move(ownerId: string, fromProjectId: string, toProjectId: string): Promise<void>;
}

const JOURNAL_KEY = "owner-mutation";

export class OwnerMutationService {
  private readonly storage: R2ProjectStorage;

  constructor(
    private readonly bucket: R2Bucket,
    private readonly journalStore: MutationJournalStore,
    private readonly logging?: SiteStudioLoggingContext,
    private readonly projectHistory?: ProjectHistoryLifecycle,
  ) {
    this.storage = new R2ProjectStorage(bucket, logging);
  }

  private async putJournal(journal: Journal): Promise<void> {
    await this.journalStore.put(JOURNAL_KEY, journal);
  }

  private async clearJournal(): Promise<void> {
    await this.journalStore.delete(JOURNAL_KEY);
  }

  private async requireProject(ownerId: string, projectId: string): Promise<void> {
    if (!(await this.storage.projectExists(ownerId, projectId))) {
      throw new ProjectNotFoundError(projectId);
    }
  }

  private async hideProjectFromPublic(ownerId: string, projectId: string): Promise<void> {
    const metadata = await this.storage.getProjectMetadata(ownerId, projectId);
    if (metadata?.published) {
      await this.storage.updateProjectMetadata(ownerId, projectId, { published: false });
    }
  }

  async recover(ownerId: string): Promise<void> {
    const journal = await this.journalStore.get<Journal>(JOURNAL_KEY);
    if (!journal) return;

    switch (journal.type) {
      case "create":
        if (!journal.operationId) {
          // An operation-less create journal cannot prove which generation it
          // owns. Preserve the project and discard only the ambiguous journal;
          // recovery must never delete a complete destination on a stale claim.
          break;
        }
        {
          const metadata = await this.storage.getProjectMetadata(ownerId, journal.projectId);
          if (metadata?.creatingOperationId === journal.operationId) {
            await this.storage.deleteProject(ownerId, journal.projectId);
          }
        }
        break;
      case "delete":
        // Public readers do not pass through this coordinator. Fence visibility
        // before resuming file deletion so a failed delete cannot leave a
        // progressively torn published site exposed.
        await this.hideProjectFromPublic(ownerId, journal.projectId);
        await this.projectHistory?.clear(ownerId, journal.projectId);
        await this.storage.deleteProject(ownerId, journal.projectId);
        break;
      case "rename-project":
        if (!journal.operationId) {
          // Older journals do not identify the target generation. Preserve the
          // target rather than risking deletion of an unrelated project.
          break;
        }
        if (journal.stage === "preparing") {
          const target = await this.storage.getProjectMetadata(ownerId, journal.nextProjectId);
          if (target?.creatingOperationId === journal.operationId) {
            if (journal.slug) {
              await this.storage.transferPublishedSlugReservation(
                ownerId,
                journal.slug,
                journal.nextProjectId,
                journal.projectId
              );
            }
            await this.storage.deleteProject(ownerId, journal.nextProjectId);
          }
        } else if (journal.stage === "activating") {
          const target = await this.storage.getProjectMetadata(ownerId, journal.nextProjectId);
          if (!target || (target.creatingOperationId && target.creatingOperationId !== journal.operationId)) {
            break;
          }
          if (journal.published) {
            await this.storage.updateProjectMetadata(ownerId, journal.nextProjectId, {
              published: true,
              creatingOperationId: undefined,
            });
          } else {
            await this.storage.updateProjectMetadata(ownerId, journal.nextProjectId, {
              creatingOperationId: undefined,
            });
          }
          if (journal.slug) {
            await this.storage.transferPublishedSlugReservation(
              ownerId,
              journal.slug,
              journal.projectId,
              journal.nextProjectId
            );
          }
          if (journal.published) {
            await this.hideProjectFromPublic(ownerId, journal.projectId);
          }
          await this.putJournal({ ...journal, stage: "committing" });
          await this.projectHistory?.move(ownerId, journal.projectId, journal.nextProjectId);
          await this.storage.deleteProject(ownerId, journal.projectId);
          await this.storage.updateProjectMetadata(ownerId, journal.nextProjectId, {
            name: journal.name,
            creatingOperationId: undefined,
          });
        } else {
          // New journals hide the source before entering `committing`. The slug
          // check also safely fences published journals written by the previous
          // schema, which did not persist the `published` boolean.
          const target = await this.storage.getProjectMetadata(ownerId, journal.nextProjectId);
          if (!target || (target.creatingOperationId && target.creatingOperationId !== journal.operationId)) {
            break;
          }
          if (journal.published || journal.slug) {
            await this.hideProjectFromPublic(ownerId, journal.projectId);
          }
          await this.projectHistory?.move(ownerId, journal.projectId, journal.nextProjectId);
          await this.storage.deleteProject(ownerId, journal.projectId);
          await this.storage.updateProjectMetadata(ownerId, journal.nextProjectId, {
            name: journal.name,
            creatingOperationId: undefined,
          });
        }
        break;
      case "rename-file":
        if (!journal.operationId) {
          // No operation id means no ownership proof for either path.
          break;
        }
        if (journal.stage === "preparing") {
          await this.storage.deleteFileIfRenameClaimed(
            ownerId,
            journal.projectId,
            journal.newPath,
            journal.operationId,
          );
        } else {
          await this.storage.completeRenameFileIfClaimed(
            ownerId,
            journal.projectId,
            journal.oldPath,
            journal.newPath,
            journal.operationId,
          );
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
        const operationId = crypto.randomUUID();
        await this.putJournal({
          type: "create",
          projectId: operation.projectId,
          operationId
        });
        try {
          // The journal exists before the conditional claim, but recovery will
          // compensate only metadata carrying this exact operation id. A crash
          // on either side of the claim can therefore neither expose a partial
          // project nor delete a destination another writer created.
          await this.storage.createProjectIfAbsent(
            ownerId,
            operation.projectId,
            operation.name,
            operationId
          );
          for (const [path, content] of Object.entries(operation.files)) {
            await this.storage.writeFile(ownerId, operation.projectId, path, content);
          }
          await this.storage.updateProjectMetadata(ownerId, operation.projectId, {
            creatingOperationId: undefined
          });
          // The project is complete and visible now. A failed journal cleanup is
          // harmless: recovery sees the absent operation marker and preserves it.
          await this.clearJournal().catch(() => undefined);
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
        const operationId = crypto.randomUUID();
        const journal: Extract<Journal, { type: "rename-project" }> = {
          type: "rename-project",
          projectId: operation.projectId,
          nextProjectId: operation.nextProjectId,
          name: operation.name,
          operationId,
          published: sourceMetadata.published,
          stage: "preparing"
        };
        if (sourceMetadata.published && sourceMetadata.slug) journal.slug = sourceMetadata.slug;
        try {
          await this.storage.renameProject(ownerId, operation.projectId, operation.nextProjectId, {
            operationId,
            beforeTargetClaim: async () => this.putJournal(journal),
            beforeSourceDelete: async (activateTarget) => {
              if (journal.published) {
                // The target is complete but still hidden. Record the roll-
                // forward phase before exposing it, then hide the source before
                // its files begin disappearing.
                await this.putJournal({ ...journal, stage: "activating" });
              } else {
                // The target is complete but unpublished. Durably mark the
                // committing phase before clearing its hidden-generation marker.
                await this.putJournal({ ...journal, stage: "committing" });
              }
              await activateTarget();
              if (journal.slug) {
                await this.storage.transferPublishedSlugReservation(
                  ownerId,
                  journal.slug,
                  operation.projectId,
                  operation.nextProjectId
                );
              }
              if (journal.published) {
                await this.hideProjectFromPublic(ownerId, operation.projectId);
                await this.putJournal({ ...journal, stage: "committing" });
              }
              await this.projectHistory?.move(
                ownerId,
                operation.projectId,
                operation.nextProjectId,
              );
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
        await this.storage.updateProjectMetadata(ownerId, operation.nextProjectId, {
          name: operation.name,
          creatingOperationId: undefined,
        });
        await this.clearJournal();
        return { ok: true };
      }
      case "delete-project":
        await this.putJournal({ type: "delete", projectId: operation.projectId });
        await this.hideProjectFromPublic(ownerId, operation.projectId);
        await this.projectHistory?.clear(ownerId, operation.projectId);
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
          try {
            await this.storage.updateProjectMetadataForSlugClaim(ownerId, operation.projectId, claim, {
              published: true,
              publishedAt: new Date().toISOString(),
              slug: claim.slug
            });
            return { published: { slug: claim.slug } };
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
          unpublishedAt: operation.unpublishedAt
        });
        return { ok: true };
      case "write-file": {
        await this.requireProject(ownerId, operation.projectId);
        return {
          etag: await this.storage.writeFileIfMatch(
            ownerId,
            operation.projectId,
            operation.path,
            operation.content,
            operation.baseEtag,
          ),
        };
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
        const operationId = crypto.randomUUID();
        const journal: Extract<Journal, { type: "rename-file" }> = {
          ...operation,
          operationId,
          stage: "preparing",
        };
        await this.putJournal(journal);
        try {
          await this.storage.renameFile(ownerId, operation.projectId, operation.oldPath, operation.newPath, {
            operationId,
            // renameFile invokes this only after its conditional destination
            // claim. From that point, recovery can safely complete only when
            // the destination still carries this operation's marker.
            beforeSourceDelete: async () => this.putJournal({ ...journal, stage: "committing" })
          });
        } catch (error) {
          if (error instanceof FileExistsError) {
            await this.clearJournal();
          } else {
            await this.recover(ownerId).catch(() => undefined);
          }
          throw error;
        }
        await this.clearJournal();
        return { ok: true };
      }
      case "upload-if-absent": {
        await this.requireProject(ownerId, operation.projectId);
        const written = await this.storage.uploadToProjectIfAbsent(
          ownerId,
          operation.projectId,
          operation.path,
          operation.content
        );
        return { written };
      }
      case "write-thumbnail": {
        await this.requireProject(ownerId, operation.projectId);
        await this.storage.writeThumbnail(ownerId, operation.projectId, operation.content);
        await this.storage.updateProjectMetadata(ownerId, operation.projectId, {
          thumbnailUrl: `/api/projects/${operation.projectId}/thumbnail`
        });
        return { ok: true };
      }
      case "create-snapshot":
        await this.requireProject(ownerId, operation.projectId);
        return { snapshot: await this.storage.createSnapshot(ownerId, operation.projectId, { trigger: operation.trigger, label: operation.label }) };
      case "restore-snapshot": {
        await this.requireProject(ownerId, operation.projectId);
        const target = await this.storage.getSnapshot(ownerId, operation.projectId, operation.snapshotId);
        if (!target) throw new SnapshotNotFoundError(operation.snapshotId);
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

export async function executeOwnerMutation(
  env: Pick<Env, "MUTATION_COORDINATOR">,
  ownerId: string,
  operation: OwnerMutation,
  logging?: SiteStudioLoggingContextData,
): Promise<OwnerMutationResult> {
  const namespace = env.MUTATION_COORDINATOR;
  if (!namespace) throw new Error("MUTATION_COORDINATOR is not configured");
  const id = namespace.idFromName(`owner:${ownerId}`);
  return namespace.get(id).execute(ownerId, operation, logging);
}
