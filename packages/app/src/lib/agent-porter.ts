/**
 * Chat-history porter for the anonymous-data migration (lib/migration.ts).
 *
 * SiteBuilderAgent chat history lives in per-instance Durable Object SQLite,
 * keyed by the instance name `${ownerId}:${projectId}`. Re-homing a project
 * to the CAIL subject therefore also means moving its conversation to the
 * `${subject}:${newProjectId}` instance. Account import fails closed when a
 * conversation cannot be copied: the migration caller retains the anonymous
 * namespace so a later request can retry instead of retiring the only
 * recoverable copy. Project rename and delete run these operations inside the
 * owner's mutation journal so a failed history operation remains retryable.
 */

import type { Env } from "../types";
import type { ChatHistoryPorter } from "./migration";
import type { ProjectHistoryLifecycle } from "./owner-mutations";
import type { UIMessage } from "ai";
import { z } from "zod";

const chatHistorySchema = z.array(z.object({
  id: z.string(),
  role: z.enum(["system", "user", "assistant"]),
  parts: z.array(z.object({ type: z.string() }).passthrough()),
}).passthrough());

type AgentHistoryPart = { type: string; [key: string]: string | number | boolean | null | undefined };
type AgentHistoryPayload = Array<{ id: string; role: string; parts: AgentHistoryPart[] }>;
type AgentHistoryStub = {
  clearChatHistory?: () => Promise<void>;
  exportChatHistoryForMigration?: () => Promise<AgentHistoryPayload>;
  importChatHistoryForMigration?: (messages: UIMessage[]) => Promise<boolean>;
};

export type AgentHistoryResolver = (
  namespace: Env["SITE_BUILDER_AGENT"],
  name: string,
) => Promise<AgentHistoryStub>;

async function resolveAgentByName(
  namespace: Env["SITE_BUILDER_AGENT"],
  name: string,
): Promise<AgentHistoryStub> {
  const { getAgentByName } = await import("agents");
  return getAgentByName(namespace, name);
}

function parseChatHistory(cause: AgentHistoryPayload): UIMessage[] {
  const parsed = chatHistorySchema.safeParse(cause);
  if (!parsed.success) {
    throw new Error("Agent chat history is malformed");
  }
  // SAFETY: The schema validates the structured-clone envelope emitted by
  // AIChatAgent persistence; the agent API consumes this same UIMessage shape.
  return parsed.data as UIMessage[];
}

export async function clearProjectAgentHistory(
  env: Pick<Env, "SITE_BUILDER_AGENT">,
  owner: string,
  projectId: string,
  resolveAgent: AgentHistoryResolver = resolveAgentByName,
): Promise<void> {
  const stub = await resolveAgent(
    env.SITE_BUILDER_AGENT,
    `${owner}:${projectId}`
  );
  if (!stub.clearChatHistory) throw new Error("Agent history stub cannot clear history");
  await stub.clearChatHistory();
}

export async function moveProjectAgentHistory(
  env: Pick<Env, "SITE_BUILDER_AGENT">,
  owner: string,
  fromProjectId: string,
  toProjectId: string,
  resolveAgent: AgentHistoryResolver = resolveAgentByName,
): Promise<void> {
  const source = await resolveAgent(
    env.SITE_BUILDER_AGENT,
    `${owner}:${fromProjectId}`
  );
  // SAFETY: the generated Durable Object stub erases the method's return type; the RPC payload is decoded by chatHistorySchema before use.
  if (!source.exportChatHistoryForMigration) {
    throw new Error("Agent history source cannot export history");
  }
  const rawMessages = await source.exportChatHistoryForMigration();
  const messages = parseChatHistory(rawMessages);

  if (Array.isArray(messages) && messages.length > 0) {
    const destination = await resolveAgent(
      env.SITE_BUILDER_AGENT,
      `${owner}:${toProjectId}`
    );
    if (!destination.importChatHistoryForMigration) {
      throw new Error("Agent history destination cannot import history");
    }
    const imported = await destination.importChatHistoryForMigration(messages);
    if (!imported) {
      throw new Error("Destination chat history differs from the source project");
    }
  }

  if (!source.clearChatHistory) throw new Error("Agent history source cannot clear history");
  await source.clearChatHistory();
}

export function createAgentHistoryPorter(
  env: Pick<Env, "SITE_BUILDER_AGENT">,
  resolveAgent: AgentHistoryResolver = resolveAgentByName,
): ChatHistoryPorter {
  return {
    async port(fromOwner, fromProjectId, toOwner, toProjectId) {
      const source = await resolveAgent(
        env.SITE_BUILDER_AGENT,
        `${fromOwner}:${fromProjectId}`
      );
      // The DO-stub RPC mapped type collapses `unknown[]` to `never`; the
      // runtime value is the agent's UIMessage[] (structured-clone friendly).
      // SAFETY: the generated Durable Object stub erases the method's return type; the RPC payload is decoded by chatHistorySchema before use.
      if (!source.exportChatHistoryForMigration) {
        throw new Error("Agent history source cannot export history");
      }
      const rawMessages = await source.exportChatHistoryForMigration();
      const messages = parseChatHistory(rawMessages);
      if (!Array.isArray(messages) || messages.length === 0) {
        return;
      }

      const destination = await resolveAgent(
        env.SITE_BUILDER_AGENT,
        `${toOwner}:${toProjectId}`
      );
      if (!destination.importChatHistoryForMigration) {
        throw new Error("Agent history destination cannot import history");
      }
      const imported = await destination.importChatHistoryForMigration(messages);
      if (!imported) {
        throw new Error("Destination chat history differs from the legacy source");
      }
    }
  };
}

export function createProjectHistoryLifecycle(
  env: Pick<Env, "SITE_BUILDER_AGENT">,
  resolveAgent: AgentHistoryResolver = resolveAgentByName,
): ProjectHistoryLifecycle {
  return {
    clear: (ownerId, projectId) => clearProjectAgentHistory(env, ownerId, projectId, resolveAgent),
    move: (ownerId, fromProjectId, toProjectId) =>
      moveProjectAgentHistory(env, ownerId, fromProjectId, toProjectId, resolveAgent),
  };
}
