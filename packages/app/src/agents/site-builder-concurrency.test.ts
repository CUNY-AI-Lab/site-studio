import { beforeEach, describe, expect, it, vi } from "vitest";
import { quotaExceededEnvelope } from "@cuny-ai-lab/cail-client/testing";

const storage = vi.hoisted(() => ({
  createSnapshot: vi.fn(),
  fileExists: vi.fn(),
  readFileWithEtag: vi.fn(),
  renameFile: vi.fn(),
  writeFileIfAbsent: vi.fn(),
  writeFileIfMatch: vi.fn()
}));

vi.mock("agents", () => ({
  callable: () => () => undefined
}));

vi.mock("@cloudflare/ai-chat", () => ({
  AIChatAgent: class {},
  createToolsFromClientSchemas: () => ({})
}));

vi.mock("@cloudflare/codemode", () => ({
  DynamicWorkerExecutor: class {}
}));

// Keep the real error classes (FileExistsError etc.) so the `instanceof`
// checks in site-builder.ts and the mocks here share the genuine exports.
vi.mock("../storage/r2", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../storage/r2")>()),
  R2ProjectStorage: class {
    constructor() {
      return storage;
    }
  }
}));

import { FileExistsError } from "../storage/r2";
import {
  createProjectTools,
  describeModelStreamError,
  summarizeError
} from "./site-builder";

function projectTool(name: "edit_file" | "write_file" | "rename_file") {
  const mutationStub = {
    execute: async (_ownerId: string, operation: any) => {
      switch (operation.type) {
        case "create-snapshot": return { snapshot: await storage.createSnapshot("user-1", "project-1", operation) };
        case "write-file-if-absent": return {
          etag: await storage.writeFileIfAbsent("user-1", "project-1", operation.path, operation.content)
        };
        case "write-file": return {
          etag: await storage.writeFileIfMatch(
            "user-1",
            "project-1",
            operation.path,
            operation.content,
            operation.baseEtag
          )
        };
        case "rename-file":
          await storage.renameFile("user-1", "project-1", operation.oldPath, operation.newPath);
          return { ok: true };
        default: throw new Error(`Unexpected mutation ${operation.type}`);
      }
    }
  };
  const tools = createProjectTools(
    {
      SITE_STUDIO_BUCKET: {} as R2Bucket,
      MUTATION_COORDINATOR: {
        idFromName: () => ({}) as DurableObjectId,
        get: () => mutationStub
      }
    } as any,
    { userId: "user-1", projectId: "project-1" },
    null
  );
  return tools[name] as unknown as {
    execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
}

describe("Site Builder file write concurrency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storage.createSnapshot.mockResolvedValue({
      id: "snapshot-1",
      createdAt: "2026-07-09T00:00:00.000Z",
      projectId: "project-1",
      trigger: "agent",
      fileCount: 1
    });
  });

  it("SS-40: edit_file reapplies an exact replacement after a concurrent write", async () => {
    storage.readFileWithEtag
      .mockResolvedValueOnce({ content: "hello world", etag: "etag-1" })
      .mockResolvedValueOnce({ content: "prefix hello world", etag: "etag-2" });
    storage.writeFileIfMatch
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("etag-3");

    const result = await projectTool("edit_file").execute({
      path: "index.html",
      oldText: "hello",
      newText: "hi",
      replaceAll: false
    });

    expect(result).toEqual({
      ok: true,
      path: "index.html",
      replacements: 1
    });
    expect(storage.writeFileIfMatch).toHaveBeenNthCalledWith(
      1,
      "user-1",
      "project-1",
      "index.html",
      "hi world",
      "etag-1"
    );
    expect(storage.writeFileIfMatch).toHaveBeenNthCalledWith(
      2,
      "user-1",
      "project-1",
      "index.html",
      "prefix hi world",
      "etag-2"
    );
    expect(storage.createSnapshot).toHaveBeenCalledOnce();
  });

  it("SS-40: edit_file returns a conflict when the target disappears during retry", async () => {
    storage.readFileWithEtag
      .mockResolvedValueOnce({ content: "hello world", etag: "etag-1" })
      .mockResolvedValueOnce({ content: "concurrent rewrite", etag: "etag-2" });
    storage.writeFileIfMatch.mockResolvedValueOnce(null);

    const result = await projectTool("edit_file").execute({
      path: "index.html",
      oldText: "hello",
      newText: "hi",
      replaceAll: false
    });

    expect(result).toEqual({
      ok: false,
      path: "index.html",
      message: "The file changed during editing; re-read it and retry."
    });
    expect(storage.writeFileIfMatch).toHaveBeenCalledOnce();
  });

  it("SS-40: write_file recomputes append content after a concurrent write", async () => {
    storage.readFileWithEtag
      .mockResolvedValueOnce({ content: "A", etag: "etag-1" })
      .mockResolvedValueOnce({ content: "AB", etag: "etag-2" });
    storage.writeFileIfMatch
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("etag-3");

    const result = await projectTool("write_file").execute({
      path: "notes.txt",
      content: "C",
      mode: "append"
    });

    expect(result).toEqual({
      ok: true,
      path: "notes.txt",
      created: false,
      changed: true
    });
    expect(storage.writeFileIfMatch).toHaveBeenNthCalledWith(
      1,
      "user-1",
      "project-1",
      "notes.txt",
      "AC",
      "etag-1"
    );
    expect(storage.writeFileIfMatch).toHaveBeenNthCalledWith(
      2,
      "user-1",
      "project-1",
      "notes.txt",
      "ABC",
      "etag-2"
    );
    expect(storage.createSnapshot).toHaveBeenCalledOnce();
  });

  it("SS-50: rename_file surfaces a lost destination claim as a tool conflict, not a throw", async () => {
    // Preflights pass — source exists, destination looks free — but the atomic
    // claim inside renameFile loses to a concurrent write of the destination.
    storage.fileExists
      .mockResolvedValueOnce(true) // source exists
      .mockResolvedValueOnce(false); // destination advisory probe: still free
    storage.renameFile.mockRejectedValueOnce(new FileExistsError("new.html"));

    const result = await projectTool("rename_file").execute({
      oldPath: "old.html",
      newPath: "new.html"
    });

    expect(result).toEqual({
      ok: false,
      path: "new.html",
      message: "The destination file already exists."
    });
    expect(storage.renameFile).toHaveBeenCalledWith("user-1", "project-1", "old.html", "new.html");
  });
});

