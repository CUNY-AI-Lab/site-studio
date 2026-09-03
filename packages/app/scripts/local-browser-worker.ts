import { readFile } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app";
import type { AgentResolver } from "../src/routes/agents";
import { importCompletionKey } from "../src/lib/anonymous-import";
import { resolveRequestIdentity } from "../src/lib/cail-identity";
import { OwnerMutationService, type MutationJournalStore, type OwnerMutation } from "../src/lib/owner-mutations";
import type { Env, SiteBuilderAgentProps } from "../src/types";
import { z } from "zod";

type StoredObject = {
  bytes: Uint8Array;
  etag: string;
  uploaded: Date;
  httpMetadata: R2HTTPMetadata;
  customMetadata: Record<string, string>;
};

function toUint8Array(value: string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream<Uint8Array>): Promise<Uint8Array> {
  // SAFETY: R2PutValue is accepted by the Fetch BodyInit boundary in Bun; the
  // resulting bytes are the exact upload payload needed by this fixture.
  return new Response(value as BodyInit).arrayBuffer().then((bytes) => new Uint8Array(bytes));
}

async function objectEtag(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function r2Object(key: string, value: StoredObject): R2Object {
  // SAFETY: This fixture supplies every stable metadata field read by
  // R2ProjectStorage; the omitted platform-only methods are never called.
  return {
    key,
    version: "local-browser",
    size: value.bytes.byteLength,
    etag: value.etag,
    httpEtag: `"${value.etag}"`,
    checksums: {},
    uploaded: value.uploaded,
    httpMetadata: value.httpMetadata,
    customMetadata: value.customMetadata,
    storageClass: "Standard",
    writeHttpMetadata: (headers: Headers) => {
      if (value.httpMetadata.contentType) headers.set("content-type", value.httpMetadata.contentType);
      if (value.httpMetadata.contentLanguage) headers.set("content-language", value.httpMetadata.contentLanguage);
      if (value.httpMetadata.contentDisposition)
        headers.set("content-disposition", value.httpMetadata.contentDisposition);
      if (value.httpMetadata.contentEncoding) headers.set("content-encoding", value.httpMetadata.contentEncoding);
      if (value.httpMetadata.cacheControl) headers.set("cache-control", value.httpMetadata.cacheControl);
      if (value.httpMetadata.cacheExpiry) headers.set("expires", value.httpMetadata.cacheExpiry.toUTCString());
    },
  } as R2Object;
}

function r2Body(key: string, value: StoredObject): R2ObjectBody {
  const metadata = r2Object(key, value);
  // SAFETY: The app consumes only the body readers and metadata represented
  // here; Cloudflare's remaining R2ObjectBody methods are outside this path.
  return {
    ...metadata,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(value.bytes);
        controller.close();
      },
    }),
    bodyUsed: false,
    arrayBuffer: async () => value.bytes.slice().buffer,
    text: async () => new TextDecoder().decode(value.bytes),
    json: async () => JSON.parse(new TextDecoder().decode(value.bytes)),
    blob: async () => new Blob([value.bytes]),
  } as R2ObjectBody;
}

class MemoryR2Bucket {
  private readonly objects = new Map<string, StoredObject>();

  async get(key: string): Promise<R2ObjectBody | null> {
    const value = this.objects.get(key);
    return value ? r2Body(key, value) : null;
  }

  async head(key: string): Promise<R2Object | null> {
    const value = this.objects.get(key);
    return value ? r2Object(key, value) : null;
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream<Uint8Array>,
    options?: R2PutOptions,
  ): Promise<R2Object | null> {
    const bytes = await toUint8Array(value);
    const etag = await objectEtag(bytes);
    const current = this.objects.get(key);
    const condition = options?.onlyIf;
    if (condition?.etagDoesNotMatch === "*" && current) return null;
    if (condition?.etagMatches !== undefined && (!current || current.etag !== condition.etagMatches)) return null;

    const stored: StoredObject = {
      bytes: bytes.slice(),
      etag,
      uploaded: new Date(),
      httpMetadata: options?.httpMetadata || {},
      customMetadata: options?.customMetadata || {},
    };
    this.objects.set(key, stored);
    return r2Object(key, stored);
  }

