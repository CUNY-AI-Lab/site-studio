import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import { OwnerMutationService, type OwnerMutation, type OwnerMutationResult } from "../lib/owner-mutations";
import {
  findImportedProjectMap,
  migrateAnonymousData,
  migrationClaimKey,
  type MigrationClaim,
  type MigrationResult,
} from "../lib/migration";
import {
  runSubjectImport,
  SessionStoreUnavailableError,
  type SubjectImportOutcome,
} from "../lib/anonymous-import";
import { createAgentHistoryPorter, createProjectHistoryLifecycle } from "../lib/agent-porter";
import {
  createSiteStudioBoundaryContext,
  emitDiagnostic,
  type SiteStudioLoggingContextData,
} from "../lib/logging";
import {
  LegacyRecoveryError,
  claimRecoveryHandle,
  loadRecoveryManifest,
  markRecoveryComplete,
  readRecoveryAuthorization,
  validateStagedRecovery,
  verifyRecoveredDestination,
  writeRecoveryAliases,
} from "../lib/legacy-recovery";
import { getUserHandle } from "../lib/handles";

export class SerializedOperationQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

export class MutationCoordinator extends DurableObject<Env> {
  /**
   * Serialize owner mutations without holding `blockConcurrencyWhile()` across
   * R2/KV/RPC work. Cloudflare resets a Durable Object when that callback runs
   * for 30 seconds, which is shorter than a valid large rename, restore, or
   * account import can take. A promise tail preserves per-instance ordering
   * without imposing that initialization-only timeout.
   */
  private readonly mutations = new SerializedOperationQueue();

  async execute(
    ownerId: string,
    operation: OwnerMutation,
    logging?: SiteStudioLoggingContextData,
  ): Promise<OwnerMutationResult> {
    return this.mutations.run(() =>
      new OwnerMutationService(
        this.env.SITE_STUDIO_BUCKET,
        this.ctx.storage,
        logging ? createSiteStudioBoundaryContext(this.env, logging) : undefined,
        createProjectHistoryLifecycle(this.env),
      ).execute(ownerId, operation)
    );
  }

  async migrateAnonymous(
    anonUserId: string,
    subject: string,
    anonSessionId?: string,
    logging?: SiteStudioLoggingContextData,
  ): Promise<MigrationResult> {
    return this.mutations.run(async () => {
      // Account import shares the anonymous owner's mutation queue. Recover a
      // prior adopted mutation before inventorying the namespace so migration
      // never copies a hidden partial create or races its compensation.
      await new OwnerMutationService(
        this.env.SITE_STUDIO_BUCKET,
        this.ctx.storage,
        logging ? createSiteStudioBoundaryContext(this.env, logging) : undefined,
        createProjectHistoryLifecycle(this.env),
      ).recover(anonUserId);
      return migrateAnonymousData({
        bucket: this.env.SITE_STUDIO_BUCKET,
        kv: this.env.SESSION_KV,
        anonUserId,
        subject,
        anonSessionId,
        porter: createAgentHistoryPorter(this.env),
        logging: logging ? createSiteStudioBoundaryContext(this.env, logging) : undefined,
      });
    });
  }

  /** Consume an operator-staged file-only source without probing agent chat. */
  async migrateStagedLegacyProjects(
    recoveryId: string,
    anonUserId: string,
    subject: string,
  ): Promise<MigrationResult> {
    return this.mutations.run(async () => {
      const logging = this.env.CAIL_LOG_ENV
        ? createSiteStudioBoundaryContext(this.env)
        : undefined;
      try {
        await new OwnerMutationService(
          this.env.SITE_STUDIO_BUCKET,
          this.ctx.storage,
          undefined,
          createProjectHistoryLifecycle(this.env),
        ).recover(anonUserId);
      } catch (error) {
        emitDiagnostic(
          "error",
          "legacy_recovery_source_journal_failed",
          {},
          logging,
        );
        throw error;
      }
      let manifest: Awaited<ReturnType<typeof loadRecoveryManifest>>["manifest"];
      try {
        ({ manifest } = await loadRecoveryManifest(
          this.env.SITE_STUDIO_BUCKET,
          recoveryId,
        ));
      } catch (error) {
        emitDiagnostic(
          "error",
          "legacy_recovery_manifest_load_failed",
          {},
          logging,
        );
        throw error;
      }
      if (manifest.source.owner !== anonUserId) throw new LegacyRecoveryError("conflict");
      // The first source-queue entry must revalidate immediately before copy.
      // A later entry with a migration claim is a resume: source deletion may
      // already be partial or complete, so destination stamps become the retry
      // evidence instead of requiring disposable staged bytes to reappear.
      const migrationClaim = await this.env.SESSION_KV.get<MigrationClaim>(
        migrationClaimKey(anonUserId),
        "json",
      );
      try {
        await validateStagedRecovery(this.env.SITE_STUDIO_BUCKET, manifest, {
          allowMissing: Boolean(migrationClaim),
        });
      } catch (error) {
        emitDiagnostic(
          "error",
          "legacy_recovery_source_validation_failed",
          {},
          logging,
        );
        throw error;
      }
      return migrateAnonymousData({
        bucket: this.env.SITE_STUDIO_BUCKET,
        kv: this.env.SESSION_KV,
        anonUserId,
        subject,
        logging,
      });
    });
  }