describe("describeModelStreamError", () => {
  it("SS-44: identifies a quota response and includes Retry-After", () => {
    const described = describeModelStreamError({
      statusCode: 429,
      responseBody: JSON.stringify(quotaExceededEnvelope({ message: "Daily quota exhausted", retryAfterSeconds: 60 })),
      responseHeaders: {
        "retry-after": "60",
        "x-request-id": "req-site-concurrency-quota-1",
        "x-should-retry": "false",
      }
    });

    expect(described.quota).toBe(true);
    // The envelope buried in responseBody is JSON-parsed, so the gateway's
    // verbatim message wins over the generic usage-limit fallback.
    expect(described.message).toBe("Daily quota exhausted");
  });

  it("SS-44: identifies a nested quota error", () => {
    expect(describeModelStreamError({
      cause: { statusCode: 429, responseBody: "quota_exceeded" }
    })).toMatchObject({ quota: true });
  });

  it("SS-44: keeps the generic response for an unrelated error", () => {
    expect(describeModelStreamError(new Error("boom"))).toEqual({
      quota: false,
      message: "Site Studio hit an internal error while streaming this response."
    });
  });
});

describe("summarizeError", () => {
  it("SS-45: omits AI_APICallError request bodies from the log summary", () => {
    const error = Object.assign(new Error("boom"), {
      name: "AI_APICallError",
      requestBodyValues: { messages: ["SECRET-PDF-TEXT"] }
    });

    const summary = summarizeError(error);

    expect(summary).toBe("AI_APICallError: boom");
    expect(summary).not.toContain("SECRET-PDF-TEXT");
  });
});