  async delete(key: string | string[]): Promise<void> {
    for (const item of Array.isArray(key) ? key : [key]) this.objects.delete(item);
  }

  async list(options: R2ListOptions = {}): Promise<R2Objects> {
    const prefix = options.prefix || "";
    const delimiter = options.delimiter;
    const objects: R2Object[] = [];
    const delimitedPrefixes = new Set<string>();
    for (const key of [...this.objects.keys()].sort()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (delimiter) {
        const delimiterIndex = rest.indexOf(delimiter);
        if (delimiterIndex >= 0) {
          delimitedPrefixes.add(`${prefix}${rest.slice(0, delimiterIndex + delimiter.length)}`);
          continue;
        }
      }
      const value = this.objects.get(key);
      if (value) objects.push(r2Object(key, value));
    }
    return {
      objects,
      delimitedPrefixes: [...delimitedPrefixes].sort(),
      truncated: false,
      cursor: "",
      listComplete: true,
    };
  }

  asBinding(): R2Bucket {
    // SAFETY: Only the R2 get/head/put/delete/list methods used by this local
    // acceptance are exposed; the test never calls multipart operations.
    return this as R2Bucket;
  }
}

class MemoryKV {
  private readonly values = new Map<string, { value: string; expiresAt?: number }>();

  private read(key: string): string | null {
    const entry = this.values.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    return entry.value;
  }

  async get(key: string): Promise<string | null>;
  async get(key: string): Promise<string | null> {
    const value = this.read(key);
    return value;
  }

  async put(key: string, value: string, options?: KVNamespacePutOptions): Promise<void> {
    const expiresAt = options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : undefined;
    this.values.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async list(): Promise<KVNamespaceListResult<unknown>> {
    return { keys: [], list_complete: true, cacheStatus: null };
  }

  asBinding(): KVNamespace {
    // SAFETY: Session and preview routes use only string get/put/delete; list
    // is provided for the same bounded local contract.
    return this as KVNamespace;
  }
}

type LocalDurableObjectId = DurableObjectId & { name: string };

function durableObjectId(name: string): LocalDurableObjectId {
  // SAFETY: This deterministic id implements the methods consumed by the
  // local RPC namespace; Cloudflare's nominal brand has no runtime fields.
  return {
    name,
    toString: () => name,
    equals: (other: DurableObjectId) => other.toString() === name,
  } as LocalDurableObjectId;
}

type LocalAgentSocket = {
  send(message: string): void;
  close(code?: number, reason?: string): void;
};

type LocalAgentSocketData = {
  agent: LocalSiteBuilderAgent;
  request: Request;
  socket?: LocalAgentSocket;
};

type LocalAgentMessage = {
  id: string;
  role: "user" | "assistant";
  parts: LocalAgentPart[];
};

type LocalActionAdmission = {
  actionId: string;
  action: string;
  route: string;
  admittedAt: string;
};

type LocalActionTerminal = {
  actionId: string;
  outcome: string;
  reason: string;
  terminalAt: string;
  durationMs: number;
  errorType?: string;
};

const wranglerConfigSchema = z.object({
  vars: z.record(z.string(), z.string()),
});

async function loadWranglerVars(): Promise<Record<string, string>> {
  const configPath = resolve(dirname(fileURLToPath(import.meta.url)), "../wrangler.jsonc");
  const config = wranglerConfigSchema.parse(Bun.JSONC.parse(await readFile(configPath, "utf8")));
  return config.vars;
}

type LocalAgentPart = {
  type: string;
  text?: string;
};

type LocalAgentFrame = {
  type: string;
  id?: string;
  probeId?: string;
  init?: { body?: string };
};

type LocalFrameFields = {
  id?: string;
  body?: string;
  done?: boolean;
  messages?: LocalAgentMessage[];
  probeId?: string;
  requestId?: string;
};

type LocalToolInput = {
  operation: string;
  source: string;
};

type LocalToolOutput = {
  ok: boolean;
  boundary: string;
  files: string[];
};

type LocalChatBody =
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "tool-input-start"; toolCallId: string; toolName: string }
  | {
      type: "tool-input-available";
      toolCallId: string;
      toolName: string;
      input: LocalToolInput;
    }
  | {
      type: "tool-output-available";
      toolCallId: string;
      output: LocalToolOutput;
    }
  | { type: "finish-step"; finishReason: "stop" };

