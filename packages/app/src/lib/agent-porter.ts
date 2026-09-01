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

type AgentHistoryStub = {
  clearChatHistory?: () => Promise<void>;
  exportChatHistoryForMigration?: () => Promise<ChatHistoryWire>;
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

const jsonValueSchema = z.json();
const jsonObjectSchema = z.record(z.string(), jsonValueSchema);
const toolStateSchema = z.enum([
  "input-streaming",
  "input-available",
  "approval-requested",
  "approval-responded",
  "output-available",
  "output-error",
  "output-denied",
]);
const partStateSchema = z.union([toolStateSchema, z.enum(["streaming", "done"])]);
const toolTypeSchema = z.string().startsWith("tool-");
const approvalSchema = z.object({
  id: z.string(),
  approved: z.boolean().optional(),
  reason: z.string().optional(),
  signature: z.string().optional(),
}).catchall(jsonValueSchema);

const chatPartFieldsSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  state: partStateSchema.optional(),
  sourceId: z.string().optional(),
  url: z.string().optional(),
  mediaType: z.string().optional(),
  title: z.string().optional(),
  filename: z.string().optional(),
  id: z.string().optional(),
  data: jsonValueSchema.optional(),
  toolName: z.string().optional(),
  toolCallId: z.string().optional(),
  toolMetadata: jsonObjectSchema.optional(),
  providerExecuted: z.boolean().optional(),
  input: jsonValueSchema.optional(),
  output: jsonValueSchema.optional(),
  errorText: z.string().optional(),
  rawInput: jsonValueSchema.optional(),
  callProviderMetadata: jsonObjectSchema.optional(),
  resultProviderMetadata: jsonObjectSchema.optional(),
  providerMetadata: jsonObjectSchema.optional(),
  preliminary: z.boolean().optional(),
  approval: approvalSchema.optional(),
}).catchall(jsonValueSchema);

const standardPartSchema = z.discriminatedUnion("type", [
  chatPartFieldsSchema.extend({
    type: z.enum(["text", "reasoning"]),
    text: z.string(),
    state: z.enum(["streaming", "done"]).optional(),
  }),
  chatPartFieldsSchema.extend({
    type: z.literal("source-url"),
    sourceId: z.string(),
    url: z.string(),
  }),
  chatPartFieldsSchema.extend({
    type: z.literal("source-document"),
    sourceId: z.string(),
    mediaType: z.string(),
    title: z.string(),
  }),
  chatPartFieldsSchema.extend({
    type: z.literal("file"),
    mediaType: z.string(),
    url: z.string(),
  }),
  chatPartFieldsSchema.extend({ type: z.literal("step-start") }),
]);

const dataPartSchema = chatPartFieldsSchema.extend({
  type: z.string().startsWith("data-"),
  data: jsonValueSchema,
});

const undecidedApprovalSchema = approvalSchema.extend({
  approved: z.never().optional(),
  reason: z.never().optional(),
});
const decidedApprovalSchema = approvalSchema.extend({ approved: z.boolean() });
const approvedApprovalSchema = approvalSchema.extend({ approved: z.literal(true) });
const rejectedApprovalSchema = approvalSchema.extend({ approved: z.literal(false) });
const toolPartFieldsSchema = chatPartFieldsSchema.extend({ toolCallId: z.string() });

const toolPartSchema = z.discriminatedUnion("state", [
  toolPartFieldsSchema.extend({
    state: z.literal("input-streaming"),
    input: jsonValueSchema.optional(),
    output: z.never().optional(),
    errorText: z.never().optional(),
    approval: z.never().optional(),
  }),
  toolPartFieldsSchema.extend({
    state: z.literal("input-available"),
    input: jsonValueSchema,
    output: z.never().optional(),
    errorText: z.never().optional(),
    approval: z.never().optional(),
  }),
  toolPartFieldsSchema.extend({
    state: z.literal("approval-requested"),
    input: jsonValueSchema,
    output: z.never().optional(),
    errorText: z.never().optional(),
    approval: undecidedApprovalSchema,
  }),
  toolPartFieldsSchema.extend({
    state: z.literal("approval-responded"),
    input: jsonValueSchema,
    output: z.never().optional(),
    errorText: z.never().optional(),
    approval: decidedApprovalSchema,
  }),
  toolPartFieldsSchema.extend({
    state: z.literal("output-available"),
    input: jsonValueSchema,
    output: jsonValueSchema,
    errorText: z.never().optional(),
    approval: approvedApprovalSchema.optional(),
  }),
  toolPartFieldsSchema.extend({
    state: z.literal("output-error"),
    input: jsonValueSchema.optional(),
    output: z.never().optional(),
    errorText: z.string(),
    approval: approvedApprovalSchema.optional(),
  }),
  toolPartFieldsSchema.extend({
    state: z.literal("output-denied"),
    input: jsonValueSchema,
    output: z.never().optional(),
    errorText: z.never().optional(),
    approval: rejectedApprovalSchema,
  }),
]).and(z.union([
  z.object({ type: toolTypeSchema }),
  z.object({ type: z.literal("dynamic-tool"), toolName: z.string() }),
]));

const chatPartSchema = z.union([standardPartSchema, dataPartSchema, toolPartSchema]);

const chatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["system", "user", "assistant"]),
  metadata: jsonValueSchema.optional(),
  parts: z.array(chatPartSchema).nonempty(),
}).catchall(jsonValueSchema);
const chatHistorySchema = z.array(chatMessageSchema).nonempty();
type ChatHistoryWire = UIMessage[] | z.input<typeof chatHistorySchema>;

function assertChatHistory(value: ChatHistoryWire): asserts value is UIMessage[] {
  const parsed = chatHistorySchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Agent chat history is malformed", { cause: parsed.error });
  }
}

function parseChatHistory(value: ChatHistoryWire): UIMessage[] {
  if (Array.isArray(value) && value.length === 0) return [];
  assertChatHistory(value);
  // Return the validated RPC value itself. Zod's parsed object intentionally
  // is not used here: Durable Object history may carry valid UI SDK extension
  // fields, and migration must preserve those fields without reconstruction.
  return value;
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
  if (!source.exportChatHistoryForMigration) {
    throw new Error("Agent history source cannot export history");
  }
  const rawMessages = await source.exportChatHistoryForMigration();
  const messages = await parseChatHistory(rawMessages);

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
      if (!source.exportChatHistoryForMigration) {
        throw new Error("Agent history source cannot export history");
      }
      const rawMessages = await source.exportChatHistoryForMigration();
      const messages = await parseChatHistory(rawMessages);
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
