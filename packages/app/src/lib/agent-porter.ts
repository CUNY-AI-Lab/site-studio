/**
 * Chat-history porter for the anonymous-data migration (lib/migration.ts).
 *
 * SiteBuilderAgent chat history lives in per-instance Durable Object SQLite,
 * keyed by the instance name `${ownerId}:${projectId}`. Re-homing a project
 * to the CAIL subject therefore also means moving its conversation to the
 * `${subject}:${newProjectId}` instance. Account import fails closed when a
 * conversation cannot be copied: the migration caller retains the anonymous
 * namespace so a later request can retry instead of retiring the only
 * recoverable copy. Standalone rename and delete helpers remain best-effort
 * because they are outside account import.
 */

import type { Env } from "../types";
import type { ChatHistoryPorter } from "./migration";

export async function clearProjectAgentHistory(
  env: Pick<Env, "SITE_BUILDER_AGENT">,
  owner: string,
  projectId: string
): Promise<void> {
  // Keep this import lazy: `agents` pulls `cloudflare:` scheme modules that do
  // not resolve in Node/vitest (see createAgentHistoryPorter below).
  const { getAgentByName } = await import("agents");
  const stub = await getAgentByName(
    env.SITE_BUILDER_AGENT,
    `${owner}:${projectId}`
  );
  await stub.clearChatHistory();
}

export async function moveProjectAgentHistory(
  env: Pick<Env, "SITE_BUILDER_AGENT">,
  owner: string,
  fromProjectId: string,
  toProjectId: string
): Promise<void> {
  const { getAgentByName } = await import("agents");
  const source = await getAgentByName(
    env.SITE_BUILDER_AGENT,
    `${owner}:${fromProjectId}`
  );
  const messages = (await source.exportChatHistoryForMigration()) as unknown[];

  if (Array.isArray(messages) && messages.length > 0) {
    const destination = await getAgentByName(
      env.SITE_BUILDER_AGENT,
      `${owner}:${toProjectId}`
    );
    await destination.importChatHistoryForMigration(messages);
  }

  await source.clearChatHistory();
}

export function createAgentHistoryPorter(
  env: Pick<Env, "SITE_BUILDER_AGENT">
): ChatHistoryPorter {
  return {
    async port(fromOwner, fromProjectId, toOwner, toProjectId) {
      // Imported lazily: the `agents` package depends on `cloudflare:workers`
      // scheme modules that only resolve inside workerd, so a static import
      // here would break every module that (transitively) imports the session
      // middleware under vitest/Node. The migration caller owns failure
      // handling so it can retain the anonymous namespace for retry.
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
