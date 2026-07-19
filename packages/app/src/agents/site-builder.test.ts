import { describe, it, expect } from "vitest";
import { generateTypes } from "@cloudflare/codemode/ai";
import { tool } from "ai";
import { z } from "zod";
import { CailError } from "@cuny-ai-lab/cail-client";
import { buildProjectContext } from "./project-context";
import { describeModelStreamError } from "../lib/model-stream-error";

// We can't easily test the full agent (needs Durable Object runtime),
// but we can verify the tool schemas generate proper types for the LLM.

describe("describeModelStreamError", () => {
  it("finds quota details nested in an AI_RetryError", () => {
    const apiCallError = {
      name: "AI_APICallError",
      message: "Too Many Requests",
      statusCode: 429,
      responseBody: JSON.stringify({
        error: {
          message: "Hourly quota exhausted",
          type: "rate_limit_error",
          param: null,
          code: "quota_exceeded",
          cail: { retry_after_seconds: 3600 },
        },
      }),
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
        responseBody: JSON.stringify({
          error: {
            message: "",
            type: "rate_limit_error",
            param: null,
            code: "quota_exceeded",
            cail: { retry_after_seconds: 3600 },
          },
        }),
      }],
    };

    const described = describeModelStreamError(retryError);

    expect(described.quota).toBe(true);
    expect(described.message).toContain("3600 seconds");
  });

  it("unwraps a CAIL envelope handed over as a bare JSON string", () => {
    const described = describeModelStreamError(JSON.stringify({
      error: {
        message: "You have reached your CAIL usage quota for this period.",
        type: "rate_limit_error",
        param: null,
        code: "quota_exceeded",
        cail: { retry_after_seconds: 900 },
      },
    }));

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
          data: JSON.stringify({
            error: {
              message: "Hourly quota exhausted. It resets on the hour.",
              type: "rate_limit_error",
              param: null,
              code: "quota_exceeded",
            },
          }),
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
    expect(described.message).toBe("Site Studio hit an internal error while streaming this response.");
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

describe("codemode tool type generation", () => {
  it("generates typed output for read_file (discriminated union)", () => {
    const tools = {
      read_file: tool({
        description: "Read a text file.",
        inputSchema: z.object({ path: z.string().min(1) }),
        outputSchema: z.discriminatedUnion("ok", [
          z.object({
            ok: z.literal(true),
            path: z.string(),
            content: z.string(),
            truncated: z.boolean()
          }),
          z.object({
            ok: z.literal(false),
            path: z.string(),
            message: z.string()
          })
        ]),
        execute: async () => ({ ok: true as const, path: "test", content: "hello", truncated: false })
      })
    };

    const types = generateTypes(tools);

    // Should have typed output, not unknown
    expect(types).not.toContain("ReadFileOutput = unknown");
    expect(types).toContain("content: string");
    expect(types).toContain("truncated: boolean");
    expect(types).toContain("ok: true");
    expect(types).toContain("ok: false");
    expect(types).toContain("message: string");
  });

  it("generates typed output for list_files", () => {
    const tools = {
      list_files: tool({
        description: "List files.",
        inputSchema: z.object({ prefix: z.string().optional() }),
        outputSchema: z.object({
          count: z.number(),
          tree: z.string(),
          paths: z.array(z.string())
        }),
        execute: async () => ({ count: 0, tree: "", paths: [] })
      })
    };

    const types = generateTypes(tools);

    expect(types).not.toContain("ListFilesOutput = unknown");
    expect(types).toContain("count: number");
    expect(types).toContain("tree: string");
    expect(types).toContain("paths: string[]");
  });

  it("generates typed output for write_file (discriminated union with SS-18 failure branch)", () => {
    // SS-18: write_file now has a { ok: false, message } branch so it can reject
    // writes to protected system files (.metadata.json, .thumbnail.png), matching
    // delete_file's failure shape.
    const tools = {
      write_file: tool({
        description: "Write a file.",
        inputSchema: z.object({ path: z.string(), content: z.string() }),
        outputSchema: z.discriminatedUnion("ok", [
          z.object({
            ok: z.literal(true),
            path: z.string(),
            created: z.boolean(),
            changed: z.boolean()
          }),
          z.object({
            ok: z.literal(false),
            path: z.string(),
            message: z.string()
          })
        ]),
        execute: async () => ({ ok: true as const, path: "test", created: true, changed: true })
      })
    };

    const types = generateTypes(tools);

    expect(types).not.toContain("WriteFileOutput = unknown");
    expect(types).toContain("created: boolean");
    expect(types).toContain("changed: boolean");
    expect(types).toContain("ok: true");
    expect(types).toContain("ok: false");
    expect(types).toContain("message: string");
  });

  it("generates typed output for search_files", () => {
    const tools = {
      search_files: tool({
        description: "Search files.",
        inputSchema: z.object({ query: z.string() }),
        outputSchema: z.object({
          query: z.string(),
          count: z.number(),
          truncated: z.boolean(),
          results: z.array(z.object({
            path: z.string(),
            line: z.number(),
            snippet: z.string()
          }))
        }),
        execute: async () => ({ query: "test", count: 0, truncated: false, results: [] })
      })
    };

    const types = generateTypes(tools);

    expect(types).not.toContain("SearchFilesOutput = unknown");
    expect(types).toContain("snippet: string");
    expect(types).toContain("line: number");
  });

  it("generates typed output for generate_image (discriminated union)", () => {
    const tools = {
      generate_image: tool({
        description: "Generate an image and save it to images/.",
        inputSchema: z.object({
          prompt: z.string().min(1),
          filename: z.string().optional(),
          width: z.number().int().optional(),
          height: z.number().int().optional()
        }),
        outputSchema: z.discriminatedUnion("ok", [
          z.object({
            ok: z.literal(true),
            path: z.string(),
            message: z.string()
          }),
          z.object({
            ok: z.literal(false),
            message: z.string()
          })
        ]),
        execute: async () => ({ ok: true as const, path: "images/x.png", message: "saved" })
      })
    };

    const types = generateTypes(tools);

    expect(types).not.toContain("GenerateImageOutput = unknown");
    expect(types).toContain("ok: true");
    expect(types).toContain("ok: false");
    expect(types).toContain("path: string");
    expect(types).toContain("message: string");
  });

  it("without outputSchema, generates unknown return type", () => {
    const tools = {
      my_tool: tool({
        description: "A tool without output schema.",
        inputSchema: z.object({ input: z.string() }),
        execute: async () => ({ result: "hello" })
      })
    };

    const types = generateTypes(tools);

    expect(types).toContain("MyToolOutput = unknown");
  });

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
