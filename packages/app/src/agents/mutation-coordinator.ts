import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import { OwnerMutationService, type OwnerMutation, type OwnerMutationResult } from "../lib/owner-mutations";
import { migrateAnonymousData, type MigrationResult } from "../lib/migration";
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
      if (!this.env.PUBLISHED_BASE_URL) {
        throw new Error("PUBLISHED_BASE_URL is not configured");
      }
      return migrateAnonymousData({
        bucket: this.env.SITE_STUDIO_BUCKET,
        kv: this.env.SESSION_KV,
        anonUserId,
        subject,
        publishedBaseUrl: this.env.PUBLISHED_BASE_URL,
        anonSessionId,
        porter: createAgentHistoryPorter(this.env),
        logging: logging ? createSiteStudioBoundaryContext(this.env, logging) : undefined,
      });
    });
  }
}
