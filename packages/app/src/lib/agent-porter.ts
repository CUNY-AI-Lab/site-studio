/**
 * Chat-history porter for the anonymous-data migration (lib/migration.ts).
 *
 * SiteBuilderAgent chat history lives in per-instance Durable Object SQLite,
 * keyed by the instance name `${ownerId}:${projectId}`. Re-homing a project
 * to the CAIL subject therefore also means moving its conversation to the
 * `${subject}:${newProjectId}` instance. This is best-effort by design: the
 * migration of files and snapshots must never fail because a conversation
 * could not be copied (e.g. RPC size limits on very large histories).
 */

import type { Env } from "../types";
import type { ChatHistoryPorter } from "./migration";

export function createAgentHistoryPorter(
  env: Pick<Env, "SITE_BUILDER_AGENT">
): ChatHistoryPorter {
  return {
    async port(fromOwner, fromProjectId, toOwner, toProjectId) {
      // Imported lazily: the `agents` package depends on `cloudflare:workers`
      // scheme modules that only resolve inside workerd, so a static import
      // here would break every module that (transitively) imports the session
      // middleware under vitest/Node. Porting is best-effort anyway — the
      // caller catches failures.
      const { getAgentByName } = await import("agents");

      const source = await getAgentByName(
        env.SITE_BUILDER_AGENT,
        `${fromOwner}:${fromProjectId}`
      );
      // The DO-stub RPC mapped type collapses `unknown[]` to `never`; the
      // runtime value is the agent's UIMessage[] (structured-clone friendly).
      const messages = (await source.exportChatHistoryForMigration()) as unknown[];
      if (!Array.isArray(messages) || messages.length === 0) {
        return;
      }

      const destination = await getAgentByName(
        env.SITE_BUILDER_AGENT,
        `${toOwner}:${toProjectId}`
      );
      await destination.importChatHistoryForMigration(messages);
    }
  };
}
