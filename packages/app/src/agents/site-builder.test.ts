import { describe, it, expect } from "vitest";
import { generateTypes } from "@cloudflare/codemode/ai";
import { tool } from "ai";
import { z } from "zod";

// We can't easily test the full agent (needs Durable Object runtime),
// but we can verify the tool schemas generate proper types for the LLM.

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

  it("generates typed output for write_file", () => {
    const tools = {
      write_file: tool({
        description: "Write a file.",
        inputSchema: z.object({ path: z.string(), content: z.string() }),
        outputSchema: z.object({
          ok: z.literal(true),
          path: z.string(),
          created: z.boolean(),
          changed: z.boolean()
        }),
        execute: async () => ({ ok: true as const, path: "test", created: true, changed: true })
      })
    };

    const types = generateTypes(tools);

    expect(types).not.toContain("WriteFileOutput = unknown");
    expect(types).toContain("created: boolean");
    expect(types).toContain("changed: boolean");
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
});
