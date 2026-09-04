import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatResponseResult } from "@cloudflare/ai-chat";
import {
  CAIL_ANALYTICS_ENGINE_BLOBS,
  type CailAnalyticsEngineDataPoint,
} from "@cuny-ai-lab/cail-log";
import { quotaExceededEnvelope } from "@cuny-ai-lab/cail-client/testing";
import { z } from "zod";
import type { OwnerMutation, OwnerMutationResult } from "../lib/owner-mutations";
import { FileExistsError } from "../storage/r2";
import {
  createProjectTools,
  describeModelStreamError,
  SiteBuilderAgent,
  SITE_STUDIO_CHAT_CANCELLED_TYPE,
  SITE_STUDIO_CHAT_COMMITTED_TYPE,
  SITE_STUDIO_CHAT_INVALIDATED_TYPE,
  SITE_STUDIO_CANCEL_TURN_TYPE,
  SITE_STUDIO_EVENT_ID_RE,
  summarizeError,
  type ProjectStorageLike,
} from "./site-builder";
import {
  createSiteStudioConnectionLoggingState,
  createSiteStudioLoggingContext,
  createSiteStudioLogger,
  serializeSiteStudioLoggingContext,
  SITE_STUDIO_VERIFIED_OPERATIONAL_SUBJECT_HEADER,
  SITE_STUDIO_EVENTS,
  type SiteStudioCorrelation,
  type SiteStudioConnectionLoggingState,
  type SiteStudioLoggingContextData,
} from "../lib/logging";
import { SITE_STUDIO_AGENT_PROPS_HEADER } from "../lib/agent-identity";

const storage = vi.hoisted(() => ({
  createSnapshot: vi.fn(),
  fileExists: vi.fn(),
  listFiles: vi.fn(),
  readFile: vi.fn(),
  readFileWithEtag: vi.fn(),
  readFileBuffer: vi.fn(),
  renameFile: vi.fn(),
  writeFileIfAbsent: vi.fn(),
  writeFileIfMatch: vi.fn()
}));

