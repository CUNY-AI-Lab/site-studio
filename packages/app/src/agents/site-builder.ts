import { AIChatAgent, createToolsFromClientSchemas } from "@cloudflare/ai-chat";
import { callable, type Connection, type ConnectionContext } from "agents";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createCodeTool } from "@cloudflare/codemode/ai";
import { convertToModelMessages, pruneMessages, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import type { Env, SiteBuilderAgentProps } from "../types";
import { createCailModel, resolveModelId } from "../lib/model";
import { generateImage, runGenerateImageFlow, screenImage } from "../lib/image-generation";
import { PROTECTED_FILE_NAMES } from "../lib/constants";
import { extractDocumentText } from "../lib/document";
import { getContentType, isTextContentType, sanitizeFilePath } from "../lib/path";
import { lintProject } from "../lib/a11y-lint";
import { createBlankIndexHtml, getTemplateFiles, TEMPLATE_IDS } from "../lib/templates";
import { R2ProjectStorage } from "../storage/r2";
import { SITE_BUILDER_PROMPT } from "../prompts/site-builder";
import { buildProjectContext } from "./project-context";

type Scope = {
  userId: string;
  projectId: string;
};

type ChatHandler = AIChatAgent<Env>["onChatMessage"];

type SiteBuilderObservabilityToolCall = {
  toolCallId: string;
  toolName: string;
  state: "input-streaming" | "input-available" | "output-available";
  inputChars: number;
  deltaCount: number;
  startedAt: string;
  updatedAt: string;
  lastPreview?: string;
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
  latestUserRequest?: string;
  steps: number;
  chunkCounts: {
    text: number;
    reasoning: number;
    toolInput: number;
    toolResult: number;
    raw: number;
  };
  errors: string[];
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
  data?: Record<string, unknown>;
};

type SiteBuilderObservabilitySnapshot = {
  generatedAt: string;
  requests: SiteBuilderObservabilityRequest[];
  events: SiteBuilderObservabilityEvent[];
};

const MAX_FILE_CONTENT_CHARS = 60_000;
const MAX_DOCUMENT_CONTENT_CHARS = 120_000;
const MAX_SEARCH_RESULTS = 50;
const MAX_SNAPSHOT_LABEL_CHARS = 120;
const MAX_OBSERVABILITY_EVENTS = 400;
const MAX_OBSERVABILITY_REQUESTS = 20;
const OBSERVABILITY_STALL_MS = 15_000;
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

function clipText(text: string, maxChars = MAX_FILE_CONTENT_CHARS): { text: string; truncated: boolean } {
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

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return clipPreview(JSON.stringify(error));
  } catch {
    return String(error);
  }
}

