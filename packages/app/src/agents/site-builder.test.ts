import { describe, it, expect, vi } from "vitest";
import { CailError } from "@cuny-ai-lab/cail-client";
import { cailErrorEnvelope, quotaExceededEnvelope } from "@cuny-ai-lab/cail-client/testing";
import { buildProjectContext, buildProjectTree } from "./project-context";
import { createProjectTools, type ProjectStorageLike } from "./site-builder";
import { describeModelStreamError } from "../lib/model-stream-error";
import type { StorageFile } from "../types";

describe("describeModelStreamError", () => {
  it("finds quota details nested in an AI_RetryError", () => {
    const apiCallError = {
      name: "AI_APICallError",
      message: "Too Many Requests",
      statusCode: 429,
      responseBody: JSON.stringify(quotaExceededEnvelope({ message: "Hourly quota exhausted" })),
      responseHeaders: {
        "retry-after": "3600",
        "x-request-id": "req-site-retry-wrapper-1",
        "x-should-retry": "false",
      }
    };
    const retryError = {
      name: "AI_RetryError",
      message: "Failed after 3 attempts. Last error: Too Many Requests",
      errors: [apiCallError, apiCallError, apiCallError],
      lastError: apiCallError
    };

    const described = describeModelStreamError(retryError);

    expect(described.quota).toBe(true);
    // The CAIL envelope inside responseBody is JSON-parsed and traversed, so
    // the gateway's verbatim message surfaces instead of the generic fallback.
    expect(described.message).toBe("Hourly quota exhausted");
  });

  it("falls back to retry-after wording when the buried envelope has no message", () => {
    const retryError = {
      name: "AI_RetryError",
      message: "Failed after 3 attempts. Last error: Too Many Requests",
      errors: [{
        name: "AI_APICallError",
        message: "Too Many Requests",
        statusCode: 429,
        responseBody: JSON.stringify(quotaExceededEnvelope({ message: "" })),
      }],
    };

    const described = describeModelStreamError(retryError);

    expect(described.quota).toBe(true);
    expect(described.message).toContain("3600 seconds");
  });

  it("unwraps a CAIL envelope handed over as a bare JSON string", () => {
    const described = describeModelStreamError(JSON.stringify(quotaExceededEnvelope({
      message: "You have reached your CAIL usage quota for this period.",
      retryAfterSeconds: 900,
    })));

    expect(described.quota).toBe(true);
    expect(described.message).toBe("You have reached your CAIL usage quota for this period.");
  });

  it("descends nested errors arrays and string-JSON layers together", () => {
    const wrapped = {
      name: "AI_RetryError",
      message: "Failed after 2 attempts.",
      errors: [
        { name: "AI_APICallError", message: "boom", statusCode: 500 },
        {
          name: "AI_APICallError",
          message: "Too Many Requests",
          status: 429,
          // No `cail` extension block on purpose: the traversal must not
          // require it to recognize a quota envelope.
          data: JSON.stringify(cailErrorEnvelope({
            message: "Hourly quota exhausted. It resets on the hour.",
            type: "rate_limit_error",
            code: "quota_exceeded",
          })),
        },
      ],
    };

    expect(describeModelStreamError(wrapped)).toEqual({
      quota: true,
      message: "Hourly quota exhausted. It resets on the hour.",
    });
  });

  it("keeps the generic message for non-quota stream errors", () => {
    const described = describeModelStreamError({
      name: "AI_RetryError",
      message: "Failed after 1 attempt.",
      errors: [{ name: "AI_APICallError", message: "upstream exploded", statusCode: 500 }],
    });

    expect(described.quota).toBe(false);
    expect(described.message).toBe("The response stopped partway. Send your message again.");
  });

  it("surfaces a thrown CailError's verbatim quota message", () => {
    const verbatim = "You have used your hourly AI quota. It resets on the hour.";
    const cailError = new CailError("quota_exceeded", verbatim, 429, { retry_after_seconds: 1800 });

    expect(describeModelStreamError(cailError)).toEqual({
      quota: true,
      message: verbatim
    });
  });

  it("surfaces the verbatim quota message even when the CailError is wrapped", () => {
    const verbatim = "Hourly quota exhausted.";
    const wrapped = {
      name: "AI_RetryError",
      message: "Failed after 1 attempt.",
      errors: [new CailError("quota_exceeded", verbatim, 429, {})],
    };

    expect(describeModelStreamError(wrapped)).toEqual({
      quota: true,
      message: verbatim
    });
  });
});

