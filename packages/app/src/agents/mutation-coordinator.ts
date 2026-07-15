import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import { OwnerMutationService, type OwnerMutation, type OwnerMutationResult } from "../lib/owner-mutations";
import { migrateAnonymousData, type MigrationResult } from "../lib/migration";
import { createAgentHistoryPorter } from "../lib/agent-porter";

export class MutationCoordinator extends DurableObject<Env> {
  async execute(ownerId: string, operation: OwnerMutation): Promise<OwnerMutationResult> {
    return this.ctx.blockConcurrencyWhile(() =>
      new OwnerMutationService(this.env.SITE_STUDIO_BUCKET, this.ctx.storage).execute(ownerId, operation)
    );
  }

  async migrateAnonymous(
    anonUserId: string,
    subject: string,
    anonSessionId?: string
  ): Promise<MigrationResult> {
    return this.ctx.blockConcurrencyWhile(() =>
      migrateAnonymousData({
        bucket: this.env.SITE_STUDIO_BUCKET,
        kv: this.env.SESSION_KV,
        anonUserId,
        subject,
        anonSessionId,
        porter: createAgentHistoryPorter(this.env)
      })
    );
  }
}