function summarizeUnknown(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return clipPreview(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return clipPreview(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function summarizeChunkData(chunk: { type: string } & Record<string, unknown>): Record<string, unknown> | undefined {
  switch (chunk.type) {
    case "text-delta":
    case "reasoning-delta":
      return { chars: typeof chunk.text === "string" ? chunk.text.length : 0 };
    case "tool-input-start":
      return {
        toolCallId: typeof chunk.id === "string" ? chunk.id : undefined,
        toolName: typeof chunk.toolName === "string" ? chunk.toolName : undefined
      };
    case "tool-input-delta":
      return {
        toolCallId: typeof chunk.id === "string" ? chunk.id : undefined,
        chars: typeof chunk.delta === "string" ? chunk.delta.length : 0,
        preview: typeof chunk.delta === "string" ? clipPreview(chunk.delta) : undefined
      };
    case "tool-call":
      return {
        toolCallId: typeof chunk.toolCallId === "string" ? chunk.toolCallId : undefined,
        toolName: typeof chunk.toolName === "string" ? chunk.toolName : undefined,
        invalid: Boolean(chunk.invalid),
        inputPreview: summarizeUnknown(chunk.input)
      };
    case "tool-result":
      return {
        toolCallId: typeof chunk.toolCallId === "string" ? chunk.toolCallId : undefined,
        toolName: typeof chunk.toolName === "string" ? chunk.toolName : undefined,
        outputPreview: summarizeUnknown(chunk.output)
      };
    case "raw":
      return {
        preview: summarizeUnknown(chunk.rawValue)
      };
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

function summarizeLatestUserRequest(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as Record<string, unknown> | null;
    if (!message || message.role !== "user" || !Array.isArray(message.parts)) {
      continue;
    }

    const text = message.parts
      .map((part) => {
        if (!part || typeof part !== "object") {
          return "";
        }

        const candidate = part as Record<string, unknown>;
        return candidate.type === "text" && typeof candidate.text === "string"
          ? candidate.text.trim()
          : "";
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

function createProjectTools(
  env: Env,
  scope: Scope,
  identityJwt: string | null,
  snapshotOptions?: {
    label?: string;
    trigger?: "agent";
  }
) {
  const storage = new R2ProjectStorage(env.SITE_STUDIO_BUCKET);
  let snapshotPromise: Promise<unknown> | null = null;

  async function ensureSnapshot() {
    if (!snapshotPromise) {
      snapshotPromise = storage.createSnapshot(scope.userId, scope.projectId, {
        trigger: snapshotOptions?.trigger || "agent",
        label: snapshotOptions?.label
      });
    }

    await snapshotPromise;
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
      outputSchema: z.object({
        ok: z.literal(true),
        path: z.string().describe("Resolved file path."),
        created: z.boolean().describe("True if the file was newly created, false if it existed."),
        changed: z.boolean().describe("True if the content actually changed.")
      }),
      execute: async ({ path, content, mode }) => {
        const filePath = sanitizeFilePath(path);
        let previousContent: string | null = null;

        if (await storage.fileExists(scope.userId, scope.projectId, filePath)) {
          previousContent = await storage.readFile(scope.userId, scope.projectId, filePath);
        }

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

        await ensureSnapshot();
        await storage.writeFile(scope.userId, scope.projectId, filePath, nextContent);

        return {
          ok: true,
          path: filePath,
          created: previousContent === null,
          changed: previousContent !== nextContent
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

        const existing = await storage.readFile(scope.userId, scope.projectId, filePath);

        if (!existing.includes(oldText)) {
          return {
            ok: false,
            path: filePath,
            message: "The target text was not found in the file."
          };
        }

        const updated = replaceAll
          ? existing.split(oldText).join(newText)
          : existing.replace(oldText, newText);

        const replacementCount = replaceAll
          ? existing.split(oldText).length - 1
          : 1;

        if (updated === existing) {
          return {
            ok: true,
            path: filePath,
            replacements: 0
          };
        }

        await ensureSnapshot();
        await storage.writeFile(scope.userId, scope.projectId, filePath, updated);

        return {
          ok: true,
          path: filePath,
          replacements: replacementCount
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

        await ensureSnapshot();
        await storage.renameFile(scope.userId, scope.projectId, currentPath, nextPath);

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

        await ensureSnapshot();
        await storage.deleteFile(scope.userId, scope.projectId, filePath);

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

        await ensureSnapshot();

        if (replaceExisting) {
          for (const file of files) {
            await storage.deleteFile(scope.userId, scope.projectId, file.path);
          }
        }

        const templateFiles = getTemplateFiles(templateId);
        if (templateFiles) {
          let count = 0;
          for (const [filePath, content] of Object.entries(templateFiles)) {
            await storage.writeFile(scope.userId, scope.projectId, filePath, content);
            count++;
          }
          return { ok: true as const, templateId, filesWritten: count };
        }

        // Fallback for blank if not in bundled templates
        await storage.writeFile(scope.userId, scope.projectId, "index.html", createBlankIndexHtml(scope.projectId));
        return { ok: true as const, templateId, filesWritten: 1 };
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

        await ensureSnapshot();
        await storage.writeFile(scope.userId, scope.projectId, filePath, createPageHtml(title));

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
        width: z.number().int().optional().describe("Optional width in pixels (default 1024; clamped to a multiple of 64 in [64, 2048])."),
        height: z.number().int().optional().describe("Optional height in pixels (default 1024; clamped to a multiple of 64 in [64, 2048]).")
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
        await ensureSnapshot();

        // Ordering (generate → sniff → gate → save) lives in the extracted,
        // integration-tested flow — keep this body a thin binding.
        return runGenerateImageFlow(filename, {
          generate: () => generateImage(env, identityJwt, { prompt, width, height }),
          screen: (bytes) => screenImage(env, identityJwt, bytes),
          fileExists: (path) => storage.fileExists(scope.userId, scope.projectId, path),
          save: (path, bytes) => storage.uploadToProject(scope.userId, scope.projectId, path, bytes)
        });
      }
    }),
  };
}

function createChatTools(
  env: Env,
  scope: Scope,
  identityJwt: string | null,
  latestUserRequest: string | undefined,
  clientTools?: Parameters<typeof createToolsFromClientSchemas>[0]
) {
  const projectTools = createProjectTools(env, scope, identityJwt, {
    trigger: "agent",
    label: latestUserRequest ? `Agent: ${latestUserRequest}` : "Agent changes"
  });
  const storage = new R2ProjectStorage(env.SITE_STUDIO_BUCKET);
  const executor = new DynamicWorkerExecutor({
    loader: env.LOADER,
    globalOutbound: null,
    timeout: 20_000
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

  maxPersistedMessages = 150;
  private observabilityEvents: SiteBuilderObservabilityEvent[] = [];
  private observabilityRequests = new Map<string, SiteBuilderObservabilityRequest>();
  private observabilitySequence = 0;
  /**
   * The verified caller JWT, captured from connection props (routes/agents.ts).
   * Forwarded to the CAIL model proxy on each model call. The browser opens the
   * agent over a long-lived WebSocket, so this is set once at connection time
   * and can outlive the JWT's ~5-min TTL — see the PR flag on JWT freshness.
   */
  private identityJwt: string | null = null;

  /**
   * Capture the caller JWT from connection props on first wake. `onStart` runs
   * once per DO lifetime, so `onConnect` (below) is the per-connection refresh.
   */
  onStart(props?: Record<string, unknown>): void {
    const jwt = props?.identityJwt;
    if (typeof jwt === "string" && jwt) {
      this.identityJwt = jwt;
    }
  }

  /**
   * Refresh the caller JWT on every new WebSocket connection. The upgrade
   * request carries either the gate-injected `X-CAIL-Identity-JWT` directly (the
   * real deployment behind the SSO gate) or the same value forwarded via
   * connection props (`x-partykit-props`, see routes/agents.ts). Either way this
   * binds the freshest identity available at connection time to the instance.
   */
  onConnect(_connection: Connection, ctx: ConnectionContext): void {
    const direct = ctx.request.headers.get("X-CAIL-Identity-JWT");
    if (direct) {
      this.identityJwt = direct;
      return;
    }
    const propsHeader = ctx.request.headers.get("x-partykit-props");
    if (propsHeader) {
      try {
        const parsed = JSON.parse(propsHeader) as SiteBuilderAgentProps;
        if (parsed?.identityJwt) {
          this.identityJwt = parsed.identityJwt;
        }
      } catch {
        // Ignore malformed props; the model call will fail closed at the proxy.
      }
    }
  }

  @callable()
  async getObservability(): Promise<SiteBuilderObservabilitySnapshot> {
    return this.snapshotObservability();
  }

  /**
   * Export the persisted chat history for the anonymous-data migration
   * (lib/migration.ts). Called over DO RPC by the main worker only.
   */
  async exportChatHistoryForMigration(): Promise<unknown[]> {
    return this.messages;
  }

  /**
   * Import chat history during the anonymous-data migration. Non-destructive:
   * refuses when this instance already has messages of its own. Returns
   * whether the history was imported.
   */
  async importChatHistoryForMigration(messages: unknown[]): Promise<boolean> {
    if (this.messages.length > 0) {
      return false; // never overwrite an existing conversation
    }
    await this.saveMessages(messages as typeof this.messages);
    return true;
  }

  async onChatMessage(
    onFinish?: Parameters<ChatHandler>[0],
    options?: Parameters<ChatHandler>[1]
  ) {
    const requestId = options?.requestId ?? "unknown";
    if (!this.env.CAIL_API_BASE) {
      return new Response(JSON.stringify({ error: "CAIL_API_BASE is not configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    let scope: Scope;
    try {
      scope = parseScope(this.name);
    } catch {
      return new Response(JSON.stringify({ error: "Invalid agent scope" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const storage = new R2ProjectStorage(this.env.SITE_STUDIO_BUCKET);

    if (!(await storage.projectExists(scope.userId, scope.projectId))) {
      return new Response(JSON.stringify({ error: "Project not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }

    try {
      // Model calls go through the CAIL model proxy (no provider keys here).
      // The verified caller JWT is forwarded so the proxy attributes spend to
      // the CAIL subject; its error envelopes (authentication_required,
      // quota_exceeded, upstream_auth_error, …) surface to the client via the
      // stream unmodified.
      const modelName = resolveModelId(this.env);
      const model = createCailModel(this.env, this.identityJwt);
      const latestUserRequest = summarizeLatestUserRequest(options?.body?.messages)
        || summarizeLatestUserRequest(this.messages);
      const projectFiles = await storage.listFiles(scope.userId, scope.projectId);
      const systemPrompt = `${SITE_BUILDER_PROMPT}\n\n${buildProjectContext(projectFiles)}`;
      const tools = createChatTools(this.env, scope, this.identityJwt, latestUserRequest, options?.clientTools);

      this.ensureObservabilityRequest(requestId, modelName, scope.projectId, latestUserRequest);
      this.pushObservabilityEvent(requestId, "request-start", "Chat request started", "info", {
        userId: scope.userId,
        projectId: scope.projectId,
        model: modelName,
        latestUserRequest
      });

      const result = streamText({
        model,
        abortSignal: options?.abortSignal,
        system: systemPrompt,
        messages: pruneMessages({
          messages: await convertToModelMessages(this.messages),
          toolCalls: "before-last-2-messages"
        }),
        tools,
        stopWhen: stepCountIs(12),
        temperature: 0.2,
        includeRawChunks: true,
        experimental_onStepStart: () => {
          const request = this.ensureObservabilityRequest(requestId, modelName, scope.projectId, latestUserRequest);
          request.steps += 1;
          this.markObservabilityUpdated(request, false);
          this.pushObservabilityEvent(requestId, "step-start", `Model step ${request.steps} started`, "info");
        },
        onChunk: ({ chunk }) => {
          this.recordChunkObservability(
            requestId,
            modelName,
            scope.projectId,
            latestUserRequest,
            chunk as { type: string } & Record<string, unknown>
          );
        },
        onFinish: (event) => {
          this.finalizeObservabilityRequest(requestId, "finished", "Chat request finished", {
            finishReason: event.finishReason,
            rawFinishReason: event.rawFinishReason,
            totalUsage: event.totalUsage,
            responseId: event.response?.id
          });
          if (onFinish) {
            (onFinish as (event: unknown) => unknown)(event);
          }
        },
        onAbort: ({ steps }) => {
          this.finalizeObservabilityRequest(requestId, "aborted", "Chat request aborted", {
            steps: steps.length
          }, "warn");
        },
        onError: (error) => {
          this.finalizeObservabilityRequest(requestId, "error", "streamText reported an error", {
            error: summarizeError(error.error)
          }, "error");
          console.error("SiteBuilderAgent streamText error", {
            userId: scope.userId,
            projectId: scope.projectId,
            requestId,
            error
          });
        }
      });

      return result.toUIMessageStreamResponse({
        onError: (error) => {
          this.finalizeObservabilityRequest(requestId, "error", "UI message stream failed", {
            error: summarizeError(error)
          }, "error");
          console.error("SiteBuilderAgent chat stream failed", {
            userId: scope.userId,
            projectId: scope.projectId,
            requestId,
            error
          });
          return "Site Studio hit an internal error while streaming this response.";
        }
      });
    } catch (error) {
      this.finalizeObservabilityRequest(requestId, "error", "Chat failed before streaming began", {
        error: summarizeError(error)
      }, "error");
      console.error("Agent streaming error:", {
        userId: scope.userId,
        projectId: scope.projectId,
        requestId,
        error
      });
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
          errors: [...request.errors]
        };
      })
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));

    return {
      generatedAt: new Date(now).toISOString(),
      requests,
      events: [...this.observabilityEvents]
    };
  }

  private ensureObservabilityRequest(
    requestId: string,
    model: string,
    projectId: string,
    latestUserRequest?: string
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
      latestUserRequest,
      steps: 0,
      chunkCounts: {
        text: 0,
        reasoning: 0,
        toolInput: 0,
        toolResult: 0,
        raw: 0
      },
      errors: [],
      tools: []
    };
    this.observabilityRequests.set(requestId, request);
    while (this.observabilityRequests.size > MAX_OBSERVABILITY_REQUESTS) {
      const oldestKey = this.observabilityRequests.keys().next().value as string | undefined;
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
    data?: Record<string, unknown>
  ) {
    const event: SiteBuilderObservabilityEvent = {
      id: `${Date.now()}-${this.observabilitySequence += 1}`,
      requestId,
      at: new Date().toISOString(),
      level,
      type,
      detail,
      ...(data ? { data } : {})
    };
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
    latestUserRequest: string | undefined,
    chunk: { type: string } & Record<string, unknown>
  ) {
    const request = this.ensureObservabilityRequest(requestId, model, projectId, latestUserRequest);
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
        const toolCallId = typeof chunk.id === "string" ? chunk.id : crypto.randomUUID();
        const toolName = typeof chunk.toolName === "string" ? chunk.toolName : "unknown";
        const toolTrace = this.getOrCreateToolTrace(request, toolCallId, toolName);
        toolTrace.state = "input-streaming";
        toolTrace.updatedAt = new Date().toISOString();
        this.pushObservabilityEvent(requestId, "tool-call", `Tool input started: ${toolName}`, "info", summarizeChunkData(chunk));
        break;
      }
      case "tool-input-delta": {
        request.chunkCounts.toolInput += 1;
        const toolCallId = typeof chunk.id === "string" ? chunk.id : "unknown";
        const toolTrace = this.getOrCreateToolTrace(request, toolCallId, "unknown");
        const delta = typeof chunk.delta === "string" ? chunk.delta : "";
        toolTrace.inputChars += delta.length;
        toolTrace.deltaCount += 1;
        toolTrace.updatedAt = new Date().toISOString();
        toolTrace.lastPreview = clipPreview(delta);
        const shouldLogProgress = toolTrace.deltaCount <= 3
          || toolTrace.deltaCount % 10 === 0
          || toolTrace.inputChars % 1000 < delta.length;
        if (shouldLogProgress) {
          this.pushObservabilityEvent(requestId, "chunk", `Tool input delta for ${toolTrace.toolName}`, "info", {
            toolCallId,
            deltaChars: delta.length,
            inputChars: toolTrace.inputChars,
            deltaCount: toolTrace.deltaCount,
            preview: toolTrace.lastPreview
          });
        }
        break;
      }
      case "tool-call": {
        const toolCallId = typeof chunk.toolCallId === "string" ? chunk.toolCallId : "unknown";
        const toolName = typeof chunk.toolName === "string" ? chunk.toolName : "unknown";
        const toolTrace = this.getOrCreateToolTrace(request, toolCallId, toolName);
        toolTrace.state = "input-available";
        toolTrace.updatedAt = new Date().toISOString();
        toolTrace.lastPreview = summarizeUnknown(chunk.input);
        this.pushObservabilityEvent(requestId, "tool-call", `Tool call ready: ${toolName}`, "info", summarizeChunkData(chunk));
        break;
      }
      case "tool-result": {
        request.chunkCounts.toolResult += 1;
        const toolCallId = typeof chunk.toolCallId === "string" ? chunk.toolCallId : "unknown";
        const toolName = typeof chunk.toolName === "string" ? chunk.toolName : "unknown";
        const toolTrace = this.getOrCreateToolTrace(request, toolCallId, toolName);
        toolTrace.state = "output-available";
        toolTrace.updatedAt = new Date().toISOString();
        toolTrace.lastPreview = summarizeUnknown(chunk.output);
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
    data?: Record<string, unknown>,
    level: SiteBuilderObservabilityEvent["level"] = "info"
  ) {
    const request = this.observabilityRequests.get(requestId);
    if (request) {
      request.status = status;
      this.markObservabilityUpdated(request, false);
      if (status === "error" && data?.error) {
        request.errors.push(String(data.error));
      }
      if (typeof data?.finishReason === "string") {
        request.finishReason = data.finishReason;
      }
      if (typeof data?.rawFinishReason === "string") {
        request.rawFinishReason = data.rawFinishReason;
      }
    }
    this.pushObservabilityEvent(requestId, status === "finished" ? "finish" : status === "aborted" ? "abort" : "error", detail, level, data);
  }
}
