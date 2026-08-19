import {
  AIChatAgent,
  createToolsFromClientSchemas,
  type ChatResponseResult,
} from "@cloudflare/ai-chat";
import {
  callable,
  getCurrentAgent,
  type Connection,
  type ConnectionContext,
} from "agents";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createCodeTool } from "@cloudflare/codemode/ai";
import {
  convertToModelMessages,
  isLoopFinished,
  pruneMessages,
  streamText,
  type TextStreamPart,
  type ToolSet,
  type UIMessage,
  tool,
} from "ai";
import { z } from "zod";
import type { Env, SiteBuilderAgentProps, SnapshotResult } from "../types";
import { isSnapshotSkipped } from "../types";
import { createCailModel, resolveModelId } from "../lib/model";
import { generateImage, runGenerateImageFlow, screenImage } from "../lib/image-generation";
import { PROTECTED_FILE_NAMES } from "../lib/constants";
import { extractDocumentText } from "../lib/document";
import { getContentType, isTextContentType, sanitizeFilePath } from "../lib/path";
import { lintProject } from "../lib/a11y-lint";
import { createBlankIndexHtml, getTemplateFiles, TEMPLATE_IDS } from "../lib/templates";
import { FileExistsError, R2ProjectStorage } from "../storage/r2";
import { SITE_BUILDER_PROMPT } from "../prompts/site-builder";
import { buildProjectContext } from "./project-context";
import { describeModelStreamError } from "../lib/model-stream-error";
import {
  type CailOutcome,
  type CailTerminalReason,
} from "@cuny-ai-lab/cail-log";
import {
  ACTION_ATTEMPT_ADMIN_SCHEMA_VERSION,
  ACTION_ATTEMPT_RETENTION_HOURS,
  ACTION_ATTEMPT_SCHEMA_VERSION,
  type ActionAttemptAdmission,
  type ActionAttemptAdminRead,
  type ActionAttemptTerminal,
  type DurableActionAttempt,
} from "../../../observability-core/src/action-attempt";
import { OBSERVABILITY_CONTRACT } from "../../../observability-core/src/contract";
import {
  SiteStudioActionLifecycle,
  createSiteStudioConnectionLoggingState,
  createSiteStudioLoggingContext,
  createSiteStudioBoundaryLogger,
  emitDiagnostic,
  errorCodeFrom,
  mintCorrelation,
  principalForOperationalSubject,
  serializeSiteStudioLoggingContext,
  type SiteStudioConnectionLoggingState,
  type SiteStudioLoggingContext,
  type SiteStudioLoggingContextData,
  withCorrelationFetch,
} from "../lib/logging";
import { getAgentConnectionIdentityJwt } from "../lib/agent-identity";
import {
  executeOwnerMutation,
  type OwnerMutation,
  type OwnerMutationResult,
} from "../lib/owner-mutations";

export { describeModelStreamError } from "../lib/model-stream-error";

type Scope = {
  userId: string;
  projectId: string;
};

type ChatHandler = AIChatAgent<Env>["onChatMessage"];
type CompatibleReasonByOutcome = Readonly<Record<CailOutcome, ReadonlySet<CailTerminalReason>>>;

type SiteBuilderObservabilityToolCall = {
  toolCallId: string;
  toolName: string;
  state: "input-streaming" | "input-available" | "output-available";
  inputChars: number;
  deltaCount: number;
  startedAt: string;
  updatedAt: string;
};

type SiteBuilderObservabilityRequest = {
  requestId: string;
  status: "streaming" | "finished" | "aborted" | "error";
  model: string;
  startedAt: string;
  updatedAt: string;
  lastChunkAt?: string;
  idleMs: number;
  suspectedStall: boolean;
  projectId: string;
  steps: number;
  chunkCounts: {
    text: number;
    reasoning: number;
    toolInput: number;
    toolResult: number;
    raw: number;
  };
  errorTypes: string[];
  tools: SiteBuilderObservabilityToolCall[];
  finishReason?: string;
  rawFinishReason?: string;
};

type SiteBuilderObservabilityEvent = {
  id: string;
  requestId: string;
  at: string;
  level: "info" | "warn" | "error";
  type: "request-start" | "step-start" | "chunk" | "tool-call" | "tool-result" | "finish" | "abort" | "error";
  detail: string;
  data?: ObservabilityData;
};

type ObservabilityData = Record<string, string | number | boolean | null>;

type MutableDurableActionAttempt = {
  schemaVersion: typeof ACTION_ATTEMPT_SCHEMA_VERSION;
  actionId: string;
  action: "build" | "publish";
  route: string;
  admittedAt: string;
  terminalAt?: string;
  outcome?: CailOutcome;
  reason?: CailTerminalReason;
  durationMs?: number;
  errorType?: string;
};

type SiteBuilderStreamChunk = Extract<
  TextStreamPart<ToolSet>,
  { type: "text-delta" | "reasoning-delta" | "source" | "tool-input-start" | "tool-input-delta" | "tool-call" | "tool-result" | "raw" }
>;

type AgentInitializationProps = Partial<SiteBuilderAgentProps>;

type RequestMessage = {
  role: "system" | "user" | "assistant";
  parts: Array<{ type: string; text?: string }>;
};

export type ProjectStorageLike = Pick<
  R2ProjectStorage,
  "fileExists" | "listFiles" | "readFile" | "readFileWithEtag" | "readFileBuffer"
>;
export type ProjectMutationExecutor = (
  ownerId: string,
  operation: OwnerMutation,
  logging?: SiteStudioLoggingContextData,
) => Promise<OwnerMutationResult>;

export type SiteBuilderObservabilitySnapshot = {
  generatedAt: string;
  actionAttempts: ActionAttemptAdminRead;
  requests: SiteBuilderObservabilityRequest[];
  events: SiteBuilderObservabilityEvent[];
};

type ActionAttemptRow = {
  action_id: string;
  action_kind: "build" | "publish";
  route: string;
  admitted_at: string;
  terminal_at: string | null;
  outcome: CailOutcome | null;
  reason: CailTerminalReason | null;
  duration_ms: number | null;
  error_type: string | null;
};

const MAX_FILE_CONTENT_CHARS = 60_000;
const MAX_DOCUMENT_CONTENT_CHARS = 120_000;
const MAX_SEARCH_RESULTS = 50;
const MAX_SNAPSHOT_LABEL_CHARS = 120;
const MAX_OBSERVABILITY_EVENTS = 400;
const MAX_OBSERVABILITY_REQUESTS = 20;
const OBSERVABILITY_STALL_MS = 15_000;

const connectionStateSchema = z.object({
  correlation: z.object({
    trace_id: z.string(),
    span_id: z.string(),
    trace_flags: z.union([z.literal(0), z.literal(1)]),
    request_id: z.string(),
    tracestate: z.string().optional(),
    trace: z.object({
      trace_id: z.string(),
      span_id: z.string(),
      trace_flags: z.union([z.literal(0), z.literal(1)]),
    }),
  }),
  operationalSubject: z.string().optional(),
  identityJwt: z.string().optional(),
});

const finalObservabilityDataSchema = z.object({
  error_type: z.string().nullable().optional(),
  finishReason: z.string().nullable().optional(),
  rawFinishReason: z.string().nullable().optional(),
});

const requestMessagesSchema = z.array(z.object({
  role: z.enum(["system", "user", "assistant"]),
  parts: z.array(z.object({ type: z.string(), text: z.string().optional() })),
}));
const chatRequestBodySchema = z.object({
  messages: requestMessagesSchema,
  trigger: z.enum(["submit-message", "regenerate-message"]).optional(),
});