const localAgentMessageSchema = z
  .object({
    id: z.string(),
    role: z.enum(["user", "assistant"]),
    parts: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
  })
  .passthrough();

const localAgentFrameSchema = z
  .object({
    type: z.string(),
    id: z.string().optional(),
    probeId: z.string().optional(),
    init: z.object({ body: z.string().optional() }).optional(),
  })
  .passthrough();

const localChatRequestBodySchema = z
  .object({
    messages: z.array(localAgentMessageSchema),
  })
  .passthrough();

type LocalChatRequestBody = z.infer<typeof localChatRequestBodySchema>;

function localFrame(type: string, fields: LocalFrameFields = {}): string {
  return JSON.stringify({ type, ...fields });
}

type LocalAgentTurn = {
  requestId: string;
  socket: LocalAgentSocket;
  cancelled: boolean;
  held: boolean;
  toolCallIds: string[];
};

type LocalWebSocketServer = {
  upgrade(request: Request, options: { data: LocalAgentSocketData }): boolean;
};

const LOCAL_CHAT_MESSAGES_TYPE = "cf_agent_chat_messages";
const LOCAL_CHAT_REQUEST_TYPE = "cf_agent_use_chat_request";
const LOCAL_CHAT_RESPONSE_TYPE = "cf_agent_use_chat_response";
const LOCAL_CHAT_CANCEL_TYPE = "cf_agent_chat_request_cancel";
const LOCAL_SITE_CANCEL_TYPE = "site_studio_cancel_turn";
const LOCAL_SITE_CANCELLED_TYPE = "site_studio_chat_cancelled";
const LOCAL_SITE_COMMITTED_TYPE = "site_studio_chat_committed";
const LOCAL_WS_MARKER = "x-local-site-studio-websocket";
const pendingWebSocketRequests = new Map<string, Request>();

function localChatChunk(turn: LocalAgentTurn, body: LocalChatBody, done = false): void {
  if (turn.cancelled) return;
  turn.socket.send(
    localFrame(LOCAL_CHAT_RESPONSE_TYPE, {
      id: turn.requestId,
      body: JSON.stringify(body),
      done,
    }),
  );
}

class LocalSiteBuilderAgent {
  readonly id: LocalDurableObjectId;
  private readonly messages: LocalAgentMessage[] = [];
  private activeTurn: LocalAgentTurn | null = null;
  private server: LocalWebSocketServer | null;

  constructor(name: string, server: LocalWebSocketServer | null) {
    this.id = durableObjectId(name);
    this.server = server;
  }

  setServer(server: LocalWebSocketServer): void {
    this.server = server;
  }

  async setName(_name: string, _props?: SiteBuilderAgentProps): Promise<void> {}

  async recordActionAdmission(_admission: LocalActionAdmission): Promise<void> {}

  async recordActionTerminal(_terminal: LocalActionTerminal): Promise<void> {}

