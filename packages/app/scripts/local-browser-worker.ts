import { readFile } from "node:fs/promises";
import { join, normalize, relative, resolve } from "node:path";
import app from "../src/app";
import { OwnerMutationService, type MutationJournalStore, type OwnerMutation } from "../src/lib/owner-mutations";
import type { Env } from "../src/types";

type StoredObject = {
  bytes: Uint8Array;
  etag: string;
  uploaded: Date;
  httpMetadata: R2HTTPMetadata;
  customMetadata: Record<string, string>;
};

function toUint8Array(value: string | ArrayBuffer | ArrayBufferView | Blob): Promise<Uint8Array> {
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
      if (value.httpMetadata.contentDisposition) headers.set("content-disposition", value.httpMetadata.contentDisposition);
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
    value: string | ArrayBuffer | ArrayBufferView | Blob,
    options?: R2PutOptions,
  ): Promise<R2Object | null> {
    const current = this.objects.get(key);
    const condition = options?.onlyIf;
    if (condition?.etagDoesNotMatch === "*" && current) return null;
    if (condition?.etagMatches !== undefined && (!current || current.etag !== condition.etagMatches)) return null;

    const bytes = await toUint8Array(value);
    const etag = await objectEtag(bytes);
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
  // SAFETY: Chat/migration bindings are deliberately unavailable in this
  // CRUD/preview slice; no route in the acceptance calls their RPC methods.
  return namespace as DurableObjectNamespace<never>;
}

function contentType(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  // SAFETY: ASSETS is a Fetcher-shaped local static-file boundary with the
  // same fetch(request) operation used by the Worker app.
  return {
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
  }[extension || ""] || "application/octet-stream";
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
      const isInsideRoot = relative(resolvedRoot, candidate) !== ".." && !relative(resolvedRoot, candidate).startsWith(`..${normalize("/")}`);
      const hasExtension = /\.[^/]+$/.test(requested);
      const target = isInsideRoot && await fileExists(candidate) ? candidate : (!hasExtension ? join(resolvedRoot, "index.html") : "");
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

const bucket = new MemoryR2Bucket();
const kv = new MemoryKV();
const baseUrl = `http://127.0.0.1:${port}`;
// SAFETY: The local harness supplies every binding reached by CRUD/preview
// routes; unavailable chat/migration bindings are intentionally typed at this
// Worker boundary without importing Cloudflare-only Durable Object modules.
const env = {
  APP_PUBLIC_DOMAIN: baseUrl,
  PUBLISHED_BASE_URL: `${baseUrl}/site-studio`,
  CAIL_LOG_ENV: "test",
  CAIL_API_BASE: `${baseUrl}/gateway-disabled-for-browser-test`,
  CAIL_MODEL: "@cf/local-browser-test",
  CAIL_IDENTITY_JWKS: process.env.CAIL_IDENTITY_JWKS,
  CAIL_IDENTITY_ISSUER: process.env.CAIL_IDENTITY_ISSUER,
  CSRF_COOKIE_PATH: "/site-studio",
  SITE_STUDIO_MAX_PROJECT_BYTES: "10485760",
  SITE_STUDIO_MAX_OWNER_BYTES: "52428800",
  SITE_STUDIO_UPLOADS_PER_MINUTE: "20",
  SESSION_KV: kv.asBinding(),
  SITE_STUDIO_BUCKET: bucket.asBinding(),
  SITE_BUILDER_AGENT: makeUnavailableNamespace(),
  MIGRATION_COORDINATOR: makeUnavailableNamespace(),
  MUTATION_COORDINATOR: makeMutationNamespace(bucket.asBinding()),
  LOADER: undefined,
  ASSETS: staticAssets(staticRoot),
} as Env;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: (request) => app.fetch(request, env, { waitUntil: () => undefined }),
});

console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${server.port}` }));

function stop() {
  server.stop(true);
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
