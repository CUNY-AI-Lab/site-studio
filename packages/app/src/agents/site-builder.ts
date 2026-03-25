import { AIChatAgent, createToolsFromClientSchemas } from "@cloudflare/ai-chat";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createCodeTool } from "@cloudflare/codemode/ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { convertToModelMessages, pruneMessages, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import type { Env } from "../types";
import { PROTECTED_FILE_NAMES } from "../lib/constants";
import { getContentType, isTextContentType, sanitizeFilePath } from "../lib/path";
import { createBlankIndexHtml } from "../lib/templates";
import { R2ProjectStorage } from "../storage/r2";
import { SITE_BUILDER_PROMPT } from "../prompts/site-builder";

type Scope = {
  userId: string;
  projectId: string;
};

type ChatHandler = AIChatAgent<Env>["onChatMessage"];

const DEFAULT_MODEL = "anthropic/claude-sonnet-4.6";
const MAX_FILE_CONTENT_CHARS = 60_000;
const MAX_SEARCH_RESULTS = 50;
const MAX_SNAPSHOT_LABEL_CHARS = 120;
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
            message: "This tool only reads text files. Binary file analysis is not implemented in the new app yet."
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
      description: "Create a new text file or fully replace an existing text file.",
      inputSchema: z.object({
        path: z.string().min(1).describe("Path to write relative to the project root."),
        content: z.string().describe("Full file contents.")
      }),
      outputSchema: z.object({
        ok: z.literal(true),
        path: z.string().describe("Resolved file path."),
        created: z.boolean().describe("True if the file was newly created, false if it existed."),
        changed: z.boolean().describe("True if the content actually changed.")
      }),
      execute: async ({ path, content }) => {
        const filePath = sanitizeFilePath(path);
        let previousContent: string | null = null;

        if (await storage.fileExists(scope.userId, scope.projectId, filePath)) {
          previousContent = await storage.readFile(scope.userId, scope.projectId, filePath);
        }

        if (previousContent === content) {
          return {
            ok: true,
            path: filePath,
            created: previousContent === null,
            changed: false
          };
        }

        await ensureSnapshot();
        await storage.writeFile(scope.userId, scope.projectId, filePath, content);

        return {
          ok: true,
          path: filePath,
          created: previousContent === null,
          changed: previousContent !== content
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
        templateId: z.enum(["blank"]).describe("Template to apply."),
        replaceExisting: z.boolean().optional().default(false).describe("Whether to replace existing project files.")
      }),
      outputSchema: z.discriminatedUnion("ok", [
        z.object({
          ok: z.literal(true),
          templateId: z.string()
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

        if (replaceExisting) {
          await ensureSnapshot();
          for (const file of files) {
            await storage.deleteFile(scope.userId, scope.projectId, file.path);
          }
        }

        if (templateId === "blank") {
          if (!replaceExisting) {
            await ensureSnapshot();
          }
          await storage.writeFile(scope.userId, scope.projectId, "index.html", createBlankIndexHtml(scope.projectId));
        }

        return {
          ok: true,
          templateId
        };
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
  };
}

function createChatTools(
  env: Env,
  scope: Scope,
  latestUserRequest: string | undefined,
  clientTools?: Parameters<typeof createToolsFromClientSchemas>[0]
) {
  const projectTools = createProjectTools(env, scope, {
    trigger: "agent",
    label: latestUserRequest ? `Agent: ${latestUserRequest}` : "Agent changes"
  });
  const executor = new DynamicWorkerExecutor({
    loader: env.LOADER,
    globalOutbound: null,
    timeout: 20_000
  });

  return {
    ...createToolsFromClientSchemas(clientTools),
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

  async onChatMessage(
    onFinish?: Parameters<ChatHandler>[0],
    options?: Parameters<ChatHandler>[1]
  ) {
    if (!this.env.OPENROUTER_API_KEY) {
      return new Response(JSON.stringify({ error: "OPENROUTER_API_KEY is not configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    const scope = parseScope(this.name);
    const storage = new R2ProjectStorage(this.env.SITE_STUDIO_BUCKET);

    if (!(await storage.projectExists(scope.userId, scope.projectId))) {
      return new Response(JSON.stringify({ error: "Project not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }

    const provider = createOpenRouter({ apiKey: this.env.OPENROUTER_API_KEY });
    const model = provider(this.env.OPENROUTER_MODEL || DEFAULT_MODEL);
    const latestUserRequest = summarizeLatestUserRequest(options?.body?.messages)
      || summarizeLatestUserRequest(this.messages);
    const tools = createChatTools(this.env, scope, latestUserRequest, options?.clientTools);

    const result = streamText({
      model,
      system: SITE_BUILDER_PROMPT,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages"
      }),
      tools,
      stopWhen: stepCountIs(12),
      temperature: 0.2,
      ...(onFinish ? { onFinish: onFinish as never } : {})
    });

    return result.toUIMessageStreamResponse();
  }
}