describe("project context", () => {
  it("buildProjectContext includes existing files and uploaded documents", () => {
    const context = buildProjectContext([
      {
        path: "index.html",
        name: "index.html",
        size: 100,
        lastModified: "2026-04-01T00:00:00.000Z",
        isDirectory: false,
        contentType: "text/html",
        isText: true
      },
      {
        path: "assets/cv.pdf",
        name: "cv.pdf",
        size: 1000,
        lastModified: "2026-04-01T00:00:00.000Z",
        isDirectory: false,
        contentType: "application/pdf",
        isText: false
      },
      {
        path: "styles.css",
        name: "styles.css",
        size: 200,
        lastModified: "2026-04-01T00:00:00.000Z",
        isDirectory: false,
        contentType: "text/css",
        isText: true
      }
    ]);

    expect(context).toContain("index.html");
    expect(context).toContain("styles.css");
    expect(context).toContain("assets/");
    expect(context).toContain("assets/cv.pdf");
    expect(context).toContain("extract_document_text");
  });
});

describe("project tree", () => {
  it("renders nested directories before sorted flat files", () => {
    expect(buildProjectTree(["b.txt", "a.txt"])).toBe("a.txt\nb.txt");
    expect(buildProjectTree([
      "styles.css",
      "src/z.ts",
      "index.html",
      "src/components/Button.tsx",
      "src/a.ts",
    ])).toBe([
      "src/",
      "  components/",
      "    Button.tsx",
      "  a.ts",
      "  z.ts",
      "index.html",
      "styles.css",
    ].join("\n"));
  });

  it("list_files returns the storage paths and shared tree, including its empty result", async () => {
    const projectFiles: StorageFile[] = [
      {
        path: "components/Button.tsx",
        name: "Button.tsx",
        size: 10,
        lastModified: "2026-01-01T00:00:00.000Z",
        isDirectory: false,
        contentType: "text/typescript",
        isText: true,
      },
      {
        path: "index.ts",
        name: "index.ts",
        size: 10,
        lastModified: "2026-01-01T00:00:00.000Z",
        isDirectory: false,
        contentType: "text/typescript",
        isText: true,
      },
    ];
    const storage: ProjectStorageLike = {
      fileExists: async () => false,
      listFiles: vi.fn(async (_userId: string, _projectId: string, prefix = "") => (
        prefix === "src" ? projectFiles : []
      )),
      readFile: async () => "",
      readFileWithEtag: async () => null,
      readFileBuffer: async () => new Uint8Array(),
    };
    const tools = createProjectTools(
      // SAFETY: list_files uses the injected storage override and never reads the bucket.
      { SITE_STUDIO_BUCKET: {} as R2Bucket },
      { userId: "user-1", projectId: "project-1" },
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      storage,
    );
    if (!tools.list_files.execute) {
      throw new Error("list_files has no execute handler");
    }
    // SAFETY: The list_files execute callback does not inspect the SDK execution context.
    const toolExecutionOptions = undefined as never;

    const nested = await tools.list_files.execute({ prefix: "src" }, toolExecutionOptions);
    expect(nested).toEqual({
      count: 2,
      tree: "components/\n  Button.tsx\nindex.ts",
      paths: ["components/Button.tsx", "index.ts"],
    });
    const empty = await tools.list_files.execute({}, toolExecutionOptions);
    expect(empty).toEqual({ count: 0, tree: "(project is empty)", paths: [] });
    expect(storage.listFiles).toHaveBeenNthCalledWith(1, "user-1", "project-1", "src");
    expect(storage.listFiles).toHaveBeenNthCalledWith(2, "user-1", "project-1", "");
  });
});
