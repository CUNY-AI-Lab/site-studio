import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import { OwnerMutationService, type OwnerMutation, type OwnerMutationResult } from "../lib/owner-mutations";
import { migrateAnonymousData, type MigrationResult } from "../lib/migration";
import {
  runSubjectImport,
  SessionStoreUnavailableError,
  type SubjectImportOutcome,
} from "../lib/anonymous-import";
import { createAgentHistoryPorter, createProjectHistoryLifecycle } from "../lib/agent-porter";
import {
  createSiteStudioBoundaryContext,
  type SiteStudioLoggingContextData,
} from "../lib/logging";

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