  async getMessages(): Promise<LocalAgentMessage[]> {
    return structuredClone(this.messages);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/get-messages")) {
      return new Response(JSON.stringify(await this.getMessages()), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    }

    if (url.pathname.endsWith("/refresh-credential")) {
      return new Response(null, {
        status: 204,
        headers: { "Cache-Control": "no-store" },
      });
    }

    const websocketMarker = request.headers.get(LOCAL_WS_MARKER);
    if (websocketMarker) {
      if (!this.server) return new Response("local agent server is not ready", { status: 503 });
      const originalRequest = pendingWebSocketRequests.get(websocketMarker);
      pendingWebSocketRequests.delete(websocketMarker);
      if (!originalRequest)
        return new Response("local agent websocket request expired", {
          status: 500,
        });
      const accepted = this.server.upgrade(originalRequest, {
        data: { agent: this, request: originalRequest },
      });
      return accepted
        ? new Response(null, { status: 101 })
        : new Response("local agent websocket upgrade failed", { status: 500 });
    }

    return new Response("Not found", { status: 404 });
  }

  open(socket: LocalAgentSocket, request: Request): void {
    socket.send(localFrame(LOCAL_CHAT_MESSAGES_TYPE, { messages: this.messages }));
    // Keep the request boundary observable without exposing props or tokens.
    if (!request.url) throw new Error("local agent connection lost its request boundary");
  }

  close(socket: LocalAgentSocket): void {
    if (this.activeTurn?.socket === socket) this.activeTurn = null;
  }

  message(socket: LocalAgentSocket, rawMessage: string): void {
    try {
      const parsed = localAgentFrameSchema.safeParse(JSON.parse(rawMessage));
      if (!parsed.success) return;
      const frame: LocalAgentFrame = parsed.data;
      switch (frame.type) {
        case LOCAL_CHAT_REQUEST_TYPE:
          this.startTurn(socket, frame);
          return;
        case LOCAL_CHAT_CANCEL_TYPE:
        case LOCAL_SITE_CANCEL_TYPE:
          this.cancelTurn(socket);
          return;
        case "cf_agent_stream_resume_request":
          socket.send(
            localFrame("cf_agent_stream_resume_none", {
              probeId: frame.probeId,
            }),
          );
          return;
        default:
          return;
      }
    } catch {
      return;
    }
  }

  private startTurn(socket: LocalAgentSocket, frame: LocalAgentFrame): void {
    const requestId = frame.id ?? "";
    if (!requestId || this.activeTurn) return;
    const body = frame.init?.body;
    if (!body) return;
    let payload: LocalChatRequestBody;
    try {
      const parsed = localChatRequestBodySchema.safeParse(JSON.parse(body));
      if (!parsed.success) return;
      payload = parsed.data;
    } catch {
      return;
    }
    const incoming = payload.messages;
    const latest = incoming.at(-1);
    if (!latest || latest.role !== "user") return;
    const prompt = latest.parts
      .filter((part) => part.type === "text" && part.text !== undefined)
      .map((part) => part.text ?? "")
      .join(" ")
      .toLowerCase();
    const turn: LocalAgentTurn = {
      requestId,
      socket,
      cancelled: false,
      held: prompt.includes("hold") || prompt.includes("stop"),
      toolCallIds: prompt.includes("multiple mutating tools")
        ? [`local-tool-${requestId}-one`, `local-tool-${requestId}-two`]
        : [`local-tool-${requestId}`],
    };
    this.activeTurn = turn;
    this.messages.push(structuredClone(latest));
    localChatChunk(turn, { type: "text-start", id: `local-text-${requestId}` });
    localChatChunk(turn, {
      type: "text-delta",
      id: `local-text-${requestId}`,
      delta: "Local agent is working. ",
    });
    for (const toolCallId of turn.toolCallIds) {
      localChatChunk(turn, {
        type: "tool-input-start",
        toolCallId,
        toolName: "codemode",
      });
      localChatChunk(turn, {
        type: "tool-input-available",
        toolCallId,
        toolName: "codemode",
        input: { operation: "inspect project", source: "local SiteBuilderAgent" },
      });
    }

    if (turn.held) return;
    this.finishTurn(turn);
  }

