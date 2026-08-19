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

const chatPartSchema = z.object({
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
}).catchall(jsonValueSchema).superRefine((part, context) => {
  const issue = (path: string, message: string) => {
    context.addIssue({ code: "custom", path: [path], message });
  };
  const has = (value: z.infer<typeof jsonValueSchema> | undefined): boolean => value !== undefined;
  const requireString = (field: "text" | "sourceId" | "url" | "mediaType" | "title" | "filename" | "data") => {
    if (field === "data") {
      if (!has(part.data)) issue(field, "data parts require data");
      return;
    }
    if (!z.string().safeParse(part[field]).success) issue(field, `${field} is required`);
  };

  if (part.type === "text" || part.type === "reasoning") {
    requireString("text");
    if (part.state !== undefined && (part.state !== "streaming" && part.state !== "done")) {
      issue("state", "text and reasoning parts use streaming or done state");
    }
    return;
  }

  if (part.type === "source-url") {
    requireString("sourceId");
    requireString("url");
    return;
  }
  if (part.type === "source-document") {
    requireString("sourceId");
    requireString("mediaType");
    requireString("title");
    return;
  }
  if (part.type === "file") {
    requireString("mediaType");
    requireString("url");
    return;
  }
  if (part.type === "step-start") return;
  if (part.type.startsWith("data-")) {
    requireString("data");
    return;
  }

  const isDynamicTool = part.type === "dynamic-tool";
  if (!isDynamicTool && !toolTypeSchema.safeParse(part.type).success) {
    issue("type", "unsupported chat part type");
    return;
  }
  if (isDynamicTool && part.toolName === undefined) issue("toolName", "dynamic tools require a tool name");
  if (part.toolCallId === undefined) issue("toolCallId", "tool parts require a call id");
  if (part.state === undefined || !toolStateSchema.safeParse(part.state).success) {
    issue("state", "tool parts require a valid state");
    return;
  }

  const requiresInput = part.state !== "input-streaming" && part.state !== "output-error";
  if (requiresInput && !has(part.input)) issue("input", "this tool state requires input");
  if (part.state === "output-available" && !has(part.output)) issue("output", "output-available requires output");
  if (part.state === "output-error" && part.errorText === undefined) issue("errorText", "output-error requires errorText");

  if (part.state === "input-streaming" || part.state === "input-available") {
    if (has(part.output) || has(part.errorText) || has(part.approval)) {
      issue("state", `${part.state} cannot contain output, error, or approval`);
    }
  }
  if (part.state === "approval-requested") {
    if (!part.approval || part.approval.approved !== undefined) {
      issue("approval", "approval-requested requires an undecided approval");
    }
  }
  if (part.state === "approval-responded") {
    if (!part.approval || !z.boolean().safeParse(part.approval.approved).success) {
      issue("approval", "approval-responded requires an approval decision");
    }
  }
  if (part.state === "output-available" || part.state === "output-error") {
    if (part.approval && part.approval.approved !== true) {
      issue("approval", `${part.state} approvals must be approved`);
    }
  }
  if (part.state === "output-denied") {
    if (!part.approval || part.approval.approved !== false) {
      issue("approval", "output-denied requires a rejected approval");
    }
    if (has(part.output) || has(part.errorText)) issue("state", "output-denied cannot contain output or error");
  }
});

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