function noStoreJson(body: Record<string, string>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
/**
 * Action and call IDs are event identities, not transport request
 * correlations. cail-log's request validator intentionally accepts UUIDv4
 * and UUIDv7; this lifecycle contract remains UUIDv4-only.
 */
export const SITE_STUDIO_EVENT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CODEMODE_DESCRIPTION = `Inspect and modify the current Site Studio project inside a sandboxed Dynamic Worker.

Project APIs:
{{types}}

Write an async arrow function in plain JavaScript. Use the project APIs to read, search, create, edit, rename, delete, and scaffold files. External network access is blocked. Return a short object that summarizes the work, for example:

async () => {
  const files = await project.list_files({});
  return { summary: "Inspected the project", files: files.paths };
}`;

function parseScope(name: string): Scope {
  const separatorIndex = name.indexOf(":");

  if (separatorIndex <= 0 || separatorIndex >= name.length - 1) {
    throw new Error("Invalid agent scope");
  }

  return {
    userId: name.slice(0, separatorIndex),
    projectId: name.slice(separatorIndex + 1)
  };
}

function clipText(text: string, maxChars = MAX_FILE_CONTENT_CHARS) {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  return {
    text: `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} additional characters]`,
    truncated: true
  };
}

function clipPreview(value: string, maxChars = 180): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars - 1)}...`;
}

export function summarizeError(cause: unknown): string {
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`;
  }
  const stringCause = z.string().safeParse(cause);
  if (stringCause.success) {
    return stringCause.data;
  }
  try {
    const serialized = JSON.stringify(cause);
    return serialized === undefined ? String(cause) : clipPreview(serialized);
  } catch {
    return String(cause);
  }
}

function summarizeChunkData(chunk: SiteBuilderStreamChunk): ObservabilityData | undefined {
  switch (chunk.type) {
    case "text-delta":
    case "reasoning-delta":
      return { chars: chunk.text.length };
    case "tool-input-start":
      return {
        toolCallId: chunk.id,
        toolName: chunk.toolName,
      };
    case "tool-input-delta":
      return {
        toolCallId: chunk.id,
        chars: chunk.delta.length,
      };
    case "tool-call":
      {
        const data = {
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          invalid: chunk.invalid ?? null,
        };
        return data;
      }
    case "tool-result":
      return {
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
      };
    case "raw":
      return undefined;
    default:
      return undefined;
  }
}

function simpleGlobToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function createPageHtml(title: string): string {
  const escaped = title
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escaped}</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <main>
    <h1>${escaped}</h1>
    <p>Update this page with your content.</p>
  </main>