  private finishTurn(turn: LocalAgentTurn): void {
    if (turn.cancelled) return;
    for (const toolCallId of turn.toolCallIds) {
      localChatChunk(turn, {
        type: "tool-output-available",
        toolCallId,
        output: {
          ok: true,
          boundary: "SITE_BUILDER_AGENT",
          files: ["index.html", "styles.css"],
        },
      });
    }
    localChatChunk(turn, {
      type: "text-delta",
      id: `local-text-${turn.requestId}`,
      delta: "The local tool completed successfully.",
    });
    localChatChunk(turn, {
      type: "text-end",
      id: `local-text-${turn.requestId}`,
    });
    localChatChunk(turn, { type: "finish-step", finishReason: "stop" }, true);

    const assistant: LocalAgentMessage = {
      id: `local-assistant-${turn.requestId}`,
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "Local agent is working. The local tool completed successfully.",
          state: "done",
        },
        ...turn.toolCallIds.map((toolCallId) => ({
          type: "tool-codemode",
          toolCallId,
          toolName: "codemode",
          state: "output-available",
          input: {
            operation: "inspect project",
            source: "local SiteBuilderAgent",
          },
          output: {
            ok: true,
            boundary: "SITE_BUILDER_AGENT",
            files: ["index.html", "styles.css"],
          },
        })),
      ],
    };
    this.messages.push(assistant);
    // The persisted message is authoritative before the terminal stream frame.
    // Send the commit on the same socket after the in-memory persistence write,
    // so the browser can settle its transport from the real commit boundary
    // without a timer or a race with WebSocket shutdown.
    turn.socket.send(
      localFrame(LOCAL_SITE_COMMITTED_TYPE, {
        requestId: turn.requestId,
        messages: this.messages,
      }),
    );
    queueMicrotask(() => {
      if (turn.cancelled) return;
      this.activeTurn = null;
    });
  }

  private cancelTurn(socket: LocalAgentSocket): void {
    const turn = this.activeTurn;
    if (!turn || turn.socket !== socket) return;
    turn.cancelled = true;
    this.activeTurn = null;
    socket.send(localFrame(LOCAL_SITE_CANCELLED_TYPE));
  }
}

class LocalSiteBuilderNamespace {
  private readonly agents = new Map<string, LocalSiteBuilderAgent>();
  private server: LocalWebSocketServer | null = null;

  setServer(server: LocalWebSocketServer): void {
    this.server = server;
    for (const agent of this.agents.values()) agent.setServer(server);
  }

  idFromName(name: string): LocalDurableObjectId {
    return durableObjectId(name);
  }

  get(id: LocalDurableObjectId): LocalSiteBuilderAgent {
    const existing = this.agents.get(id.name);
    if (existing) return existing;
    const agent = new LocalSiteBuilderAgent(id.name, this.server);
    this.agents.set(id.name, agent);
    return agent;
  }
}

function makeMutationNamespace(bucket: R2Bucket): DurableObjectNamespace<never> {
  const journals = new Map<string, unknown>();
  const journalStore: MutationJournalStore = {
    async get<T>(key: string) {
      // SAFETY: The journal store is private to OwnerMutationService, which
      // writes and reads each key with the corresponding generic type.
      return journals.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T) {
      journals.set(key, value);
    },
    async delete(key: string) {
      return journals.delete(key);
    },
  };
  const service = new OwnerMutationService(bucket, journalStore);
  const id = durableObjectId("local-owner-mutation");
  const rpc = {
    id,
    execute: (ownerId: string, operation: OwnerMutation) => service.execute(ownerId, operation),
    // The authenticated browser journey seeds the completed R2 marker below.
    // Legacy anonymous import is intentionally outside this local acceptance
    // boundary; a missing marker must fail explicitly rather than emulate it.
    migrateAnonymousForSubject: async () => {
      throw new Error("local browser acceptance does not cover legacy anonymous import");
    },
  };
  const namespace = {
    idFromName: (_name: string) => id,
    idFromString: (_name: string) => id,
    newUniqueId: () => id,
    get: () => rpc,
    getByName: () => rpc,
    jurisdiction: () => namespace,
  };
  // SAFETY: The local process exposes the RPC methods used by owner mutation
  // routes; Cloudflare's nominal Durable Object brand is not runtime data.
  return namespace as DurableObjectNamespace<never>;
}

