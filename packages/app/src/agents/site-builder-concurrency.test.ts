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
  callable: () => () => undefined,
  getCurrentAgent: () => ({ connection: undefined }),
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
  SiteBuilderAgent,
  SITE_STUDIO_EVENT_ID_RE,
  summarizeError
} from "./site-builder";
import {
  createSiteStudioLoggingContext,
  serializeSiteStudioLoggingContext,
  SITE_STUDIO_VERIFIED_OPERATIONAL_SUBJECT_HEADER,
  type SiteStudioCorrelation,
  type SiteStudioConnectionLoggingState,
} from "../lib/logging";
import { SITE_STUDIO_AGENT_PROPS_HEADER } from "../lib/agent-identity";

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

describe("Site Builder event ID contract", () => {
  const UUID_V4 = "11111111-1111-4111-8111-111111111111";
  const UUID_V7 = "019f8bdc-342a-76e1-ba71-005d69808f86";

  it("accepts UUIDv4 and rejects UUIDv7 for action and call identities", () => {
    for (const field of ["action_id", "call_id"] as const) {
      expect(SITE_STUDIO_EVENT_ID_RE.test(UUID_V4), `${field} UUIDv4`).toBe(true);
      expect(SITE_STUDIO_EVENT_ID_RE.test(UUID_V7), `${field} UUIDv7`).toBe(false);
    }
  });

  it("uses the strict event-ID contract before touching durable action state", () => {
    const sql = vi.fn(() => []);
    const agent = Object.create(SiteBuilderAgent.prototype) as SiteBuilderAgent;
    (agent as unknown as { sql: typeof sql }).sql = sql;

    expect(() => agent.recordActionAdmission({
      actionId: UUID_V4,
      action: "build",
      route: "/api/agents/site-builder/{project_id}",
      admittedAt: "2026-08-02T00:00:00.000Z",
    })).not.toThrow();
    expect(sql).toHaveBeenCalledTimes(3);

    sql.mockClear();
    expect(() => agent.recordActionAdmission({
      actionId: UUID_V7,
      action: "build",
      route: "/api/agents/site-builder/{project_id}",
      admittedAt: "2026-08-02T00:00:00.000Z",
    })).toThrow("invalid Site Studio action admission");
    expect(sql).not.toHaveBeenCalled();

    expect(() => agent.recordActionTerminal({
      actionId: UUID_V7,
      outcome: "cancelled",
      reason: "cancelled",
      terminalAt: "2026-08-02T00:00:01.000Z",
      durationMs: 1_000,
    })).toThrow("invalid Site Studio action terminal");
    expect(sql).not.toHaveBeenCalled();
  });
});

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

describe("Site Builder connection logging concurrency", () => {
  function fakeConnection() {
    let current: SiteStudioConnectionLoggingState | null = null;
    return {
      get state() {
        return current;
      },
      setState(next: SiteStudioConnectionLoggingState | null) {
        current = next;
        return current;
      },
    } as unknown as Parameters<SiteBuilderAgent["onConnect"]>[0];
  }

  it("retains socket A while missing and changed subjects clear/isolate later sockets", () => {
    const subjectA = "cail-v1-0123456789abcdef0123456789abcdef";
    const subjectB = "cail-v1-fedcba9876543210fedcba9876543210";
    const jwtA = "verified-jwt-a";
    const jwtB = "verified-jwt-b";
    const requestA = new Request("https://site-studio.example/agent", {
      headers: {
        traceparent: `00-${"1".repeat(32)}-aaaaaaaaaaaaaaaa-01`,
        "x-cail-request-id": "11111111-1111-4111-8111-111111111111",
        [SITE_STUDIO_VERIFIED_OPERATIONAL_SUBJECT_HEADER]: subjectA,
        [SITE_STUDIO_AGENT_PROPS_HEADER]: JSON.stringify({ identityJwt: jwtA }),
      },
    });
    const requestB = new Request("https://site-studio.example/agent", {
      headers: {
        traceparent: `00-${"2".repeat(32)}-bbbbbbbbbbbbbbbb-01`,
        "x-cail-request-id": "22222222-2222-4222-8222-222222222222",
      },
    });
    const requestC = new Request("https://site-studio.example/agent", {
      headers: {
        traceparent: `00-${"3".repeat(32)}-cccccccccccccccc-01`,
        "x-cail-request-id": "33333333-3333-4333-8333-333333333333",
        [SITE_STUDIO_VERIFIED_OPERATIONAL_SUBJECT_HEADER]: subjectB,
        [SITE_STUDIO_AGENT_PROPS_HEADER]: JSON.stringify({ identityJwt: jwtB }),
      },
    });
    const agent = Object.create(SiteBuilderAgent.prototype) as SiteBuilderAgent;
    // A subject in initialization props must not become a DO-wide fallback.
    agent.onStart({ identityJwt: jwtA, operationalSubject: subjectA });
    const connectionA = fakeConnection();
    const connectionB = fakeConnection();
    const connectionC = fakeConnection();

    agent.onConnect(connectionA, { request: requestA });
    const retainedA = connectionA.state;
    agent.onConnect(connectionB, { request: requestB });
    agent.onConnect(connectionC, { request: requestC });

    expect(retainedA).toMatchObject({
      correlation: {
        trace_id: "1".repeat(32),
        request_id: "11111111-1111-4111-8111-111111111111",
      },
      operationalSubject: subjectA,
      identityJwt: jwtA,
    });
    expect(connectionA.state).toEqual(retainedA);
    expect(connectionB.state).toMatchObject({
      correlation: {
        trace_id: "2".repeat(32),
        request_id: "22222222-2222-4222-8222-222222222222",
      },
    });
    expect(connectionB.state?.operationalSubject).toBeUndefined();
    expect(connectionB.state?.identityJwt).toBeUndefined();
    expect(connectionC.state).toMatchObject({
      correlation: {
        trace_id: "3".repeat(32),
        request_id: "33333333-3333-4333-8333-333333333333",
      },
      operationalSubject: subjectB,
      identityJwt: jwtB,
    });
    expect(connectionA.state).not.toBe(connectionB.state);
    expect(connectionB.state).not.toBe(connectionC.state);
    expect(Object.isFrozen(connectionA.state)).toBe(true);
    expect(Object.isFrozen(connectionB.state)).toBe(true);
    expect(Object.isFrozen(connectionC.state)).toBe(true);
  });

  it("clones and deeply freezes caller correlation snapshots", () => {
    const callerCorrelation = {
      trace_id: "a".repeat(32),
      span_id: "b".repeat(16),
      trace_flags: 1 as const,
      request_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    };
    const logger = {
      emit: () => undefined,
    } as never;
    const context = createSiteStudioLoggingContext(logger, {
      correlation: callerCorrelation,
    });
    const snapshot = context.correlation as SiteStudioCorrelation;

    expect(snapshot).not.toBe(callerCorrelation);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.trace)).toBe(true);
    callerCorrelation.trace_id = "c".repeat(32);
    expect(snapshot.trace_id).toBe("a".repeat(32));

    const serialized = serializeSiteStudioLoggingContext(context);
    expect(serialized?.correlation).not.toBe(snapshot);
    expect(Object.isFrozen(serialized?.correlation)).toBe(true);
    expect(Object.isFrozen((serialized?.correlation as SiteStudioCorrelation).trace)).toBe(true);
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

  it("does not misclassify a bare provider 429 as CAIL quota", () => {
    expect(describeModelStreamError({
      cause: { statusCode: 429, responseBody: "quota_exceeded" }
    })).toEqual({
      quota: false,
      message: "Site Studio hit an internal error while streaming this response."
    });
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