  /**
   * Run a verified operator recovery through both ordinary owner queues. This
   * entry is called only on `owner:${subject}` by the private recovery
   * entrypoint; the disposable source copy is then consumed on its own queue.
   * It deliberately does not touch the subject's first-login import marker.
   */
  async restoreLegacyProjects(
    recoveryId: string,
    anonUserId: string,
    subject: string,
  ): Promise<MigrationResult> {
    return this.mutations.run(async () => {
      await new OwnerMutationService(
        this.env.SITE_STUDIO_BUCKET,
        this.ctx.storage,
        undefined,
        createProjectHistoryLifecycle(this.env),
      ).recover(subject);
      const namespace = this.env.MUTATION_COORDINATOR;
      if (!namespace) throw new Error("MUTATION_COORDINATOR is not configured");
      const result = await namespace
        .get(namespace.idFromName(`owner:${anonUserId}`))
        .migrateStagedLegacyProjects(recoveryId, anonUserId, subject);
      const { manifest } = await loadRecoveryManifest(this.env.SITE_STUDIO_BUCKET, recoveryId);
      const importedProjectMap = await findImportedProjectMap(
        this.env.SITE_STUDIO_BUCKET,
        subject,
        anonUserId,
      );
      const projectMap = { ...importedProjectMap, ...result.projects };
      await verifyRecoveredDestination({
        bucket: this.env.SITE_STUDIO_BUCKET,
        manifest,
        targetSubject: subject,
        projectMap,
      });
      const recovery = await readRecoveryAuthorization(this.env.SITE_STUDIO_BUCKET, recoveryId);
      if (!recovery) throw new LegacyRecoveryError("unavailable");
      let recoveryHandle = recovery.value.recoveryHandle;
      if (
        manifest.projects.some((project) => project.published) &&
        !await getUserHandle(this.env.SITE_STUDIO_BUCKET, subject) &&
        !recoveryHandle
      ) {
        recoveryHandle = await claimRecoveryHandle(
          this.env.SITE_STUDIO_BUCKET,
          anonUserId,
          subject,
          recovery.value.startedAt,
        );
      }
      await writeRecoveryAliases({
        bucket: this.env.SITE_STUDIO_BUCKET,
        manifest,
        targetSubject: subject,
        projectMap,
        recoveryHandle,
      });
      await markRecoveryComplete(
        this.env.SITE_STUDIO_BUCKET,
        recovery,
        projectMap,
        recoveryHandle,
      );
      return { ...result, projects: projectMap };
    });
  }

  /**
   * Serialize first-login import decisions by CAIL subject. This method must
   * run on `owner:${subject}`, while the copy itself runs on the distinct
   * `owner:${anonUserId}` coordinator below; calling this.migrateAnonymous()
   * here would re-enter this queue and deadlock.
   */
  async migrateAnonymousForSubject(
    subject: string,
    cookieValue?: string,
    logging?: SiteStudioLoggingContextData,
  ): Promise<SubjectImportOutcome> {
    return this.mutations.run(async () => {
      const loggingContext = logging
        ? createSiteStudioBoundaryContext(this.env, logging)
        : undefined;

      // The subject queue also owns ordinary project mutations. Recover an
      // interrupted subject operation before import can copy into or close
      // that namespace; otherwise a pending delete/restore/rename journal
      // could be applied only after this import has retired its source.
      await new OwnerMutationService(
        this.env.SITE_STUDIO_BUCKET,
        this.ctx.storage,
        loggingContext,
        createProjectHistoryLifecycle(this.env),
      ).recover(subject);

      const claimAnonymous = async (
        anonUserId: string,
        claimSubject: string,
      ): Promise<{ granted: boolean }> => {
        try {
          const stub = this.env.MIGRATION_COORDINATOR.get(
            this.env.MIGRATION_COORDINATOR.idFromName(anonUserId),
          );
          const decision = await stub.claim(anonUserId, claimSubject);
          return { granted: decision.granted };
        } catch (error) {
          throw new SessionStoreUnavailableError(
            `Migration claim gate unavailable for ${anonUserId} -> ${claimSubject}`,
            { cause: error },
          );
        }
      };

      const migrateAnonymousOnOwnerQueue = (
        anonUserId: string,
        migrationSubject: string,
        anonSessionId?: string,
      ): Promise<MigrationResult> => {
        const namespace = this.env.MUTATION_COORDINATOR;
        if (!namespace) {
          throw new SessionStoreUnavailableError("MUTATION_COORDINATOR is not configured");
        }
        // This id is intentionally different from the subject owner id that
        // admitted this operation, so the anonymous-owner queue can run while
        // this subject queue awaits it.
        return namespace
          .get(namespace.idFromName(`owner:${anonUserId}`))
          .migrateAnonymous(
            anonUserId,
            migrationSubject,
            anonSessionId,
            logging,
          );
      };

      const markAnonymousComplete = async (
        anonUserId: string,
        completeSubject: string,
      ): Promise<void> => {
        const stub = this.env.MIGRATION_COORDINATOR.get(
          this.env.MIGRATION_COORDINATOR.idFromName(anonUserId),
        );
        await stub.markComplete(anonUserId, completeSubject);
      };

      return runSubjectImport({
        env: this.env,
        storage: this.ctx.storage,
        subject,
        cookieValue,
        logging: loggingContext,
        claimAnonymous,
        migrateAnonymous: migrateAnonymousOnOwnerQueue,
        markAnonymousComplete,
      });
    });
  }
}