function makeUnavailableNamespace(): DurableObjectNamespace<never> {
  const id = durableObjectId("local-unavailable");
  const namespace = {
    idFromName: (_name: string) => id,
    idFromString: (_name: string) => id,
    newUniqueId: () => id,
    get: () => ({ id }),
    getByName: () => ({ id }),
    jurisdiction: () => namespace,
  };
  // SAFETY: The migration binding is deliberately unavailable in this local
  // acceptance; no migration route calls its RPC methods.
  return namespace as DurableObjectNamespace<never>;
}

function contentType(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  // SAFETY: ASSETS is a Fetcher-shaped local static-file boundary with the
  // same fetch(request) operation used by the Worker app.
  return (
    {
      css: "text/css; charset=utf-8",
      gif: "image/gif",
      html: "text/html; charset=utf-8",
      ico: "image/x-icon",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      js: "text/javascript; charset=utf-8",
      json: "application/json; charset=utf-8",
      map: "application/json; charset=utf-8",
      png: "image/png",
      svg: "image/svg+xml",
      txt: "text/plain; charset=utf-8",
      webp: "image/webp",
      woff: "font/woff",
      woff2: "font/woff2",
    }[extension || ""] || "application/octet-stream"
  );
}

function staticAssets(root: string): Fetcher {
  const resolvedRoot = resolve(root);
  // SAFETY: The local asset boundary implements the Fetcher.fetch contract;
  // no additional binding methods are used by app.notFound.
  return {
    async fetch(request: Request) {
      const url = new URL(request.url);
      const requested = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      const candidate = resolve(join(resolvedRoot, requested || "index.html"));
      const isInsideRoot =
        relative(resolvedRoot, candidate) !== ".." &&
        !relative(resolvedRoot, candidate).startsWith(`..${normalize("/")}`);
      const hasExtension = /\.[^/]+$/.test(requested);
      const target =
        isInsideRoot && (await fileExists(candidate))
          ? candidate
          : !hasExtension
            ? join(resolvedRoot, "index.html")
            : "";
      if (!target || !(await fileExists(target))) return new Response("Not found", { status: 404 });
      const bytes = await readFile(target);
      return new Response(bytes, {
        headers: {
          "Cache-Control": "no-cache",
          "Content-Type": contentType(target),
        },
      });
    },
  } as Fetcher;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

const port = Number(process.env.PORT || "8892");
const staticRoot = process.env.SITE_STUDIO_FRONTEND_BUILD;
if (!staticRoot) throw new Error("SITE_STUDIO_FRONTEND_BUILD is required");
const localBrowserIdentityJwt = process.env.CAIL_LOCAL_BROWSER_IDENTITY_JWT;
if (!localBrowserIdentityJwt) throw new Error("CAIL_LOCAL_BROWSER_IDENTITY_JWT is required");
const localBrowserGatewayJwt = process.env.CAIL_LOCAL_BROWSER_GATEWAY_JWT;
if (!localBrowserGatewayJwt) throw new Error("CAIL_LOCAL_BROWSER_GATEWAY_JWT is required");

const bucket = new MemoryR2Bucket();
const kv = new MemoryKV();
const baseUrl = `http://127.0.0.1:${port}`;
const wranglerVars = await loadWranglerVars();
const localIdentity = await resolveRequestIdentity(
  new Request(baseUrl, { headers: { "X-CAIL-Identity-JWT": localBrowserIdentityJwt } }),
  {
    CAIL_IDENTITY_JWKS: process.env.CAIL_IDENTITY_JWKS,
    CAIL_IDENTITY_ISSUER: process.env.CAIL_IDENTITY_ISSUER,
  },
);
if (localIdentity.status !== "verified") {
  throw new Error("local browser identity could not be verified for import completion setup");
}
await bucket.put(importCompletionKey(localIdentity.identity.subject), "");
const localSiteBuilderNamespace = new LocalSiteBuilderNamespace();
const localAgentResolver: AgentResolver = async (_namespace, name, { props }) => {
  const agent = localSiteBuilderNamespace.get(localSiteBuilderNamespace.idFromName(name));
  await agent.setName(name, props);
  return {
    fetch: (request: Request) => agent.fetch(request),
    getObservability: async () => {
      throw new Error("local browser acceptance does not expose observability");
    },
  };
};
const app = createApp(localAgentResolver);
// SAFETY: The local harness supplies every binding reached by the browser
// routes; only migration is intentionally unavailable, and this boundary does
// not import Cloudflare-only Durable Object modules.
const env = {
  ...wranglerVars,
  APP_PUBLIC_DOMAIN: baseUrl,
  PUBLISHED_BASE_URL: `${baseUrl}/site-studio`,
  CAIL_LOG_ENV: "test",
  CAIL_API_BASE: `${baseUrl}/gateway-disabled-for-browser-test`,
  CAIL_MODEL: "@cf/local-browser-test",
  CAIL_IDENTITY_JWKS: process.env.CAIL_IDENTITY_JWKS,
  CAIL_IDENTITY_ISSUER: process.env.CAIL_IDENTITY_ISSUER,
  SESSION_KV: kv.asBinding(),
  SITE_STUDIO_BUCKET: bucket.asBinding(),
  SITE_BUILDER_AGENT: localSiteBuilderNamespace,
  MIGRATION_COORDINATOR: makeUnavailableNamespace(),
  MUTATION_COORDINATOR: makeMutationNamespace(bucket.asBinding()),
  LOADER: undefined,
  ASSETS: staticAssets(staticRoot),
} as Env;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: async (request) => {
    // The local process stands in for the authenticated Doorway ingress and
    // injects the already-minted test identity and Gateway credential only on
    // this in-process boundary. A browser WebSocket cannot set these headers
    // itself; ordinary refresh requests need the Gateway credential too.
    const headers = new Headers(request.headers);
    headers.set("X-CAIL-Identity-JWT", localBrowserIdentityJwt);
    headers.set("X-CAIL-Gateway-Identity-JWT", localBrowserGatewayJwt);
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const websocketMarker = crypto.randomUUID();
      pendingWebSocketRequests.set(websocketMarker, request);
      headers.set(LOCAL_WS_MARKER, websocketMarker);
    }
    request = new Request(request, { headers });
    return await app.fetch(request, env, { waitUntil: () => undefined });
  },
  websocket: {
    open(socket) {
      // SAFETY: Every local upgrade passes LocalAgentSocketData as Bun socket
      // data immediately before this callback can run.
      const data = socket.data as LocalAgentSocketData;
      data.socket = socket;
      data.agent.open(socket, data.request);
    },
    message(socket, message) {
      // SAFETY: Every local upgrade passes LocalAgentSocketData as Bun socket
      // data immediately before this callback can run.
      const data = socket.data as LocalAgentSocketData;
      const stringMessage = z.string().safeParse(message);
      const rawMessage = stringMessage.success ? stringMessage.data : new TextDecoder().decode(message);
      data.agent.message(socket, rawMessage);
    },
    close(socket) {
      // SAFETY: Every local upgrade passes LocalAgentSocketData as Bun socket
      // data immediately before this callback can run.
      const data = socket.data as LocalAgentSocketData;
      data.agent.close(socket);
    },
  },
});

localSiteBuilderNamespace.setServer(server);

console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${server.port}` }));

function stop() {
  server.stop(true);
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