</body>
</html>`;
}

type TreeNode = {
  dirs: Record<string, TreeNode>;
  files: string[];
};

function buildTree(paths: string[]): string {
  const root: TreeNode = {
    dirs: {},
    files: []
  };

  for (const filePath of paths) {
    const parts = filePath.split("/");
    let current = root;

    parts.forEach((part, index) => {
      if (index === parts.length - 1) {
        current.files.push(part);
        return;
      }

      current.dirs[part] ||= { dirs: {}, files: [] };
      current = current.dirs[part];
    });
  }

  function lines(node: TreeNode, prefix = ""): string[] {
    const result: string[] = [];

    for (const key of Object.keys(node.dirs).sort()) {
      result.push(`${prefix}${key}/`);
      result.push(...lines(node.dirs[key], `${prefix}  `));
    }

    for (const fileName of node.files.sort()) {
      result.push(`${prefix}${fileName}`);
    }

    return result;
  }

  return lines(root).join("\n");
}

function isTextFile(filePath: string): boolean {
  return isTextContentType(getContentType(filePath));
}

export function summarizeLatestUserRequest(messages: RequestMessage[] | UIMessage[]): string | undefined {
  const parsed = requestMessagesSchema.safeParse(messages);
  if (!parsed.success) return undefined;

  for (let index = parsed.data.length - 1; index >= 0; index -= 1) {
    const message = parsed.data[index];
    if (message.role !== "user") {
      continue;
    }

    const text = message.parts
      .map((part) => {
        return part.type === "text" && part.text !== undefined ? part.text.trim() : "";
      })
      .filter((value) => value.length > 0)
      .join(" ")
      .trim();

    if (!text) {
      continue;
    }

    return text.length > MAX_SNAPSHOT_LABEL_CHARS
      ? `${text.slice(0, MAX_SNAPSHOT_LABEL_CHARS - 1).trimEnd()}...`
      : text;
  }

  return undefined;
}

export function createProjectTools(
  env: Pick<Env, "SITE_STUDIO_BUCKET" | "MUTATION_COORDINATOR" | "SITE_STUDIO_MAX_PROJECT_BYTES" | "SITE_STUDIO_MAX_OWNER_BYTES" | "SITE_STUDIO_UPLOADS_PER_MINUTE" | "CAIL_API_BASE" | "CAIL_MODEL" | "CAIL_IMAGE_MODEL" | "CAIL_IMAGE_CLASSIFIER">,
  scope: Scope,
  identityJwt: string | null,
  snapshotOptions?: {
    label?: string;
    trigger?: "agent";
  },
  fetchImpl?: typeof fetch,
  mutationLifecycle?: Pick<SiteStudioActionLifecycle, "admit" | "acknowledgeMutation">,
  logging?: SiteStudioLoggingContext,
  storageOverride?: ProjectStorageLike,
  mutationExecutor?: ProjectMutationExecutor,
) {
  const serializedLogging = serializeSiteStudioLoggingContext(logging);
  const storage = storageOverride ?? new R2ProjectStorage(env.SITE_STUDIO_BUCKET, logging);
  const executeMutation: ProjectMutationExecutor = mutationExecutor
    ?? ((ownerId, operation, mutationLogging) => executeOwnerMutation(env, ownerId, operation, mutationLogging));
  let snapshotPromise: Promise<SnapshotResult> | null = null;

  async function writeIfAbsent(path: string, content: string): Promise<string | null> {
    const result = await executeMutation(scope.userId, {
      type: "write-file-if-absent",
      projectId: scope.projectId,
      path,
      content
    }, serializedLogging);
    if (!("etag" in result)) throw new Error("Unexpected mutation result");
    return result.etag;
  }

  async function writeIfMatch(path: string, content: string, baseEtag: string): Promise<string | null> {
    const result = await executeMutation(scope.userId, {
      type: "write-file",
      projectId: scope.projectId,
      path,
      content,
      baseEtag
    }, serializedLogging);
    if (!("etag" in result)) throw new Error("Unexpected mutation result");
    return result.etag;
  }

  // SS-28: creating the pre-mutation snapshot is non-fatal. If the project is
  // too large to snapshot (createSnapshot returns a skip signal), the mutation
  // still proceeds — the user just has no restore point for this turn. Make the
  // skip visible via observability (a structured wide event) rather than
  // swallowing it.
  async function ensureSnapshot() {
    if (!snapshotPromise) {
      snapshotPromise = executeMutation(scope.userId, {
        type: "create-snapshot",
        projectId: scope.projectId,
        trigger: snapshotOptions?.trigger || "agent",
        label: snapshotOptions?.label
      }, serializedLogging).then((result) => {
        if (!("snapshot" in result)) throw new Error("Unexpected mutation result");
        return result.snapshot;
      });
    }

    const result = await snapshotPromise;
    if (isSnapshotSkipped(result)) {
      emitDiagnostic("warning", "snapshot_too_large", {}, logging);
    }
  }

  return {
    list_files: tool({
      description: "List all files in the current project as a tree.",
      inputSchema: z.object({
        prefix: z.string().optional().describe("Optional directory prefix to filter by.")
      }),
      outputSchema: z.object({
        count: z.number().describe("Number of files found."),
        tree: z.string().describe("Human-readable directory tree."),
        paths: z.array(z.string()).describe("Flat array of file paths.")
      }),
      execute: async ({ prefix }) => {
        const files = await storage.listFiles(scope.userId, scope.projectId, prefix ? sanitizeFilePath(prefix) : "");
        const paths = files.map((file) => file.path);

        return {
          count: paths.length,
          tree: paths.length > 0 ? buildTree(paths) : "(project is empty)",
          paths
        };
      }
    }),
    read_file: tool({
      description: "Read a text file from the project.",
      inputSchema: z.object({
        path: z.string().min(1).describe("Path to the file relative to the project root.")
      }),
      outputSchema: z.discriminatedUnion("ok", [
        z.object({
          ok: z.literal(true),
          path: z.string().describe("Resolved file path."),
          content: z.string().describe("The text content of the file."),
          truncated: z.boolean().describe("Whether the content was truncated due to size limits.")
        }),
        z.object({
          ok: z.literal(false),
          path: z.string(),
          message: z.string().describe("Error message explaining why the read failed.")
        })
      ]),
      execute: async ({ path }) => {
        const filePath = sanitizeFilePath(path);

        if (!isTextFile(filePath)) {
          return {
            ok: false,
            path: filePath,
            message: "This tool only reads text files. Use extract_document_text for PDFs and other supported documents."
          };
        }

        const content = await storage.readFile(scope.userId, scope.projectId, filePath);
        const clipped = clipText(content);

        return {
          ok: true,
          path: filePath,
          truncated: clipped.truncated,
          content: clipped.text
        };
      }
    }),
    search_files: tool({
      description: "Search text across text files in the project.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Text to search for."),
        filePattern: z.string().optional().describe("Optional simple glob like *.html or content/*.md.")
      }),
      outputSchema: z.object({
        query: z.string(),
        count: z.number().describe("Number of matching lines found."),
        truncated: z.boolean().describe("Whether results were capped at the limit."),
        results: z.array(z.object({
          path: z.string(),
          line: z.number(),
          snippet: z.string()
        })).describe("Matching lines with file path, line number, and trimmed snippet.")
      }),
      execute: async ({ query, filePattern }) => {
        const files = await storage.listFiles(scope.userId, scope.projectId);
        const matcher = filePattern ? simpleGlobToRegExp(filePattern) : null;
        const results: Array<{ path: string; line: number; snippet: string }> = [];

        for (const file of files) {
          if (!isTextFile(file.path)) {
            continue;
          }

          if (matcher && !matcher.test(file.path)) {
            continue;
          }

          const content = await storage.readFile(scope.userId, scope.projectId, file.path);
          const lines = content.split(/\r?\n/);

          lines.forEach((line, index) => {
            if (results.length >= MAX_SEARCH_RESULTS) {
              return;
            }

            if (line.toLowerCase().includes(query.toLowerCase())) {
              results.push({
                path: file.path,
                line: index + 1,
                snippet: line.trim().slice(0, 240)
              });
            }
          });

          if (results.length >= MAX_SEARCH_RESULTS) {
            break;
          }
        }

        return {
          query,
          count: results.length,
          truncated: results.length >= MAX_SEARCH_RESULTS,
          results
        };
      }
    }),
    write_file: tool({
      description: "Create a new text file, fully replace an existing text file, or append more text to an existing file.",
      inputSchema: z.object({
        path: z.string().min(1).describe("Path to write relative to the project root."),
        content: z.string().describe("File content to write."),
        mode: z.enum(["replace", "append"]).optional().default("replace").describe("Replace the full file or append to the end.")
      }),
      outputSchema: z.discriminatedUnion("ok", [
        z.object({
          ok: z.literal(true),
          path: z.string().describe("Resolved file path."),
          created: z.boolean().describe("True if the file was newly created, false if it existed."),
          changed: z.boolean().describe("True if the content actually changed.")
        }),
        z.object({
          ok: z.literal(false),
          path: z.string(),
          message: z.string().describe("Error message explaining why the write failed.")
        })
      ]),
      execute: async ({ path, content, mode }) => {
        const filePath = sanitizeFilePath(path);

        // SS-18: protected system files (.metadata.json, .thumbnail.png) are
        // guarded on delete/rename; guard writes too so the agent can't overwrite
        // .metadata.json and flip published/slug/publishedUrl.
        if (PROTECTED_FILE_NAMES.has(filePath.split("/").pop() || "")) {
          return {
            ok: false,
            path: filePath,
            message: "Protected files cannot be overwritten."
          };
        }

        let current = await storage.readFileWithEtag(scope.userId, scope.projectId, filePath);
        const previousContent = current?.content ?? null;

        const nextContent = mode === "append" && previousContent !== null
          ? `${previousContent}${content}`
          : content;

        if (previousContent === nextContent) {
          return {
            ok: true,
            path: filePath,
            created: previousContent === null,
            changed: false
          };
        }

        mutationLifecycle?.admit();
        await ensureSnapshot();

        // SS-40: creation is put-if-absent and overwrites/appends are CAS. A
        // concurrent writer therefore forces a fresh read and recomputation
        // instead of being silently clobbered by this turn's stale content.
        if (current === null) {
          const createdEtag = await writeIfAbsent(filePath, nextContent);
          if (createdEtag !== null) {
            mutationLifecycle?.acknowledgeMutation();
            return {
              ok: true,
              path: filePath,
              created: true,
              changed: true
            };
          }
          current = await storage.readFileWithEtag(scope.userId, scope.projectId, filePath);
        }

        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (current === null) {
            const createdEtag = await writeIfAbsent(filePath, content);
            if (createdEtag !== null) {
              mutationLifecycle?.acknowledgeMutation();
              return {
                ok: true,
                path: filePath,
                created: true,
                changed: true
              };
            }
            current = await storage.readFileWithEtag(scope.userId, scope.projectId, filePath);
            continue;
          }

          const recomputed = mode === "append"
            ? `${current.content}${content}`
            : content;
          if (current.content === recomputed) {
            return {
              ok: true,
              path: filePath,
              created: false,
              changed: false
            };
          }

          const writtenEtag = await writeIfMatch(filePath, recomputed, current.etag);
          if (writtenEtag !== null) {
            mutationLifecycle?.acknowledgeMutation();
            return {
              ok: true,
              path: filePath,
              created: false,
              changed: true
            };
          }

          current = await storage.readFileWithEtag(scope.userId, scope.projectId, filePath);
        }

        return {
          ok: false,
          path: filePath,
          message: "The file changed during the write; please re-read and retry."
        };
      }
    }),
    edit_file: tool({
      description: "Make a focused exact-text replacement inside an existing text file.",
      inputSchema: z.object({
        path: z.string().min(1).describe("Path to the file relative to the project root."),
        oldText: z.string().min(1).describe("Exact text to replace."),
        newText: z.string().describe("Replacement text."),
        replaceAll: z.boolean().optional().default(false).describe("Replace every occurrence instead of only the first."),
      }),
      outputSchema: z.discriminatedUnion("ok", [
        z.object({
          ok: z.literal(true),
          path: z.string().describe("Resolved file path."),
          replacements: z.number().describe("Number of replacements made.")
        }),
        z.object({
          ok: z.literal(false),
          path: z.string(),
          message: z.string().describe("Error message explaining why the edit failed.")
        })
      ]),
      execute: async ({ path, oldText, newText, replaceAll }) => {
        const filePath = sanitizeFilePath(path);

        if (!isTextFile(filePath)) {
          return {
            ok: false,
            path: filePath,
            message: "This tool only edits text files."
          };
        }

        let current = await storage.readFileWithEtag(scope.userId, scope.projectId, filePath);
        if (!current) {
          return {
            ok: false,
            path: filePath,
            message: "File not found."
          };
        }

        if (!current.content.includes(oldText)) {
          return {
            ok: false,
            path: filePath,
            message: "The target text was not found in the file."
          };
        }

        let updated = replaceAll
          ? current.content.split(oldText).join(newText)
          : current.content.replace(oldText, newText);

        let replacementCount = replaceAll
          ? current.content.split(oldText).length - 1
          : 1;

        if (updated === current.content) {
          return {
            ok: true,
            path: filePath,
            replacements: 0
          };
        }

        mutationLifecycle?.admit();
        await ensureSnapshot();

        for (let attempt = 0; attempt < 3; attempt += 1) {
          const writtenEtag = await writeIfMatch(filePath, updated, current.etag);
          if (writtenEtag !== null) {
            mutationLifecycle?.acknowledgeMutation();
            return {
              ok: true,
              path: filePath,
              replacements: replacementCount
            };
          }

          current = await storage.readFileWithEtag(scope.userId, scope.projectId, filePath);
          if (!current || !current.content.includes(oldText)) {
            return {
              ok: false,
              path: filePath,
              message: "The file changed during editing; re-read it and retry."
            };
          }

          updated = replaceAll
            ? current.content.split(oldText).join(newText)
            : current.content.replace(oldText, newText);
          replacementCount = replaceAll
            ? current.content.split(oldText).length - 1
            : 1;
        }

        return {
          ok: false,
          path: filePath,
          message: "The file kept changing during editing; please retry."
        };
      }
    }),
    rename_file: tool({
      description: "Rename a file or move it to a new path inside the project.",
      inputSchema: z.object({
        oldPath: z.string().min(1).describe("Current file path."),
        newPath: z.string().min(1).describe("New file path.")
      }),
      outputSchema: z.discriminatedUnion("ok", [
        z.object({
          ok: z.literal(true),
          oldPath: z.string(),
          newPath: z.string()
        }),
        z.object({
          ok: z.literal(false),
          path: z.string(),
          message: z.string().describe("Error message explaining why the rename failed.")
        })
      ]),
      execute: async ({ oldPath, newPath }) => {
        const currentPath = sanitizeFilePath(oldPath);
        const nextPath = sanitizeFilePath(newPath);

        if (PROTECTED_FILE_NAMES.has(currentPath.split("/").pop() || "")) {
          return {
            ok: false,
            path: currentPath,
            message: "Protected files cannot be renamed."
          };
        }

        if (!(await storage.fileExists(scope.userId, scope.projectId, currentPath))) {
          return {
            ok: false,
            path: currentPath,
            message: "The source file does not exist."
          };
        }

        if (await storage.fileExists(scope.userId, scope.projectId, nextPath)) {
          return {
            ok: false,
            path: nextPath,
            message: "The destination file already exists."
          };
        }

        mutationLifecycle?.admit();
        await ensureSnapshot();
        // SS-50: the fileExists preflights above are advisory only. renameFile
        // claims the destination atomically; losing that claim means a
        // concurrent write or rename took the destination after the preflight.
        try {
          await executeMutation(scope.userId, {
            type: "rename-file",
            projectId: scope.projectId,
            oldPath: currentPath,
            newPath: nextPath
          }, serializedLogging);
        } catch (error) {
          if (error instanceof FileExistsError || (error instanceof Error && error.message.includes("already exists"))) {
            return {
              ok: false,
              path: nextPath,
              message: "The destination file already exists."
            };
          }
          throw error;
        }

        mutationLifecycle?.acknowledgeMutation();

        return {
          ok: true,
          oldPath: currentPath,
          newPath: nextPath
        };
      }
    }),
    delete_file: tool({
      description: "Delete a file from the project.",
      inputSchema: z.object({
        path: z.string().min(1).describe("Path to delete.")
      }),
      outputSchema: z.discriminatedUnion("ok", [
        z.object({
          ok: z.literal(true),
          path: z.string()
        }),
        z.object({
          ok: z.literal(false),
          path: z.string(),
          message: z.string().describe("Error message explaining why the delete failed.")
        })
      ]),
      execute: async ({ path }) => {
        const filePath = sanitizeFilePath(path);

        if (PROTECTED_FILE_NAMES.has(filePath.split("/").pop() || "")) {
          return {
            ok: false,
            path: filePath,
            message: "Protected files cannot be deleted."
          };
        }

        if (!(await storage.fileExists(scope.userId, scope.projectId, filePath))) {
          return {
            ok: false,
            path: filePath,
            message: "The file does not exist."
          };
        }

        mutationLifecycle?.admit();
        await ensureSnapshot();
        await executeMutation(scope.userId, {
          type: "delete-file",
          projectId: scope.projectId,
          path: filePath
        }, serializedLogging);
        mutationLifecycle?.acknowledgeMutation();

        return {
          ok: true,
          path: filePath
        };
      }
    }),
    scaffold_template: tool({
      description: "Apply a starter template to the project. Use with care because it writes multiple files.",
      inputSchema: z.object({
        templateId: z.enum(TEMPLATE_IDS).describe("Template to apply."),
        replaceExisting: z.boolean().optional().default(false).describe("Whether to replace existing project files.")
      }),
      outputSchema: z.discriminatedUnion("ok", [
        z.object({
          ok: z.literal(true),
          templateId: z.string(),
          filesWritten: z.number().describe("Number of template files written.")
        }),
        z.object({
          ok: z.literal(false),
          message: z.string().describe("Error message explaining why scaffolding failed.")
        })
      ]),
      execute: async ({ templateId, replaceExisting }) => {
        const files = await storage.listFiles(scope.userId, scope.projectId);

        if (files.length > 0 && !replaceExisting) {
          return {
            ok: false,
            message: "The project already has files. Set replaceExisting to true only if the user wants to overwrite them."
          };
        }

        mutationLifecycle?.admit();
        const templateFiles = getTemplateFiles(templateId);
        const replacementFiles = templateFiles ?? {
          "index.html": createBlankIndexHtml(scope.projectId)
        };
        await executeMutation(scope.userId, {
          type: "replace-files",
          projectId: scope.projectId,
          files: replacementFiles,
          label: `Before applying ${templateId} template`
        }, serializedLogging);
        mutationLifecycle?.acknowledgeMutation();
        return { ok: true as const, templateId, filesWritten: Object.keys(replacementFiles).length };
      }
    }),
    add_page: tool({
      description: "Create a new HTML page in the project.",
      inputSchema: z.object({
        path: z.string().min(1).describe("HTML path to create, such as about.html or pages/contact.html."),
        title: z.string().min(1).describe("Page title and heading.")
      }),
      outputSchema: z.discriminatedUnion("ok", [
        z.object({
          ok: z.literal(true),
          path: z.string(),
          title: z.string()
        }),
        z.object({
          ok: z.literal(false),
          path: z.string(),
          message: z.string().describe("Error message explaining why the page was not created.")
        })
      ]),
      execute: async ({ path, title }) => {
        const filePath = sanitizeFilePath(path.endsWith(".html") ? path : `${path}.html`);

        if (await storage.fileExists(scope.userId, scope.projectId, filePath)) {
          return {
            ok: false,
            path: filePath,
            message: "That page already exists."
          };
        }

        mutationLifecycle?.admit();
        await ensureSnapshot();
        const created = await writeIfAbsent(filePath, createPageHtml(title));
        if (created === null) {
          return { ok: false as const, path: filePath, message: "A file already exists at that path." };
        }
        mutationLifecycle?.acknowledgeMutation();

        return {
          ok: true,
          path: filePath,
          title
        };
      }
    }),
    audit_accessibility: tool({
      description: "Run a read-only accessibility and publish-readiness scan over the project's HTML files. Reports issues like missing alt text, filler alt text, placeholder images, missing titles or lang attributes, heading problems, unlabeled form controls, and unsafe target=\"_blank\" links. Does not change any files.",
      inputSchema: z.object({
        prefix: z.string().optional().describe("Optional directory prefix to scope the scan, such as pages/.")
      }),
      outputSchema: z.object({
        count: z.number().describe("Total number of findings across the scanned HTML files."),
        findings: z.array(z.object({
          file: z.string().describe("Project-relative path of the file."),
          line: z.number().nullable().describe("1-based line number where determinable, otherwise null."),
          rule: z.string().describe("Stable kebab-case rule id, such as missing-alt."),
          severity: z.enum(["error", "warning"]).describe("How serious the finding is."),
          message: z.string().describe("Plain-language explanation of the issue and how to fix it.")
        })).describe("The accessibility findings, in file and document order.")
      }),
      execute: async ({ prefix }) => {
        const files = await storage.listFiles(
          scope.userId,
          scope.projectId,
          prefix ? sanitizeFilePath(prefix) : ""
        );
        const htmlFiles: Record<string, string> = {};

        for (const file of files) {
          if (!/\.html?$/i.test(file.path)) {
            continue;
          }
          htmlFiles[file.path] = await storage.readFile(scope.userId, scope.projectId, file.path);
        }

        const findings = lintProject(htmlFiles);

        return {
          count: findings.length,
          findings
        };
      }
    }),
    generate_image: tool({
      description: "Generate an image with AI and save it into the project's images/ folder. Use when the user wants visuals they do not already have. Every generated image passes a required content-safety check before it is saved; rejected images are not written. Agree on descriptive alt text with the user before or right after inserting the image.",
      inputSchema: z.object({
        prompt: z.string().min(1).describe("What to depict. Style guidance (medium, mood, composition) is welcome."),
        filename: z.string().optional().describe("Optional basename for the saved file; sanitized and given an extension matching the image format. Saved under images/."),
        width: z.number().int().optional().describe("Optional width in pixels (default 1024; clamped to a multiple of 64 in [256, 1920])."),
        height: z.number().int().optional().describe("Optional height in pixels (default 1024; clamped to a multiple of 64 in [256, 1920]).")
      }),
      outputSchema: z.discriminatedUnion("ok", [
        z.object({
          ok: z.literal(true),
          path: z.string().describe("Project-relative path of the saved image under images/."),
          message: z.string().describe("Short confirmation for the assistant to relay.")
        }),
        z.object({
          ok: z.literal(false),
          message: z.string().describe("Why the image could not be generated or saved.")
        })
      ]),
      execute: async ({ prompt, filename, width, height }) => {
        // Writes a project file, so snapshot first (mutation, unlike audit_accessibility).
        mutationLifecycle?.admit();
        await ensureSnapshot();

        // Ordering (generate → sniff → gate → save) lives in the extracted,
        // integration-tested flow — keep this body a thin binding.
        const uploadAdmissionId = crypto.randomUUID();
        const result = await runGenerateImageFlow(filename, {
          generate: () => generateImage(env, identityJwt, { prompt, width, height }, fetchImpl),
          screen: (bytes) => screenImage(env, identityJwt, bytes, fetchImpl),
          saveIfAbsent: async (path, bytes) => {
            const saved = await executeMutation(scope.userId, {
              type: "upload-if-absent",
              projectId: scope.projectId,
              path,
              content: bytes,
              admissionId: uploadAdmissionId,
              maxProjectBytes: requiredPositiveInteger(
                env.SITE_STUDIO_MAX_PROJECT_BYTES,
                "SITE_STUDIO_MAX_PROJECT_BYTES"
              ),
              maxOwnerBytes: requiredPositiveInteger(
                env.SITE_STUDIO_MAX_OWNER_BYTES,
                "SITE_STUDIO_MAX_OWNER_BYTES"
              ),
              uploadsPerMinute: requiredPositiveInteger(
                env.SITE_STUDIO_UPLOADS_PER_MINUTE,
                "SITE_STUDIO_UPLOADS_PER_MINUTE"
              )
            }, serializedLogging);
            if (!("written" in saved)) throw new Error("Unexpected mutation result");
            return saved.written;
          }
        });
        if (result.ok) {
          mutationLifecycle?.acknowledgeMutation();
        }
        return result;
      }
    }),
  };
}

function createChatTools(
  env: Env,
  scope: Scope,
  identityJwt: string | null,
  latestUserRequest: string | undefined,
  clientTools?: Parameters<typeof createToolsFromClientSchemas>[0],
  fetchImpl?: typeof fetch,
  mutationLifecycle?: Pick<SiteStudioActionLifecycle, "admit" | "acknowledgeMutation">,
  logging?: SiteStudioLoggingContext,
) {
  const projectTools = createProjectTools(env, scope, identityJwt, {
    trigger: "agent",
    label: latestUserRequest ? `Agent: ${latestUserRequest}` : "Agent changes"
  }, fetchImpl, mutationLifecycle, logging);
  const storage = new R2ProjectStorage(env.SITE_STUDIO_BUCKET, logging);
  const executor = new DynamicWorkerExecutor({
    loader: env.LOADER,
    globalOutbound: null
  });

  return {
    ...createToolsFromClientSchemas(clientTools),
    extract_document_text: tool({
      description: "Extract readable text from a supported uploaded document such as a PDF.",
      inputSchema: z.object({
        path: z.string().min(1).describe("Path to the uploaded document relative to the project root."),
        maxChars: z.number().int().min(1000).max(MAX_DOCUMENT_CONTENT_CHARS).optional().describe("Optional character limit for the extracted text.")
      }),
      outputSchema: z.discriminatedUnion("ok", [
        z.object({
          ok: z.literal(true),
          path: z.string(),
          contentType: z.string(),
          pageCount: z.number().int().nonnegative(),
          title: z.string().optional(),
          author: z.string().optional(),
          content: z.string(),
          truncated: z.boolean(),
          warnings: z.array(z.string())
        }),
        z.object({
          ok: z.literal(false),
          path: z.string(),
          contentType: z.string().optional(),
          message: z.string()
        })
      ]),
      execute: async ({ path, maxChars }) => {
        const filePath = sanitizeFilePath(path);
        const contentType = getContentType(filePath);

        try {
          const data = await storage.readFileBuffer(scope.userId, scope.projectId, filePath);
          const extracted = await extractDocumentText(filePath, data);
          const clipped = clipText(extracted.text, maxChars || MAX_DOCUMENT_CONTENT_CHARS);

          return {
            ok: true as const,
            path: filePath,
            contentType: extracted.contentType,
            pageCount: extracted.pageCount,
            title: extracted.title,
            author: extracted.author,
            content: clipped.text,
            truncated: clipped.truncated,
            warnings: extracted.warnings
          };
        } catch (error) {
          return {
            ok: false as const,
            path: filePath,
            contentType,
            message: summarizeError(error)
          };
        }
      }
    }),
    codemode: createCodeTool({
      tools: [
        {
          name: "project",
          tools: projectTools
        }
      ],
      executor,
      description: CODEMODE_DESCRIPTION
    }),
    ask_user_question: tool({
      description: "Ask the user a single focused follow-up question when a choice would materially change the work.",
      inputSchema: z.object({
        question: z.string().min(1).describe("The question to ask the user."),
        context: z.string().optional().describe("Short explanation of why the answer matters."),
        options: z.array(z.string().min(1)).max(4).optional().describe("Optional short choices to show the user.")
      })
    })
  };
}

export class SiteBuilderAgent extends AIChatAgent<Env> {
  static options = {
    sendIdentityOnConnect: true
  };

  private observabilityEvents: SiteBuilderObservabilityEvent[] = [];
  private observabilityRequests = new Map<string, SiteBuilderObservabilityRequest>();
  private observabilitySequence = 0;
  private buildActionAwaitingPersistence: SiteStudioActionLifecycle | null = null;
  /**
   * Operational subject is deliberately not stored on the Durable Object.
   * Each connection receives the route's middleware-verified subject and JWT
   * through immutable PartyServer state, so missing or rotated values cannot
   * reuse a previous connection's credentials.
   */
  /**
   * Initialization props are intentionally not retained as caller credentials.
   * `onStart` runs once per DO lifetime; the per-connection server-owned props
   * header is read in `onConnect` below instead.
   */
  onStart(_props?: AgentInitializationProps): void {}

  /**
   * Refresh the caller JWT on every new WebSocket connection. The upgrade
   * request carries the middleware-verified token in connection props.
   */
  onConnect(
    connection: Connection<SiteStudioConnectionLoggingState>,
    ctx: ConnectionContext,
  ): void {
    // Adopt the boundary's correlation into per-connection state. A second
    // socket therefore cannot overwrite the trace/request id used by a first
    // socket that is still mid-turn.
    const identityJwt = getAgentConnectionIdentityJwt(ctx.request);
    connection.setState(createSiteStudioConnectionLoggingState(ctx.request, undefined, identityJwt ?? undefined));

  }

  override onRequest(request: Request): Response | Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname.split("/").pop() !== "refresh-credential") {
      return super.onRequest(request);
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: {
          Allow: "POST",
          "Cache-Control": "no-store",
        },
      });
    }

    const identityJwt = getAgentConnectionIdentityJwt(request);
    if (!identityJwt) {
      return noStoreJson({ error: "authentication_required" }, 401);
    }

    // The route has already enforced the verified app identity, project
    // ownership, and CSRF token. Updating every live connection in this one
    // owner/project DO keeps the socket open while replacing only its
    // connection-local (hibernation-safe) model credential; the token is never
    // sent back to the browser.
    const connections = Array.from(this.getConnections<SiteStudioConnectionLoggingState>());
    if (connections.length === 0) {
      return noStoreJson({ error: "agent_connection_not_found" }, 409);
    }

    // Use the framework's updater form rather than replacing raw attachment
    // state. Agents wraps hibernated connections to keep internal `_cf_` flags
    // out of application state; setState's updater preserves those flags while
    // retaining the connection's existing correlation and other fields.
    if (connections.some((connection) => !connection.state)) {
      return noStoreJson({ error: "agent_connection_state_unavailable" }, 409);
    }

    for (const connection of connections) {
      connection.setState((state) => {
        if (!state) {
          // The preflight above makes this unreachable for a live connection;
          // fail closed if a connection disappears between enumeration and the
          // synchronous state update.
          throw new Error("Agent connection state unavailable");
        }
        return {
          ...state,
          identityJwt,
        };
      });
    }

    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });
  }

  async getObservability(): Promise<SiteBuilderObservabilitySnapshot> {
    return this.snapshotObservability();
  }

  /** Durable, owner/project-scoped denominator written before product mutation. */
  recordActionAdmission(admission: ActionAttemptAdmission): void {
    const expectedRoute = OBSERVABILITY_CONTRACT.actions[admission.action]?.route;
    if (
      !SITE_STUDIO_EVENT_ID_RE.test(admission.actionId)
      || admission.route !== expectedRoute
      || !Number.isFinite(Date.parse(admission.admittedAt))
    ) {
      throw new TypeError("invalid Site Studio action admission");
    }
    this.ensureActionAttemptTable();
    const cutoff = new Date(
      Date.parse(admission.admittedAt) - ACTION_ATTEMPT_RETENTION_HOURS * 3_600_000,
    ).toISOString();
    void this.sql`DELETE FROM site_studio_action_attempts WHERE admitted_at < ${cutoff}`;
    void this.sql`
      INSERT INTO site_studio_action_attempts (
        action_id, action_kind, route, admitted_at
      ) VALUES (
        ${admission.actionId}, ${admission.action}, ${admission.route}, ${admission.admittedAt}
      )
    `;
  }

  /** A terminal updates an existing admission; it can never fabricate one. */
  recordActionTerminal(terminal: ActionAttemptTerminal): void {
    if (
      !SITE_STUDIO_EVENT_ID_RE.test(terminal.actionId)
      || !Number.isFinite(Date.parse(terminal.terminalAt))
      || !Number.isFinite(terminal.durationMs)
      || terminal.durationMs < 0
      || (terminal.errorType !== undefined
        && !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(terminal.errorType))
    ) {
      throw new TypeError("invalid Site Studio action terminal");
    }
    this.ensureActionAttemptTable();
    const existing = [...this.sql<ActionAttemptRow>`
      SELECT * FROM site_studio_action_attempts WHERE action_id = ${terminal.actionId}
    `][0];
    if (!existing) throw new TypeError("action terminal requires a durable admission");
    const expectedDuration = Date.parse(terminal.terminalAt) - Date.parse(existing.admitted_at);
    const compatibleReason = {
      ok: new Set<CailTerminalReason>(["completed"]),
      client_error: new Set<CailTerminalReason>(["client_error"]),
      error: new Set<CailTerminalReason>(["application_failure", "upstream_failure"]),
      denied: new Set<CailTerminalReason>(["denied", "quota_blocked", "rate_limited"]),
      cancelled: new Set<CailTerminalReason>(["cancelled"]),
      timeout: new Set<CailTerminalReason>(["timeout"]),
      outcome_unknown: new Set<CailTerminalReason>(["unknown"]),
    } satisfies CompatibleReasonByOutcome;
    if (
      expectedDuration < 0
      || terminal.durationMs !== expectedDuration
      || !compatibleReason[terminal.outcome].has(terminal.reason)
      || (terminal.outcome === "ok" && terminal.errorType !== undefined)
    ) {
      throw new TypeError("action terminal contradicts its durable admission");
    }
    if (existing.terminal_at !== null) {
      const same = existing.terminal_at === terminal.terminalAt
        && existing.outcome === terminal.outcome
        && existing.reason === terminal.reason
        && existing.duration_ms === terminal.durationMs
        && existing.error_type === (terminal.errorType ?? null);
      if (same) return;
      throw new TypeError("action attempt already has a different terminal");
    }
    void this.sql`
      UPDATE site_studio_action_attempts
      SET terminal_at = ${terminal.terminalAt},
          outcome = ${terminal.outcome},
          reason = ${terminal.reason},
          duration_ms = ${terminal.durationMs},
          error_type = ${terminal.errorType ?? null}
      WHERE action_id = ${terminal.actionId}
    `;
  }

  /**
   * Export the persisted chat history for the anonymous-data migration
   * (lib/migration.ts). Called over DO RPC by the main worker only.
   */
  async exportChatHistoryForMigration(): Promise<UIMessage[]> {
    return this.messages;
  }

  /**
   * Import chat history during the anonymous-data migration. Non-destructive:
   * refuses when this instance already has messages of its own. Returns
   * whether the history was imported.
   */
  async importChatHistoryForMigration(messages: UIMessage[]): Promise<boolean> {
    if (this.messages.length > 0) {
      // A retry after a later migration step failed must accept the exact chat
      // it already imported, while still refusing to overwrite different work.
      return JSON.stringify(this.messages) === JSON.stringify(messages);
    }
    await this.saveMessages(messages);
    return true;
  }

  /**
   * Wipe this instance's persisted conversation so a project deleted (or
   * renamed) out from under this DO name cannot resurface if the name is reused.
   * Mirrors the built-in CF_AGENT_CHAT_CLEAR handling using members a subclass
   * can reach.
   */
  async clearChatHistory(): Promise<void> {
    this.resetTurnState();
    void this.sql`delete from cf_ai_chat_agent_messages`;
    this.messages = [];
  }

  /** Complete the build only after AIChatAgent has persisted its response. */
  protected override onChatResponse(result: ChatResponseResult): void {
    const pending = this.buildActionAwaitingPersistence;
    if (!pending) return;
    if (result.status === "completed") {
      pending.completeSuccess();
    } else if (result.status === "aborted") {
      pending.completeFailure({ outcome: "cancelled", reason: "cancelled" });
    } else {
      pending.completeFailure(
        { outcome: "error", reason: "upstream_failure" },
        "chat_response_failed",
      );
    }
    this.buildActionAwaitingPersistence = null;
  }

  async onChatMessage(
    onFinish?: Parameters<ChatHandler>[0],
    options?: Parameters<ChatHandler>[1]
  ) {
    const requestId = options?.requestId ?? "unknown";

    const connection = getCurrentAgent().connection;
    const parsedConnectionState = connection?.state
      ? connectionStateSchema.safeParse(connection.state)
      : null;
    const connectionState = parsedConnectionState?.success ? parsedConnectionState.data : null;
    const correlation = connectionState?.correlation ?? mintCorrelation();
    const identityJwt = connectionState?.identityJwt ?? null;
    const logging = createSiteStudioLoggingContext(
      createSiteStudioBoundaryLogger(this.env),
      {
        correlation,
        operationalSubject: connectionState?.operationalSubject,
      },
    );

    if (!this.env.CAIL_API_BASE) {
      emitDiagnostic("error", "cail_api_base_missing", { status: 500 }, logging);
      return new Response(JSON.stringify({ error: "Site Studio isn't set up correctly right now. Email ailab@gc.cuny.edu." }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    let scope: Scope;
    try {
      scope = parseScope(this.name);
    } catch {
      emitDiagnostic("warning", "invalid_agent_scope", { status: 400 }, logging);
      return new Response(JSON.stringify({ error: "Invalid agent scope" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }
    const scopeLogging = logging;
    const storage = new R2ProjectStorage(this.env.SITE_STUDIO_BUCKET, scopeLogging);

    if (!(await storage.projectExists(scope.userId, scope.projectId))) {
      emitDiagnostic("warning", "project_not_found", {
        status: 404,
      }, scopeLogging);
      return new Response(JSON.stringify({ error: "Project not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }

    const buildAction = new SiteStudioActionLifecycle({
      action: "build",
      principal: principalForOperationalSubject(logging.operationalSubject),
      correlation,
    }, scopeLogging.logger, Date.now, {
      admit: (admission) => this.recordActionAdmission(admission),
      terminal: (terminal) => this.recordActionTerminal(terminal),
    });

    try {
      // Model calls go through the CAIL model proxy (no provider keys here).
      // The verified caller JWT is forwarded so the proxy attributes spend to
      // the CAIL subject; its error envelopes (authentication_required,
      // quota_exceeded, upstream_auth_error, …) surface to the client via the
      // stream unmodified.
      const modelName = resolveModelId(this.env);
      // Correlation propagation: every outbound gateway call (chat completions
      // via the AI SDK, image generation/moderation from the tools) carries
      // this request's traceparent + X-CAIL-Request-Id so spend and upstream
      // errors are followable end to end (browser → worker → DO → gateway).
      const gatewayFetch = withCorrelationFetch(correlation);
      const model = createCailModel(this.env, identityJwt, gatewayFetch);
      const parsedBody = chatRequestBodySchema.safeParse(options?.body);
      const bodyMessages: RequestMessage[] | undefined = parsedBody.success
        ? parsedBody.data.messages
        : undefined;
      const latestUserRequest = (bodyMessages ? summarizeLatestUserRequest(bodyMessages) : undefined)
        || summarizeLatestUserRequest(this.messages);
      const projectFiles = await storage.listFiles(scope.userId, scope.projectId);
      const systemPrompt = `${SITE_BUILDER_PROMPT}\n\n${buildProjectContext(projectFiles)}`;
      const tools = createChatTools(
        this.env,
        scope,
        identityJwt,
        latestUserRequest,
        options?.clientTools,
        gatewayFetch,
        buildAction,
        scopeLogging,
      );

      this.ensureObservabilityRequest(requestId, modelName, scope.projectId);
      this.pushObservabilityEvent(requestId, "request-start", "Chat request started");

      const result = streamText<ToolSet>({
        model,
        // Model POSTs are billed and the gateway does not yet provide
        // execution idempotency. Retrying an uncertain request can run it
        // twice, so fail once and let the user explicitly retry.
        maxRetries: 0,
        stopWhen: isLoopFinished(),
        abortSignal: options?.abortSignal,
        system: systemPrompt,
        messages: pruneMessages({
          messages: await convertToModelMessages(this.messages),
          toolCalls: "before-last-2-messages"
        }),
        tools,
        temperature: 0.2,
        includeRawChunks: true,
        experimental_onStepStart: () => {
          const request = this.ensureObservabilityRequest(requestId, modelName, scope.projectId);
          request.steps += 1;
          this.markObservabilityUpdated(request, false);
          this.pushObservabilityEvent(requestId, "step-start", `Model step ${request.steps} started`, "info");
        },
        onChunk: ({ chunk }) => {
          this.recordChunkObservability(
            requestId,
            modelName,
            scope.projectId,
            chunk
          );
        },
        onFinish: (event) => {
          this.finalizeObservabilityRequest(requestId, "finished", "Chat request finished", {
            finishReason: event.finishReason,
            rawFinishReason: event.rawFinishReason ?? null,
          });
          if (buildAction.wasAdmitted()) {
            this.buildActionAwaitingPersistence = buildAction;
          }
          if (onFinish) {
            onFinish(event);
          }
        },
        onAbort: ({ steps }) => {
          this.finalizeObservabilityRequest(requestId, "aborted", "Chat request aborted", {
            steps: steps.length
          }, "warn");
          buildAction.completeFailure({ outcome: "cancelled", reason: "cancelled" });
          this.buildActionAwaitingPersistence = null;
        },
        onError: (error) => {
          const described = describeModelStreamError(error.error);
          this.finalizeObservabilityRequest(requestId, "error", "streamText reported an error", {
            error_type: described.quota ? "quota_exceeded" : errorCodeFrom(error.error),
          }, "error");
          buildAction.completeFailure(
            described.quota
              ? { outcome: "denied", reason: "quota_blocked" }
              : { outcome: "error", reason: "upstream_failure" },
            described.quota ? "quota_exceeded" : errorCodeFrom(error.error),
          );
          this.buildActionAwaitingPersistence = null;
        }
      });

      return result.toUIMessageStreamResponse({
        onError: (error) => {
          const described = describeModelStreamError(error);
          // SS-44: quota envelopes are expected user-facing failures, distinct
          // from an unknown stream crash, and must survive the UI stream layer.
          this.finalizeObservabilityRequest(requestId, "error", described.quota
            ? "Model quota exhausted"
            : "UI message stream failed", {
            error_type: described.quota ? "quota_exceeded" : errorCodeFrom(error),
          }, "error");
          buildAction.completeFailure(
            described.quota
              ? { outcome: "denied", reason: "quota_blocked" }
              : { outcome: "error", reason: "upstream_failure" },
            described.quota ? "quota_exceeded" : errorCodeFrom(error),
          );
          this.buildActionAwaitingPersistence = null;
          return described.message;
        }
      });
    } catch (error) {
      this.finalizeObservabilityRequest(requestId, "error", "Chat failed before streaming began", {
        error_type: errorCodeFrom(error),
      }, "error");
      buildAction.completeFailure(
        { outcome: "error", reason: "application_failure" },
        errorCodeFrom(error),
      );
      this.buildActionAwaitingPersistence = null;
      return new Response(JSON.stringify({ error: "Failed to process request" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  private snapshotObservability(now = Date.now()): SiteBuilderObservabilitySnapshot {
    const requests = [...this.observabilityRequests.values()]
      .slice(-MAX_OBSERVABILITY_REQUESTS)
      .map((request) => {
        const updatedAtMs = Date.parse(request.updatedAt);
        const idleMs = Number.isFinite(updatedAtMs) ? Math.max(0, now - updatedAtMs) : 0;
        return {
          ...request,
          idleMs,
          suspectedStall: request.status === "streaming" && idleMs >= OBSERVABILITY_STALL_MS,
          tools: request.tools.map((toolCall) => ({ ...toolCall })),
          errorTypes: [...request.errorTypes]
        };
      })
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));

    return {
      generatedAt: new Date(now).toISOString(),
      actionAttempts: this.readActionAttempts(now),
      requests,
      events: [...this.observabilityEvents]
    };
  }

  private ensureActionAttemptTable(): void {
    void this.sql`
      CREATE TABLE IF NOT EXISTS site_studio_action_attempts (
        action_id TEXT PRIMARY KEY,
        action_kind TEXT NOT NULL CHECK (action_kind IN ('build', 'publish')),
        route TEXT NOT NULL,
        admitted_at TEXT NOT NULL,
        terminal_at TEXT,
        outcome TEXT,
        reason TEXT,
        duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
        error_type TEXT
      )
    `;
  }

  private readActionAttempts(now: number): ActionAttemptAdminRead {
    this.ensureActionAttemptTable();
    const cutoff = new Date(now - ACTION_ATTEMPT_RETENTION_HOURS * 3_600_000).toISOString();
    void this.sql`DELETE FROM site_studio_action_attempts WHERE admitted_at < ${cutoff}`;
    const attempts: DurableActionAttempt[] = [...this.sql<ActionAttemptRow>`
      SELECT * FROM site_studio_action_attempts ORDER BY admitted_at DESC
    `].map((row) => {
      const attempt: MutableDurableActionAttempt = {
        schemaVersion: ACTION_ATTEMPT_SCHEMA_VERSION,
        actionId: row.action_id,
        action: row.action_kind,
        route: row.route,
        admittedAt: row.admitted_at,
      };
      if (row.terminal_at !== null) attempt.terminalAt = row.terminal_at;
      if (row.outcome !== null) attempt.outcome = row.outcome;
      if (row.reason !== null) attempt.reason = row.reason;
      if (row.duration_ms !== null) attempt.durationMs = row.duration_ms;
      if (row.error_type !== null) attempt.errorType = row.error_type;
      return attempt;
    });
    return {
      schemaVersion: ACTION_ATTEMPT_ADMIN_SCHEMA_VERSION,
      authoritative: true,
      retentionHours: ACTION_ATTEMPT_RETENTION_HOURS,
      attempts,
    };
  }

  private ensureObservabilityRequest(
    requestId: string,
    model: string,
    projectId: string,
  ): SiteBuilderObservabilityRequest {
    const existing = this.observabilityRequests.get(requestId);
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const request: SiteBuilderObservabilityRequest = {
      requestId,
      status: "streaming",
      model,
      startedAt: now,
      updatedAt: now,
      lastChunkAt: undefined,
      idleMs: 0,
      suspectedStall: false,
      projectId,
      steps: 0,
      chunkCounts: {
        text: 0,
        reasoning: 0,
        toolInput: 0,
        toolResult: 0,
        raw: 0
      },
      errorTypes: [],
      tools: []
    };
    this.observabilityRequests.set(requestId, request);
    while (this.observabilityRequests.size > MAX_OBSERVABILITY_REQUESTS) {
      const oldestKey = this.observabilityRequests.keys().next().value;
      if (!oldestKey) break;
      this.observabilityRequests.delete(oldestKey);
    }
    return request;
  }

  private pushObservabilityEvent(
    requestId: string,
    type: SiteBuilderObservabilityEvent["type"],
    detail: string,
    level: SiteBuilderObservabilityEvent["level"] = "info",
    data?: ObservabilityData
  ) {
    const event: SiteBuilderObservabilityEvent = {
      id: `${Date.now()}-${this.observabilitySequence += 1}`,
      requestId,
      at: new Date().toISOString(),
      level,
      type,
      detail,
    };
    if (data) event.data = data;
    this.observabilityEvents.push(event);
    if (this.observabilityEvents.length > MAX_OBSERVABILITY_EVENTS) {
      this.observabilityEvents.splice(0, this.observabilityEvents.length - MAX_OBSERVABILITY_EVENTS);
    }
  }

  private markObservabilityUpdated(request: SiteBuilderObservabilityRequest, chunk = false) {
    const now = new Date().toISOString();
    request.updatedAt = now;
    if (chunk) {
      request.lastChunkAt = now;
    }
  }

  private getOrCreateToolTrace(
    request: SiteBuilderObservabilityRequest,
    toolCallId: string,
    toolName: string
  ): SiteBuilderObservabilityToolCall {
    const existing = request.tools.find((toolCall) => toolCall.toolCallId === toolCallId);
    if (existing) {
      if (!existing.toolName && toolName) {
        existing.toolName = toolName;
      }
      return existing;
    }

    const now = new Date().toISOString();
    const toolTrace: SiteBuilderObservabilityToolCall = {
      toolCallId,
      toolName,
      state: "input-streaming",
      inputChars: 0,
      deltaCount: 0,
      startedAt: now,
      updatedAt: now
    };
    request.tools.push(toolTrace);
    return toolTrace;
  }

  private recordChunkObservability(
    requestId: string,
    model: string,
    projectId: string,
    chunk: SiteBuilderStreamChunk
  ) {
    const request = this.ensureObservabilityRequest(requestId, model, projectId);
    this.markObservabilityUpdated(request, true);

    switch (chunk.type) {
      case "text-delta":
        request.chunkCounts.text += 1;
        if (request.chunkCounts.text <= 3 || request.chunkCounts.text % 50 === 0) {
          this.pushObservabilityEvent(requestId, "chunk", "Text delta received", "info", summarizeChunkData(chunk));
        }
        break;
      case "reasoning-delta":
        request.chunkCounts.reasoning += 1;
        if (request.chunkCounts.reasoning <= 2 || request.chunkCounts.reasoning % 25 === 0) {
          this.pushObservabilityEvent(requestId, "chunk", "Reasoning delta received", "info", summarizeChunkData(chunk));
        }
        break;
      case "tool-input-start": {
        const toolCallId = chunk.id;
        const toolName = chunk.toolName;
        const toolTrace = this.getOrCreateToolTrace(request, toolCallId, toolName);
        toolTrace.state = "input-streaming";
        toolTrace.updatedAt = new Date().toISOString();
        this.pushObservabilityEvent(requestId, "tool-call", `Tool input started: ${toolName}`, "info", summarizeChunkData(chunk));
        break;
      }
      case "tool-input-delta": {
        request.chunkCounts.toolInput += 1;
        const toolCallId = chunk.id;
        const toolTrace = this.getOrCreateToolTrace(request, toolCallId, "unknown");
        const delta = chunk.delta;
        toolTrace.inputChars += delta.length;
        toolTrace.deltaCount += 1;
        toolTrace.updatedAt = new Date().toISOString();
        const shouldLogProgress = toolTrace.deltaCount <= 3
          || toolTrace.deltaCount % 10 === 0
          || toolTrace.inputChars % 1000 < delta.length;
        if (shouldLogProgress) {
          this.pushObservabilityEvent(requestId, "chunk", `Tool input delta for ${toolTrace.toolName}`, "info", {
            toolCallId,
            deltaChars: delta.length,
            inputChars: toolTrace.inputChars,
            deltaCount: toolTrace.deltaCount,
          });
        }
        break;
      }
      case "tool-call": {
        const toolCallId = chunk.toolCallId;
        const toolName = chunk.toolName;
        const toolTrace = this.getOrCreateToolTrace(request, toolCallId, toolName);
        toolTrace.state = "input-available";
        toolTrace.updatedAt = new Date().toISOString();
        this.pushObservabilityEvent(requestId, "tool-call", `Tool call ready: ${toolName}`, "info", summarizeChunkData(chunk));
        break;
      }
      case "tool-result": {
        request.chunkCounts.toolResult += 1;
        const toolCallId = chunk.toolCallId;
        const toolName = chunk.toolName;
        const toolTrace = this.getOrCreateToolTrace(request, toolCallId, toolName);
        toolTrace.state = "output-available";
        toolTrace.updatedAt = new Date().toISOString();
        this.pushObservabilityEvent(requestId, "tool-result", `Tool result available: ${toolName}`, "info", summarizeChunkData(chunk));
        break;
      }
      case "raw":
        request.chunkCounts.raw += 1;
        if (request.chunkCounts.raw <= 3 || request.chunkCounts.raw % 20 === 0) {
          this.pushObservabilityEvent(requestId, "chunk", "Raw provider chunk received", "info", summarizeChunkData(chunk));
        }
        break;
      default:
        break;
    }
  }

  private finalizeObservabilityRequest(
    requestId: string,
    status: SiteBuilderObservabilityRequest["status"],
    detail: string,
    data?: ObservabilityData,
    level: SiteBuilderObservabilityEvent["level"] = "info"
  ) {
    const request = this.observabilityRequests.get(requestId);
    if (request) {
      request.status = status;
      this.markObservabilityUpdated(request, false);
      const finalData = data ? finalObservabilityDataSchema.safeParse(data) : null;
      if (finalData?.success) {
        if (status === "error" && finalData.data.error_type !== undefined && finalData.data.error_type !== null) {
          request.errorTypes.push(finalData.data.error_type);
        }
        if (finalData.data.finishReason !== undefined && finalData.data.finishReason !== null) {
          request.finishReason = finalData.data.finishReason;
        }
        if (finalData.data.rawFinishReason !== undefined && finalData.data.rawFinishReason !== null) {
          request.rawFinishReason = finalData.data.rawFinishReason;
        }
      }
    }
    this.pushObservabilityEvent(requestId, status === "finished" ? "finish" : status === "aborted" ? "abort" : "error", detail, level, data);
  }
}

callable()(SiteBuilderAgent.prototype.getObservability, {
  kind: "method",
  name: "getObservability",
  static: false,
  private: false,
  access: {
    has: (object: SiteBuilderAgent) => "getObservability" in object,
    get: (object: SiteBuilderAgent) => object.getObservability,
  },
  addInitializer: () => undefined,
  metadata: {},
});
callable()(SiteBuilderAgent.prototype.recordActionAdmission, {
  kind: "method",
  name: "recordActionAdmission",
  static: false,
  private: false,
  access: {
    has: (object: SiteBuilderAgent) => "recordActionAdmission" in object,
    get: (object: SiteBuilderAgent) => object.recordActionAdmission,
  },
  addInitializer: () => undefined,
  metadata: {},
});
callable()(SiteBuilderAgent.prototype.recordActionTerminal, {
  kind: "method",
  name: "recordActionTerminal",
  static: false,
  private: false,
  access: {
    has: (object: SiteBuilderAgent) => "recordActionTerminal" in object,
    get: (object: SiteBuilderAgent) => object.recordActionTerminal,
  },
  addInitializer: () => undefined,
  metadata: {},
});

function requiredPositiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} is not configured`);
  }
  return parsed;
}