function projectTool(name: "edit_file" | "write_file" | "rename_file") {
  const mutationStub = {
    execute: async (_ownerId: string, operation: OwnerMutation, _logging?: SiteStudioLoggingContextData): Promise<OwnerMutationResult> => {
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
    },
    migrateAnonymous: async () => {
      throw new Error("migration is not part of this fixture");
    },
  };
  const testEnv = {
    // SAFETY: Project tools use the injected storage and mutation executor;
    // the bucket is an unused binding in these tests.
    SITE_STUDIO_BUCKET: {} as R2Bucket,
  };
  const tools = createProjectTools(
    testEnv,
    { userId: "user-1", projectId: "project-1" },
    null,
    undefined,
    undefined,
    undefined,
    undefined,
    storage satisfies ProjectStorageLike,
    (ownerId, operation, logging) => mutationStub.execute(ownerId, operation, logging),
  );
type ProjectTool = {
    execute: (input: Record<string, string | boolean>) => Promise<{
      ok: boolean;
      path?: string;
      message?: string;
      replacements?: number;
      created?: boolean;
      changed?: boolean;
    }>;
  };
  const projectToolResultSchema = z.object({
    ok: z.boolean(),
    path: z.string().optional(),
    message: z.string().optional(),
    replacements: z.number().optional(),
    created: z.boolean().optional(),
    changed: z.boolean().optional(),
  });
  const tool = tools[name];
  if (!tool.execute) throw new Error(`Tool ${name} has no execute handler`);
  return {
    execute: async (input: Record<string, string | boolean>) => {
      // SAFETY: The test inputs are the Zod schemas owned by the requested
      // named tool; the SDK erases that concrete input type on the union.
      // SAFETY: Tool execution options are unused by these deterministic
      // project mutations; the SDK's erased second argument is intentionally
      // absent at this unit boundary.
      const result = await tool.execute(input as never, undefined as never);
      return projectToolResultSchema.parse(result);
    },
  } satisfies ProjectTool;
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
    // SAFETY: This unit test calls the class's durable SQL methods with a
    // controlled fake SQL tag; no constructor/runtime bindings are needed.
    const agent = Object.assign(Object.create(SiteBuilderAgent.prototype), { sql }) as SiteBuilderAgent;

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

    expect(() => agent.recordActionAdmission({
      actionId: UUID_V4,
      action: "build",
      route: "/api/agents/site-builder/{project_id}",
      admittedAt: "2026-08-02",
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

    expect(() => agent.recordActionTerminal({
      actionId: UUID_V4,
      outcome: "error",
      reason: "application_failure",
      terminalAt: "2026-08-02T00:00:01.000Z",
      durationMs: 1_000,
      errorType: "Uppercase",
    })).toThrow("invalid Site Studio action terminal");
    expect(sql).not.toHaveBeenCalled();

    expect(() => agent.recordActionTerminal({
      actionId: UUID_V4,
      outcome: "error",
      reason: "completed",
      terminalAt: "2026-08-02T00:00:01.000Z",
      durationMs: 1_000,
    })).toThrow("action terminal requires a durable admission");
    expect(sql).toHaveBeenCalled();
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

  it("SS-40: write_file creates an absent file only through put-if-absent", async () => {
    storage.readFileWithEtag.mockResolvedValueOnce(null);
    storage.writeFileIfAbsent.mockResolvedValueOnce("etag-1");

    const result = await projectTool("write_file").execute({
      path: "new.txt",
      content: "new content",
      mode: "replace"
    });

    expect(result).toEqual({
      ok: true,
      path: "new.txt",
      created: true,
      changed: true
    });
    expect(storage.writeFileIfAbsent).toHaveBeenCalledWith(
      "user-1",
      "project-1",
      "new.txt",
      "new content"
    );
    expect(storage.writeFileIfMatch).not.toHaveBeenCalled();
    expect(storage.createSnapshot).toHaveBeenCalledOnce();
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
    const fixture = {
      get state() {
        return current;
      },
      setState(
        next:
          | SiteStudioConnectionLoggingState
          | null
          | ((prev: Readonly<SiteStudioConnectionLoggingState> | null) => SiteStudioConnectionLoggingState)
      ) {
        current = next instanceof Function ? next(current) : next;
        return current;
      },
    };
    // SAFETY: The fake connection implements the state/get/set contract used
    // by SiteBuilderAgent.onConnect and omits transport-only methods.
    return fixture as Parameters<SiteBuilderAgent["onConnect"]>[0];
  }

  function createTestAgent(): SiteBuilderAgent {
    // SAFETY: These tests exercise prototype methods with controlled state;
    // the Worker/DO constructor is intentionally not invoked.
    return Object.create(SiteBuilderAgent.prototype) as SiteBuilderAgent;
  }

  function setConnections(agent: SiteBuilderAgent, connections: Iterable<ReturnType<typeof fakeConnection>>) {
    Object.assign(agent, { getConnections: () => connections });
  }

  function verifiedJwt(subject: string): string {
    const payload = btoa(JSON.stringify({ sub: subject }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/u, "");
    return `header.${payload}.signature`;
  }

  function chatConnection(id: string, subject: string) {
    const connection = Object.assign(fakeConnection(), { id, send: vi.fn() });
    connection.setState(createSiteStudioConnectionLoggingState(
      new Request("https://site-studio.example/agent", {
        headers: {
          traceparent: `00-${"1".repeat(32)}-${"2".repeat(16)}-01`,
          "x-cail-request-id": "11111111-1111-4111-8111-111111111111",
        },
      }),
      undefined,
      verifiedJwt(subject),
    ));
    return connection;
  }

  type TestChatConnection = ReturnType<typeof chatConnection>;
  type TestResumeFrame = {
    type: string;
    id?: string;
    probeId?: string;
  };
  type SiteBuilderTestCarrier = Pick<SiteBuilderAgent, "getConnections">;
  type SiteBuilderTestHooks = SiteBuilderTestCarrier & {
    rememberChatRequestConnection: (
      requestId: string,
      connection: TestChatConnection,
    ) => boolean;
    handleChatResumeFrame: (
      connection: TestChatConnection,
      frame: TestResumeFrame,
    ) => boolean;
    onChatResponse: (result: ChatResponseResult) => void | Promise<void>;
    resetTurnState: () => void;
    chatRequestConnections: Map<string, { connection: TestChatConnection }>;
  };
  type SiteBuilderTestParent = {
    broadcast?: (message: string, without?: string[]) => void;
    resetTurnState?: () => void;
  };

  function siteBuilderTestHooks(agent: SiteBuilderAgent): SiteBuilderTestHooks {
    // SAFETY: Each test initializes these private runtime fields and invokes
    // only the named hooks with the concrete fixture types declared above.
    const carrier: SiteBuilderTestCarrier = agent;
    // SAFETY: The carrier is the same SiteBuilderAgent object; its private
    // runtime members are initialized by each fixture before invocation.
    return carrier as SiteBuilderTestHooks;
  }

  function siteBuilderTestParent(): SiteBuilderTestParent {
    const parent = Object.getPrototypeOf(SiteBuilderAgent.prototype);
    // SAFETY: SiteBuilderAgent inherits these two framework hooks; tests
    // temporarily replace them to observe the owned broadcast/reset boundary.
    return parent as SiteBuilderTestParent;
  }

  it("resets the full agent turn for the Site Studio stop frame", async () => {
    const agent = createTestAgent();
    const resetTurnState = vi.fn();
    const broadcast = vi.fn();
    const connection = chatConnection("connection-a", "subject-a");
    Object.defineProperty(agent, "resetTurnState", { value: resetTurnState });
    Object.defineProperty(agent, "broadcast", { value: broadcast });
    Object.assign(agent, {
      getConnection: () => connection,
      getConnections: () => [connection],
      chatRequestConnections: new Map([[
        "request-a",
        {
          connection,
          connectionId: connection.id,
          subject: "subject-a",
        },
      ]]),
      detachedChatRequestConnections: new Map(),
      chatToolRequestIds: new Map(),
      chatRequestClaims: new Map([["request-a", true]]),
      _activeRequestId: "request-a",
    });

    await agent.onMessage(
      connection,
      JSON.stringify({ type: SITE_STUDIO_CANCEL_TURN_TYPE }),
    );

    expect(resetTurnState).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith(JSON.stringify({ type: SITE_STUDIO_CHAT_CANCELLED_TYPE }));
  });

  it("records bounded diagnostics for DO errors with connection correlation", () => {
    const points: CailAnalyticsEngineDataPoint[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const agent = createTestAgent();
    const connection = chatConnection("connection-a", "subject-a");
    const requestId = connection.state?.correlation.request_id;
    Object.assign(agent, {
      env: {
        CAIL_LOG_ENV: "test",
        CAIL_FLEET_EVENTS: {
          writeDataPoint: (point: CailAnalyticsEngineDataPoint) => points.push(point),
        },
      },
      getConnection: () => connection,
      chatRequestConnections: new Map([[
        "request-a",
        {
          connection,
          connectionId: connection.id,
          subject: "subject-a",
        },
      ]]),
      detachedChatRequestConnections: new Map(),
      chatToolRequestIds: new Map(),
      chatRequestClaims: new Map(),
    });

    try {
      const privateError = new Error("private provider body https://private.example/?csrf=secret");
      privateError.name = "UpstreamFailure";
      agent.onError(connection, privateError);

      expect(points).toHaveLength(1);
      expect(points[0]?.blobs[CAIL_ANALYTICS_ENGINE_BLOBS.event_name - 1])
        .toBe(SITE_STUDIO_EVENTS.DIAGNOSTIC_ERROR);
      expect(points[0]?.blobs[CAIL_ANALYTICS_ENGINE_BLOBS.error_type - 1])
        .toBe("upstreamfailure");
      expect(JSON.stringify(points[0])).not.toContain("private provider body");
      expect(JSON.stringify(points[0])).not.toContain("csrf=secret");
      expect(consoleError).toHaveBeenCalledWith(expect.objectContaining({
        "event.name": SITE_STUDIO_EVENTS.DIAGNOSTIC_ERROR,
        "cail.request.id": requestId,
        "error.type": "upstreamfailure",
        body: "Service event recorded.",
      }));
      expect(JSON.stringify(consoleError.mock.calls[0])).not.toContain("private provider body");
      expect(JSON.stringify(consoleError.mock.calls[0])).not.toContain("csrf=secret");
      expect(siteBuilderTestHooks(agent).chatRequestConnections.has("request-a")).toBe(false);

      points.length = 0;
      consoleError.mockClear();
      agent.onError(new TypeError("private server body https://private.example/?csrf=secret"));
      expect(points).toHaveLength(1);
      expect(consoleError).toHaveBeenCalledWith(expect.objectContaining({
        "event.name": SITE_STUDIO_EVENTS.DIAGNOSTIC_ERROR,
        "error.type": "typeerror",
        body: "Service event recorded.",
      }));
      expect(points[0]?.blobs[CAIL_ANALYTICS_ENGINE_BLOBS.error_type - 1])
        .toBe("typeerror");
      expect(JSON.stringify(points[0])).not.toContain("private server body");
      expect(JSON.stringify(consoleError.mock.calls[0])).not.toContain("private server body");
      expect(JSON.stringify(consoleError.mock.calls[0])).not.toContain(requestId);

      Object.assign(agent, { env: { CAIL_LOG_ENV: "invalid" } });
      expect(() => agent.onError(new Error("private configuration failure"))).not.toThrow();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps ordinary close and cancellation out of error diagnostics", async () => {
    const points: CailAnalyticsEngineDataPoint[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const agent = createTestAgent();
    const connection = chatConnection("connection-a", "subject-a");
    const resetTurnState = vi.fn();
    const broadcast = vi.fn();
    Object.defineProperty(agent, "resetTurnState", { value: resetTurnState });
    Object.defineProperty(agent, "broadcast", { value: broadcast });
    Object.assign(agent, {
      env: {
        CAIL_LOG_ENV: "test",
        CAIL_FLEET_EVENTS: {
          writeDataPoint: (point: CailAnalyticsEngineDataPoint) => points.push(point),
        },
      },
      getConnection: () => connection,
      getConnections: () => [connection],
      chatRequestConnections: new Map([[
        "request-a",
        {
          connection,
          connectionId: connection.id,
          subject: "subject-a",
        },
      ]]),
      detachedChatRequestConnections: new Map(),
      chatToolRequestIds: new Map(),
      chatRequestClaims: new Map([["request-a", true]]),
      _activeRequestId: "request-a",
    });

    try {
      agent.onClose(connection, 1006, "disconnect", false);
      await agent.onMessage(
        connection,
        JSON.stringify({ type: SITE_STUDIO_CANCEL_TURN_TYPE }),
      );

      expect(points).toHaveLength(0);
      expect(consoleError).not.toHaveBeenCalled();
      expect(resetTurnState).toHaveBeenCalledOnce();
      expect(broadcast).toHaveBeenCalledWith(JSON.stringify({ type: SITE_STUDIO_CHAT_CANCELLED_TYPE }));
    } finally {
      consoleError.mockRestore();
    }
  });

  it("replaces transcript broadcasts with invalidation and targets stream frames", () => {
    const agentParent = siteBuilderTestParent();
    const sends = new Map<string, (message: string) => void>();
    const baseBroadcast = vi.fn((message: string, without?: string[]) => {
      for (const [connectionId, send] of sends) {
        if (!without?.includes(connectionId)) send(message);
      }
    });
    Object.defineProperty(agentParent, "broadcast", {
      configurable: true,
      value: baseBroadcast,
    });
    try {
      const agent = createTestAgent();
      const sendA = vi.fn();
      const sendB = vi.fn();
      const connectionA = Object.assign(fakeConnection(), { id: "connection-a", send: sendA });
      const connectionB = Object.assign(fakeConnection(), { id: "connection-b", send: sendB });
      sends.set(connectionA.id, sendA);
      sends.set(connectionB.id, sendB);
      Object.assign(agent, {
        getConnections: () => [connectionA, connectionB],
        getConnection: (id: string) => [connectionA, connectionB].find((connection) => connection.id === id),
        chatRequestConnections: new Map(),
        detachedChatRequestConnections: new Map(),
        chatToolRequestIds: new Map(),
        buildActionsAwaitingPersistence: new Map(),
        messages: [{ id: "persisted", role: "assistant", parts: [{ type: "text", text: "saved" }] }],
      });
      siteBuilderTestHooks(agent).rememberChatRequestConnection("request-a", connectionA);

      agent.broadcast(
        JSON.stringify({
          type: "cf_agent_chat_messages",
          messages: [{ id: "private", role: "assistant", parts: [{ type: "text", text: "private" }] }],
        }),
        ["connection-a"],
      );

      expect(baseBroadcast).toHaveBeenCalledWith(
        JSON.stringify({ type: SITE_STUDIO_CHAT_INVALIDATED_TYPE }),
        ["connection-a"],
      );
      expect(sendA).not.toHaveBeenCalled();
      expect(sendB).toHaveBeenCalledWith(JSON.stringify({ type: SITE_STUDIO_CHAT_INVALIDATED_TYPE }));

      agent.broadcast(
        JSON.stringify({
          type: "cf_agent_use_chat_response",
          id: "request-a",
          body: JSON.stringify({ type: "text-delta", id: "request-a", delta: "only tab A" }),
        }),
      );

      expect(sendA).toHaveBeenCalledOnce();
      expect(sendA).toHaveBeenCalledWith(expect.stringContaining("only tab A"));
      expect(sendB).toHaveBeenCalledTimes(1);

      siteBuilderTestHooks(agent).onChatResponse({
        requestId: "request-a",
        status: "completed",
        continuation: false,
        message: { id: "assistant-a", role: "assistant", parts: [] },
      });

      expect(sendA).toHaveBeenCalledWith(expect.stringContaining(SITE_STUDIO_CHAT_COMMITTED_TYPE));
      expect(sendB).toHaveBeenCalledTimes(1);
    } finally {
      delete agentParent.broadcast;
    }
  });

  it("routes tool result updates only to the request owner", () => {
    const agentParent = siteBuilderTestParent();
    const sends = new Map<string, (message: string) => void>();
    const baseBroadcast = vi.fn((message: string, without?: string[]) => {
      for (const [connectionId, send] of sends) {
        if (!without?.includes(connectionId)) send(message);
      }
    });
    Object.defineProperty(agentParent, "broadcast", {
      configurable: true,
      value: baseBroadcast,
    });
    try {
      const agent = createTestAgent();
      const connectionA = chatConnection("connection-a", "subject-a");
      const connectionB = chatConnection("connection-b", "subject-b");
      sends.set(connectionA.id, connectionA.send);
      sends.set(connectionB.id, connectionB.send);
      Object.assign(agent, {
        getConnections: () => [connectionA, connectionB],
        getConnection: (id: string) => [connectionA, connectionB].find((connection) => connection.id === id),
        chatRequestConnections: new Map(),
        detachedChatRequestConnections: new Map(),
        chatToolRequestIds: new Map(),
        buildActionsAwaitingPersistence: new Map(),
        messages: [],
      });
      const hooks = siteBuilderTestHooks(agent);
      hooks.rememberChatRequestConnection("request-a", connectionA);
      expect(hooks.rememberChatRequestConnection("request-a", connectionB)).toBe(false);
      expect(hooks.chatRequestConnections.get("request-a")?.connection).toBe(connectionA);

      agent.broadcast(JSON.stringify({
        type: "cf_agent_use_chat_response",
        id: "request-a",
        body: JSON.stringify({ type: "tool-input-start", toolCallId: "tool-a" }),
      }));
      expect(connectionA.send).toHaveBeenCalledOnce();
      expect(connectionB.send).not.toHaveBeenCalled();

      agent.broadcast(JSON.stringify({
        type: "cf_agent_message_updated",
        message: {
          id: "assistant-a",
          parts: [{ type: "tool-approval-request", toolCallId: "tool-a" }],
        },
      }));
      expect(connectionA.send).toHaveBeenCalledTimes(2);
      expect(connectionA.send).toHaveBeenLastCalledWith(expect.stringContaining("cf_agent_message_updated"));
      expect(connectionB.send).not.toHaveBeenCalled();

      agent.broadcast(JSON.stringify({
        type: "agent-tool-event",
        parentToolCallId: "tool-a",
        event: { runId: "run-a", kind: "chunk", body: "private tool output" },
      }));
      expect(connectionA.send).toHaveBeenCalledTimes(3);
      expect(connectionA.send).toHaveBeenLastCalledWith(expect.stringContaining("private tool output"));
      expect(connectionB.send).not.toHaveBeenCalled();

      siteBuilderTestHooks(agent).onChatResponse({
        requestId: "request-a",
        status: "completed",
        continuation: false,
        message: { id: "assistant-a", role: "assistant", parts: [] },
      });
      agent.broadcast(JSON.stringify({
        type: "cf_agent_message_updated",
        message: {
          id: "assistant-a",
          parts: [{ type: "tool-result", toolCallId: "tool-a", state: "output-available" }],
        },
      }));
      expect(connectionA.send).toHaveBeenCalledTimes(5);
      expect(connectionB.send).not.toHaveBeenCalled();

      agent.broadcast(JSON.stringify({
        type: "cf_agent_message_updated",
        message: {
          id: "assistant-a",
          parts: [{ type: "tool-result", toolCallId: "tool-a", state: "output-available" }],
        },
      }));
      expect(connectionA.send).toHaveBeenCalledTimes(5);
      expect(connectionB.send).not.toHaveBeenCalled();
    } finally {
      delete agentParent.broadcast;
    }
  });

  it("keeps the owner through a server-tool result and persisted turn commit", () => {
    const agentParent = siteBuilderTestParent();
    const sends = new Map<string, (message: string) => void>();
    const baseBroadcast = vi.fn((message: string, without?: string[]) => {
      for (const [connectionId, send] of sends) {
        if (!without?.includes(connectionId)) send(message);
      }
    });
    Object.defineProperty(agentParent, "broadcast", {
      configurable: true,
      value: baseBroadcast,
    });
    try {
      const agent = createTestAgent();
      const connectionA = chatConnection("connection-a", "subject-a");
      const connectionB = chatConnection("connection-b", "subject-b");
      sends.set(connectionA.id, connectionA.send);
      sends.set(connectionB.id, connectionB.send);
      Object.assign(agent, {
        getConnections: () => [connectionA, connectionB],
        getConnection: (id: string) => [connectionA, connectionB].find((connection) => connection.id === id),
        chatRequestConnections: new Map(),
        detachedChatRequestConnections: new Map(),
        chatToolRequestIds: new Map(),
        buildActionsAwaitingPersistence: new Map(),
        messages: [{ id: "assistant-a", role: "assistant", parts: [] }],
      });

      const hooks = siteBuilderTestHooks(agent);
      hooks.rememberChatRequestConnection("request-a", connectionA);
      agent.broadcast(JSON.stringify({
        type: "cf_agent_use_chat_response",
        id: "request-a",
        body: JSON.stringify({ type: "tool-input-start", toolCallId: "tool-a" }),
      }));
      agent.broadcast(JSON.stringify({
        type: "cf_agent_use_chat_response",
        id: "request-a",
        body: JSON.stringify({
          type: "tool-output-available",
          toolCallId: "tool-a",
          output: { ok: true },
        }),
      }));

      // A server tool result is not the end of the model turn. The final
      // response and the post-persistence commit must still reach its owner.
      expect(hooks.chatRequestConnections.has("request-a")).toBe(true);
      agent.broadcast(JSON.stringify({
        type: "cf_agent_use_chat_response",
        id: "request-a",
        body: JSON.stringify({ type: "text-delta", id: "text-a", delta: "finished answer" }),
      }));
      hooks.onChatResponse({
        requestId: "request-a",
        status: "completed",
        continuation: false,
        message: { id: "assistant-a", role: "assistant", parts: [] },
      });

      expect(connectionA.send).toHaveBeenCalledWith(expect.stringContaining("finished answer"));
      expect(connectionA.send).toHaveBeenCalledWith(expect.stringContaining(SITE_STUDIO_CHAT_COMMITTED_TYPE));
      expect(connectionB.send).not.toHaveBeenCalled();
      expect(hooks.chatRequestConnections.has("request-a")).toBe(false);
    } finally {
      delete agentParent.broadcast;
    }
  });

  it("transfers a detached stream to the same-subject reconnect and rejects id reuse", () => {
    const agentParent = siteBuilderTestParent();
    const agent = createTestAgent();
    const connectionA = chatConnection("connection-a", "subject-a");
    const connectionB = chatConnection("connection-b", "subject-a");
    const connectionReused = chatConnection("connection-b", "subject-b");
    let liveConnections: typeof connectionA[] = [connectionA];
    Object.defineProperty(agentParent, "broadcast", {
      configurable: true,
      value: (message: string, without?: string[]) => {
        for (const connection of liveConnections) {
          if (!without?.includes(connection.id)) connection.send(message);
        }
      },
    });
    Object.assign(agent, {
      getConnections: () => liveConnections,
      getConnection: (id: string) => liveConnections.find((connection) => connection.id === id),
      chatRequestConnections: new Map(),
      detachedChatRequestConnections: new Map(),
      chatToolRequestIds: new Map(),
      _activeRequestId: "request-a",
    });
    const hooks = siteBuilderTestHooks(agent);
    hooks.rememberChatRequestConnection("request-a", connectionA);

    liveConnections = [];
    agent.onClose(connectionA, 1006, "disconnect", false);
    expect(hooks.chatRequestConnections.has("request-a")).toBe(false);

    liveConnections = [connectionB];
    expect(hooks.handleChatResumeFrame(connectionB, {
      type: "cf_agent_stream_resume_request",
      id: "request-a",
      probeId: "probe-a",
    })).toBe(false);
    expect(hooks.chatRequestConnections.get("request-a")?.connection).toBe(connectionB);

    const ownerSend = connectionB.send;
    agent.broadcast(JSON.stringify({
      type: "cf_agent_use_chat_response",
      id: "request-a",
      body: JSON.stringify({ type: "text-delta", delta: "resumed tail" }),
    }));
    expect(ownerSend).toHaveBeenCalledWith(expect.stringContaining("resumed tail"));

    liveConnections = [connectionReused];
    expect(hooks.handleChatResumeFrame(connectionReused, {
      type: "cf_agent_stream_resume_request",
      id: "request-a",
      probeId: "probe-reused",
    })).toBe(true);
    expect(connectionReused.send).toHaveBeenCalledWith(expect.stringContaining("cf_agent_stream_resume_none"));
    expect(hooks.chatRequestConnections.has("request-a")).toBe(false);
    delete agentParent.broadcast;
  });

  it("transfers pending tool ownership to the authenticated reconnect after terminal", () => {
    const agentParent = siteBuilderTestParent();
    const agent = createTestAgent();
    const connectionA = chatConnection("connection-a", "subject-a");
    const connectionB = chatConnection("connection-b", "subject-a");
    let liveConnections: typeof connectionA[] = [connectionA];
    Object.defineProperty(agentParent, "broadcast", {
      configurable: true,
      value: (message: string, without?: string[]) => {
        for (const connection of liveConnections) {
          if (!without?.includes(connection.id)) connection.send(message);
        }
      },
    });
    Object.assign(agent, {
      getConnections: () => liveConnections,
      getConnection: (id: string) => liveConnections.find((connection) => connection.id === id),
      chatRequestConnections: new Map(),
      detachedChatRequestConnections: new Map(),
      chatToolRequestIds: new Map(),
      buildActionsAwaitingPersistence: new Map(),
      messages: [],
    });
    try {
      siteBuilderTestHooks(agent).rememberChatRequestConnection("request-a", connectionA);
      agent.broadcast(JSON.stringify({
        type: "cf_agent_use_chat_response",
        id: "request-a",
        body: JSON.stringify({ type: "tool-input-start", toolCallId: "tool-a" }),
      }));
      siteBuilderTestHooks(agent).onChatResponse({
        requestId: "request-a",
        status: "completed",
        continuation: false,
        message: { id: "assistant-a", role: "assistant", parts: [] },
      });

      liveConnections = [];
      agent.onClose(connectionA, 1006, "disconnect", false);
      liveConnections = [connectionB];
      agent.onConnect(connectionB, {
        request: new Request("https://site-studio.example/agent", {
          headers: {
            traceparent: `00-${"3".repeat(32)}-${"4".repeat(16)}-01`,
            "x-cail-request-id": "33333333-3333-4333-8333-333333333333",
            [SITE_STUDIO_AGENT_PROPS_HEADER]: JSON.stringify({ identityJwt: verifiedJwt("subject-a") }),
          },
        }),
      });
      expect(siteBuilderTestHooks(agent).chatRequestConnections.get("request-a")?.connection).toBe(connectionB);

      agent.broadcast(JSON.stringify({
        type: "cf_agent_message_updated",
        message: {
          id: "assistant-a",
          parts: [{ type: "tool-result", toolCallId: "tool-a", state: "output-available" }],
        },
      }));
      expect(connectionB.send).toHaveBeenCalledWith(expect.stringContaining("cf_agent_message_updated"));
      expect(connectionA.send).not.toHaveBeenCalledWith(expect.stringContaining("cf_agent_message_updated"));
    } finally {
      delete agentParent.broadcast;
    }
  });

  it("clears active, detached, and tool ownership on turn reset", () => {
    const agentParent = siteBuilderTestParent();
    const baseReset = vi.fn();
    Object.defineProperty(agentParent, "resetTurnState", {
      configurable: true,
      value: baseReset,
    });
    try {
      const agent = createTestAgent();
      const active = new Map([["request-a", {}]]);
      const detached = new Map([["request-b", {}]]);
      const tools = new Map([["tool-a", "request-a"]]);
      Object.assign(agent, {
        chatRequestConnections: active,
        detachedChatRequestConnections: detached,
        chatToolRequestIds: tools,
      });
      siteBuilderTestHooks(agent).resetTurnState();
      expect(baseReset).toHaveBeenCalledOnce();
      expect(active).toHaveLength(0);
      expect(detached).toHaveLength(0);
      expect(tools).toHaveLength(0);
    } finally {
      delete agentParent.resetTurnState;
    }
  });

  it("denies resume after a runtime restart when ownership proof is absent", () => {
    const agentParent = siteBuilderTestParent();
    const agent = createTestAgent();
    const connection = chatConnection("connection-restarted", "subject-a");
    Object.assign(agent, {
      getConnections: () => [connection],
      getConnection: (id: string) => id === connection.id ? connection : undefined,
      chatRequestConnections: new Map(),
      detachedChatRequestConnections: new Map(),
      chatToolRequestIds: new Map(),
      _activeRequestId: "request-after-restart",
    });
    Object.defineProperty(agentParent, "broadcast", {
      configurable: true,
      value: () => undefined,
    });
    try {
      expect(siteBuilderTestHooks(agent).handleChatResumeFrame(connection, {
        type: "cf_agent_stream_resume_request",
        probeId: "probe-restarted",
      })).toBe(true);
      expect(connection.send).toHaveBeenCalledWith(expect.stringContaining("cf_agent_stream_resume_none"));
    } finally {
      delete agentParent.broadcast;
    }
  });

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
    const agent = createTestAgent();
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
    const logger = createSiteStudioLogger({ sink: () => undefined, env: "test" });
    const context = createSiteStudioLoggingContext(logger, {
      correlation: callerCorrelation,
    });
    if (!context.correlation) throw new Error("expected correlation snapshot");
    const snapshot: SiteStudioCorrelation = context.correlation;

    expect(snapshot).not.toBe(callerCorrelation);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.trace)).toBe(true);
    callerCorrelation.trace_id = "c".repeat(32);
    expect(snapshot.trace_id).toBe("a".repeat(32));

    const serialized = serializeSiteStudioLoggingContext(context);
    expect(serialized?.correlation).not.toBe(snapshot);
    expect(Object.isFrozen(serialized?.correlation)).toBe(true);
    const serializedCorrelation = serialized?.correlation;
    if (!serializedCorrelation || !("trace" in serializedCorrelation)) {
      throw new Error("expected serialized correlation");
    }
    expect(Object.isFrozen(serializedCorrelation.trace)).toBe(true);
  });

  it("updates every live connection's credential while preserving its correlation", async () => {
    const oldJwt = "verified-jwt-old";
    const freshJwt = "verified-jwt-fresh";
    const request = new Request("https://site-studio.example/agent", {
      headers: {
        traceparent: `00-${"4".repeat(32)}-dddddddddddddddd-01`,
        "x-cail-request-id": "44444444-4444-4444-8444-444444444444",
        [SITE_STUDIO_AGENT_PROPS_HEADER]: JSON.stringify({ identityJwt: oldJwt }),
      },
    });
    const refresh = new Request("https://site-studio.example/api/refresh-credential", {
      method: "POST",
      headers: {
        [SITE_STUDIO_AGENT_PROPS_HEADER]: JSON.stringify({ identityJwt: freshJwt }),
      },
    });
    const agent = createTestAgent();
    const connection = fakeConnection();
    agent.onConnect(connection, { request });
    const retainedCorrelation = connection.state?.correlation;
    setConnections(agent, [connection]);

    const response = await agent.onRequest(refresh);

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
    expect(connection.state?.identityJwt).toBe(freshJwt);
    expect(connection.state?.correlation).toBe(retainedCorrelation);
  });

  it("rejects a refresh without the verified Gateway token", async () => {
    const agent = createTestAgent();
    const connection = fakeConnection();
    agent.onConnect(connection, { request: new Request("https://site-studio.example/agent") });
    const before = connection.state;
    setConnections(agent, [connection]);

    const response = await agent.onRequest(new Request("https://site-studio.example/api/refresh-credential", {
      method: "POST",
    }));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(connection.state).toEqual(before);
  });

  it("rejects non-POST refresh requests without changing connection state", async () => {
    const agent = createTestAgent();
    const connection = fakeConnection();
    agent.onConnect(connection, { request: new Request("https://site-studio.example/agent") });
    const before = connection.state;
    setConnections(agent, [connection]);

    const response = await agent.onRequest(new Request("https://site-studio.example/api/refresh-credential", {
      method: "GET",
      headers: {
        [SITE_STUDIO_AGENT_PROPS_HEADER]: JSON.stringify({ identityJwt: "verified-jwt-fresh" }),
      },
    }));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(connection.state).toEqual(before);
  });

  it("fails honestly when the agent has no active connections", async () => {
    const agent = createTestAgent();
    setConnections(agent, []);

    const response = await agent.onRequest(new Request("https://site-studio.example/api/refresh-credential", {
      method: "POST",
      headers: {
        [SITE_STUDIO_AGENT_PROPS_HEADER]: JSON.stringify({ identityJwt: "verified-jwt-fresh" }),
      },
    }));

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "agent_connection_not_found" });
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
      message: "The response stopped partway. Send your message again."
    });
  });

  it("SS-44: keeps the generic response for an unrelated error", () => {
    expect(describeModelStreamError(new Error("boom"))).toEqual({
      quota: false,
      message: "The response stopped partway. Send your message again."
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
