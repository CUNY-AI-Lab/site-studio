import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../types";
import { CSRF_ERROR_BODY, CSRF_HEADER_NAME, csrfProtect } from "../lib/csrf";
import { createMockKV, createMockMutationCoordinator, createTestNamespace, mintCsrfSession, type CsrfSession, type MockKV } from "../lib/test-utils";
import type { MutationCoordinator } from "../agents/mutation-coordinator";
import type { SiteBuilderAgent } from "../agents/site-builder";
import { OwnerMutationService } from "../lib/owner-mutations";
import { ProjectNotFoundError, R2ProjectStorage, SnapshotNotFoundError } from "../storage/r2";
import { MAX_SNAPSHOT_BYTES } from "../lib/constants";
import { createFileRouter } from "./files";
import { createHandleRouter } from "./handles";
import { createPreviewRouter } from "./preview";
import { createPublishRouter } from "./publish";
import { createProjectRouter } from "./projects";
import { requireProject } from "../lib/require-project";
import { z } from "zod";

const actionAttemptRpc = vi.hoisted(() => ({
  admission: vi.fn(async () => undefined),
  terminal: vi.fn(async () => undefined),
}));

type MockDataInput = string | ArrayBuffer | Uint8Array;
type PublishBody = { success: boolean; url: string; a11yFindings: Array<{ [key: string]: string | number | boolean | null | undefined }> };
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type MockData =
  | { kind: "text"; value: string }
  | { kind: "bytes"; value: ArrayBuffer };
type MockEntry = { data: MockDataInput; httpMetadata?: R2HTTPMetadata; etag?: string };
type MockBucket = R2Bucket & { store: Map<string, MockEntry> };
function testConditional(options?: R2PutOptions): R2Conditional | undefined {
  const conditional = options?.onlyIf;
  return conditional instanceof Headers ? undefined : conditional;
}
const mockDataSchema = z.union([
  z.string().transform((value) => ({ kind: "text" as const, value })),
  z.instanceof(ArrayBuffer).transform((value) => ({ kind: "bytes" as const, value })),
  z.instanceof(Uint8Array).transform((value) => ({
    kind: "bytes" as const,
    value: value.slice().buffer,
  })),
]);

function parseMockData(value: MockDataInput): MockData {
  return mockDataSchema.parse(value);
}

function createStoredR2Object(key: string, etag: string, size = 0): R2Object {
  const object = {
    key,
    version: "test-version",
    size,
    etag,
    httpEtag: `"${etag}"`,
    checksums: {},
    uploaded: new Date(0),
    storageClass: "Standard",
  };
  // SAFETY: Route regressions inspect key/etag only; remaining R2 metadata is
  // inert fixture data and the runtime binding supplies the complete object.
  return object as R2Object;
}

// Module-scoped session bits, reset per test: createEnv() and the request
// helpers read these so individual tests stay terse.
let kv: MockKV;
let csrf: CsrfSession;

function createMockBucket() {
  const store = new Map<string, MockEntry>();
  const versions = new Map<string, number>();

  function nextEtag(key: string): string {
    const version = (versions.get(key) || 0) + 1;
    versions.set(key, version);
    return `${key}:${version}`;
  }

  // SAFETY: This fixture implements the R2 methods exercised by route
  // regressions; uncalled binding methods are outside this test boundary.
  return {
    store,
    head: vi.fn(async (key: string) => {
      const entry = store.get(key);
      return entry ? { key, size: 0, etag: entry.etag } : null;
    }),
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;

      const data = entry.data;
      const parsed = parseMockData(data);
      return {
        key,
        size: parsed.kind === "text" ? parsed.value.length : parsed.value.byteLength,
        etag: entry.etag,
        httpMetadata: entry.httpMetadata || {},
        text: async () => parsed.kind === "text" ? parsed.value : new TextDecoder().decode(parsed.value),
        arrayBuffer: async () => parsed.kind === "text" ? new TextEncoder().encode(parsed.value).buffer : parsed.value,
      };
    }),
    put: vi.fn(async (
      key: string,
      data: MockDataInput,
      options?: { httpMetadata?: R2HTTPMetadata; onlyIf?: { etagDoesNotMatch?: string; etagMatches?: string } }
    ) => {
      // Honor R2 put-if-absent: onlyIf.etagDoesNotMatch:"*" writes only when the
      // key is empty; a failed condition returns null (no write, no throw).
      if (options?.onlyIf?.etagDoesNotMatch === "*" && store.has(key)) {
        return null;
      }
      if (options?.onlyIf?.etagMatches !== undefined && store.get(key)?.etag !== options.onlyIf.etagMatches) {
        return null;
      }
      const etag = nextEtag(key);
      store.set(key, { data, httpMetadata: options?.httpMetadata, etag });
      return createStoredR2Object(key, etag);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async ({ prefix, delimiter, limit }: { prefix?: string; delimiter?: string; limit?: number } = {}) => {
      const objects: R2Object[] = [];
      const delimitedPrefixes: string[] = [];

      for (const key of store.keys()) {
        if (prefix && !key.startsWith(prefix)) continue;

        if (delimiter) {
          const rest = key.slice(prefix?.length || 0);
          const delimiterIndex = rest.indexOf(delimiter);
          if (delimiterIndex >= 0) {
            const delimitedPrefix = `${prefix || ""}${rest.slice(0, delimiterIndex + 1)}`;
            if (!delimitedPrefixes.includes(delimitedPrefix)) {
              delimitedPrefixes.push(delimitedPrefix);
            }
            continue;
          }
        }

        const entry = store.get(key);
        const parsed = entry ? parseMockData(entry.data) : undefined;
        const size = parsed
          ? parsed.kind === "text" ? parsed.value.length : parsed.value.byteLength
          : 0;
        objects.push(createStoredR2Object(key, entry?.etag ?? `${key}:0`, size));
      }

      return {
        objects: limit ? objects.slice(0, limit) : objects,
        truncated: false,
        delimitedPrefixes,
      };
    }),
    createMultipartUpload: vi.fn(async () => { throw new Error("multipart upload is not part of this fixture"); }),
    resumeMultipartUpload: vi.fn(() => { throw new Error("multipart upload is not part of this fixture"); }),
  } as MockBucket;
}

function createTestApp() {
  const app = new Hono<{ Bindings: Env; Variables: { user: { id: string; createdAt: string } } }>();

  app.use("*", async (c, next) => {
    c.set("user", {
      id: "user_test123",
      createdAt: "2026-04-01T00:00:00.000Z"
    });
    await next();
  });

  // Mirror production (src/app.ts): every state-changing /api route sits
  // behind csrfProtect, so mutation tests must present the session token.
  app.use("/api/*", csrfProtect);
  app.use("/api/projects/:id", requireProject());
  app.use("/api/projects/:id/*", requireProject());

  app.route("/", createFileRouter());
  app.route("/", createPreviewRouter());
  app.route("/", createPublishRouter());
  app.route("/", createProjectRouter());
  app.route("/", createHandleRouter());
  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json({ error: error.message }, error.status);
    }

    throw error;
  });

  return app;
}

function createEnv(bucket: R2Bucket): Env {
  const actionAgent = {
    // SAFETY: The action-agent fixture uses a stable inert Durable Object id.
    id: {
      name: "action-agent",
      toString: () => "action-agent",
      equals: (other: DurableObjectId) => other.toString() === "action-agent",
    } as DurableObjectId,
    fetch: async (_request: Request) => new Response(null, { status: 404 }),
    recordActionAdmission: actionAttemptRpc.admission,
    recordActionTerminal: actionAttemptRpc.terminal,
  };
  return {
    CAIL_LOG_ENV: "test",
    SESSION_KV: kv,
    SITE_STUDIO_BUCKET: bucket,
    // SAFETY: Publish tests call only idFromName/get and action recorder RPCs.
    SITE_BUILDER_AGENT: createTestNamespace<SiteBuilderAgent>({
      idFromName: () => {
        // SAFETY: The route fixture uses a deterministic inert object id.
        return actionAgent.id;
      },
      get: () => actionAgent,
    }),
    // SAFETY: Route regressions never invoke migration coordination.
    MIGRATION_COORDINATOR: {} as DurableObjectNamespace<any>,
    // SAFETY: Regression tests exercise only the coordinator execute RPC.
    MUTATION_COORDINATOR: createTestNamespace<MutationCoordinator>(createMockMutationCoordinator(bucket)),
    // SAFETY: Route regressions do not load Worker modules through this binding.
    LOADER: {} as WorkerLoader,
    ASSETS: undefined,
  };
}

/** Give an owner a claimed public handle (both mapping records). */
function seedHandle(
  bucket: ReturnType<typeof createMockBucket>,
  ownerId: string,
  handle: string
) {
  const claimedAt = "2026-01-01T00:00:00.000Z";
  bucket.store.set(`handles/${handle}.json`, { data: JSON.stringify({ ownerId, claimedAt }) });
  bucket.store.set(`userhandles/${ownerId}.json`, { data: JSON.stringify({ handle, claimedAt }) });
}

describe("route regressions", () => {
  const userId = "user_test123";
  const handle = "janedoe";
  let bucket: ReturnType<typeof createMockBucket>;
  let storage: R2ProjectStorage;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    actionAttemptRpc.admission.mockReset();
    actionAttemptRpc.admission.mockResolvedValue(undefined);
    actionAttemptRpc.terminal.mockReset();
    actionAttemptRpc.terminal.mockResolvedValue(undefined);
    bucket = createMockBucket();
    storage = new R2ProjectStorage(bucket);
    app = createTestApp();
    kv = createMockKV();
    csrf = await mintCsrfSession(bucket, userId);
    // The publish flow now requires a public handle; give the test user one so
    // the existing publish/serve regressions exercise the /u/{handle}/ path.
    seedHandle(bucket, userId, handle);
  });

  it("returns a terse 404 for missing preview assets", async () => {
    await storage.createProjectIfAbsent(userId, "preview-project", "Preview Project");
    await storage.writeFile(userId, "preview-project", "index.html", "<h1>Hello</h1>");

    const response = await app.request(
      "http://site-studio.test/preview/preview-project/missing.css",
      undefined,
      createEnv(bucket)
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type") || "").toContain("text/plain");
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("serves the styled 404 page for missing preview navigations", async () => {
    await storage.createProjectIfAbsent(userId, "preview-project", "Preview Project");
    await storage.writeFile(userId, "preview-project", "index.html", "<h1>Hello</h1>");

    const response = await app.request(
      "http://site-studio.test/preview/preview-project/missing.html",
      { headers: { Accept: "text/html" } },
      createEnv(bucket)
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type") || "").toContain("text/html");
    const body = await response.text();
    expect(body).toContain("Page not found");
    expect(body).toContain('href="/preview/preview-project/"');
  });

  it("serves the styled 404 page for missing published navigations", async () => {
    await storage.createProjectIfAbsent(userId, "pub", "Pub");
    await storage.writeFile(userId, "pub", "index.html", "<h1>Home</h1>");
    await storage.updateProjectMetadata(userId, "pub", {
      published: true,
      slug: "pub"
    });

    const response = await app.request(
      "http://site-studio.test/u/janedoe/pub/missing.html",
      { headers: { Accept: "text/html" } },
      createEnv(bucket)
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type") || "").toContain("text/html");
    const body = await response.text();
    expect(body).toContain("Page not found");
    expect(body).toContain('href="/u/janedoe/pub/"');
  });

  it("links an unknown public site to the canonical Lab tools index", async () => {
    const env = createEnv(bucket);
    env.APP_PUBLIC_DOMAIN = "https://tools.ailab.gc.cuny.edu";

    const response = await app.request(
      "https://site-studio-app.ailab-452.workers.dev/u/unknown/missing/",
      { headers: { Accept: "text/html" } },
      env
    );

    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toContain("Explore CUNY AI Lab tools");
    expect(body).toContain('href="https://tools.ailab.gc.cuny.edu/"');
    expect(body).not.toContain("Go to site home");
  });

  it("honors a project 404.html for missing published navigations", async () => {
    await storage.createProjectIfAbsent(userId, "pub2", "Pub2");
    await storage.writeFile(userId, "pub2", "index.html", "<h1>Home</h1>");
    await storage.writeFile(userId, "pub2", "404.html", "<h1>Custom missing</h1>");
    await storage.updateProjectMetadata(userId, "pub2", {
      published: true,
      slug: "pub2"
    });

    const response = await app.request(
      "http://site-studio.test/u/janedoe/pub2/nope.html",
      { headers: { Accept: "text/html" } },
      createEnv(bucket)
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Custom missing");
  });

  it("keeps a terse 404 for missing published assets", async () => {
    await storage.createProjectIfAbsent(userId, "pub3", "Pub3");
    await storage.writeFile(userId, "pub3", "index.html", "<h1>Home</h1>");
    await storage.updateProjectMetadata(userId, "pub3", {
      published: true,
      slug: "pub3"
    });

    const response = await app.request(
      "http://site-studio.test/u/janedoe/pub3/missing.png",
      undefined,
      createEnv(bucket)
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type") || "").toContain("text/plain");
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("returns 404 for protected published bookkeeping files", async () => {
    await storage.createProjectIfAbsent(userId, "protected-publish", "Protected Publish");
    await storage.writeFile(userId, "protected-publish", "index.html", "<h1>Home</h1>");
    await storage.writeThumbnail(userId, "protected-publish", pngBytes());
    await storage.updateProjectMetadata(userId, "protected-publish", {
      published: true,
      slug: "protected-publish"
    });

    const metadata = await app.request(
      "http://site-studio.test/u/janedoe/protected-publish/.metadata.json",
      undefined,
      createEnv(bucket)
    );
    expect(metadata.status).toBe(404);
    await expect(metadata.text()).resolves.toBe("Not found");

    const thumbnail = await app.request(
      "http://site-studio.test/u/janedoe/protected-publish/.thumbnail.png",
      undefined,
      createEnv(bucket)
    );
    expect(thumbnail.status).toBe(404);
    await expect(thumbnail.text()).resolves.toBe("Not found");
  });

  it("returns 404 for missing project file reads and downloads", async () => {
    await storage.createProjectIfAbsent(userId, "files-project", "Files Project");

    const fileResponse = await app.request(
      "http://site-studio.test/api/projects/files-project/file?path=missing.txt",
      undefined,
      createEnv(bucket)
    );
    expect(fileResponse.status).toBe(404);
    await expect(fileResponse.json()).resolves.toEqual({ error: "File not found" });

    const downloadResponse = await app.request(
      "http://site-studio.test/api/projects/files-project/download?path=missing.txt",
      undefined,
      createEnv(bucket)
    );
    expect(downloadResponse.status).toBe(404);
    await expect(downloadResponse.json()).resolves.toEqual({ error: "File not found" });
  });

  it.each([
    ["typed ProjectNotFoundError", new ProjectNotFoundError("files-project")],
    ["native RPC Error", new Error("ProjectNotFoundError: Project not found")],
  ])("maps stale rename failures from %s to 404", async (_label, error) => {
    await storage.createProjectIfAbsent(userId, "files-project", "Files Project");
    const executeSpy = vi.spyOn(OwnerMutationService.prototype, "execute").mockImplementation(async () => {
      throw error;
    });

    try {
      const response = await app.request(
        "http://site-studio.test/api/projects/files-project",
        {
          method: "PATCH",
          body: JSON.stringify({ name: "Renamed Project" }),
          headers: { "Content-Type": "application/json", ...csrf.headers },
        },
        createEnv(bucket),
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "Project not found" });
      expect(executeSpy).toHaveBeenCalledOnce();
    } finally {
      executeSpy.mockRestore();
    }
  });

  it.each([
    ["typed SnapshotNotFoundError", new SnapshotNotFoundError("snapshot-a")],
    ["native RPC Error", new Error("SnapshotNotFoundError: Snapshot not found")],
  ])("maps stale restore failures from %s to 404", async (_label, error) => {
    await storage.createProjectIfAbsent(userId, "files-project", "Files Project");
    bucket.store.set("snapshots/user_test123/files-project/snapshot-a.json", {
      data: JSON.stringify({
        id: "snapshot-a",
        projectId: "files-project",
        createdAt: "2026-04-01T00:00:00.000Z",
        trigger: "manual",
        fileCount: 0,
      }),
    });
    const executeSpy = vi.spyOn(OwnerMutationService.prototype, "execute").mockImplementation(async () => {
      throw error;
    });

    try {
      const response = await app.request(
        "http://site-studio.test/api/projects/files-project/snapshots/snapshot-a/restore",
        { method: "POST", headers: csrf.headers },
        createEnv(bucket),
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "Snapshot not found" });
      expect(executeSpy).toHaveBeenCalledOnce();
    } finally {
      executeSpy.mockRestore();
    }
  });

  // SS-18: PROTECTED_FILE_NAMES were guarded on delete/rename but not on write,
  // so a caller could overwrite their own .metadata.json (flip published/slug).
  it("SS-18: rejects a write to .metadata.json via POST /file", async () => {
    await storage.createProjectIfAbsent(userId, "protproj", "Prot Proj");
    const before = await storage.getProjectMetadata(userId, "protproj");

    const response = await app.request(
      "http://site-studio.test/api/projects/protproj/file",
      {
        method: "POST",
        body: JSON.stringify({
          path: ".metadata.json",
          content: '{"published":true,"slug":"pwned"}',
          baseEtag: "protected-file-etag"
        }),
        headers: { "Content-Type": "application/json", ...csrf.headers }
      },
      createEnv(bucket)
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Cannot overwrite protected files" });
    // Metadata is untouched — still unpublished.
    const after = await storage.getProjectMetadata(userId, "protproj");
    expect(after).toEqual(before);
    expect(after?.published).toBe(false);
  });

  // SS-20: a filename containing a `"` must not break the Content-Disposition
  // header token; the ASCII fallback is quote-stripped and the real name rides in
  // the RFC 5987 filename* form.
  it("SS-20: download emits a well-formed Content-Disposition for a quoted filename", async () => {
    await storage.createProjectIfAbsent(userId, "dlproj", "Dl Proj");
    await storage.writeFile(userId, "dlproj", 'a"b.txt', "hello");

    const response = await app.request(
      `http://site-studio.test/api/projects/dlproj/download?path=${encodeURIComponent('a"b.txt')}`,
      undefined,
      createEnv(bucket)
    );

    expect(response.status).toBe(200);
    const cd = response.headers.get("Content-Disposition") || "";
    // No raw quote leaks into the quoted-string token (only the two delimiters).
    expect(cd).toBe("attachment; filename=\"ab.txt\"; filename*=UTF-8''a%22b.txt");
    // The quoted filename token has exactly two double-quotes (the delimiters).
    const quotedToken = cd.match(/filename="([^"]*)"/);
    expect(quotedToken?.[1]).toBe("ab.txt");
  });

  it("assigns a unique slug when another published project already owns it", async () => {
    await storage.createProjectIfAbsent(userId, "bar", "Bar");
    await storage.writeFile(userId, "bar", "index.html", "<h1>Alpha</h1>");
    await storage.updateProjectMetadata(userId, "bar", {
      published: true,
      slug: "foo",
      publishedAt: "2026-04-01T00:00:00.000Z"
    });

    await storage.createProjectIfAbsent(userId, "foo", "Foo");
    await storage.writeFile(userId, "foo", "index.html", "<h1>Beta</h1>");

    const publishResponse = await app.request(
      "http://site-studio.test/api/projects/foo/publish",
      { method: "POST", headers: csrf.headers },
      createEnv(bucket)
    );

    expect(publishResponse.status).toBe(200);
    // SAFETY: The publish route response is validated by this fixture's known wire shape.
    const publishBody = await publishResponse.json() as PublishBody;
    expect(publishBody).toMatchObject({
      success: true,
      url: "http://site-studio.test/u/janedoe/foo-2/"
    });
    // The canonical URL carries the handle, never the owner/subject id.
    expect(publishBody.url).not.toContain("user_test123");
    // The publish response includes an accessibility findings array; the bare
    // "<h1>Beta</h1>" fragment has no <html>/<head>, so nothing to report.
    expect(Array.isArray(publishBody.a11yFindings)).toBe(true);
    expect(publishBody.a11yFindings).toEqual([]);
    expect(actionAttemptRpc.admission).toHaveBeenCalledWith(expect.objectContaining({
      action: "publish",
      route: "/api/projects/{id}/publish",
    }));
    expect(actionAttemptRpc.terminal).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "ok",
      reason: "completed",
    }));

    const publishedSiteResponse = await app.request(
      "http://site-studio.test/u/janedoe/foo-2/",
      undefined,
      createEnv(bucket)
    );

    expect(await publishedSiteResponse.text()).toContain("<h1>Beta</h1>");
  });

  it("returns the committed publish when terminal-record RPC outcomes remain ambiguous", async () => {
    await storage.createProjectIfAbsent(userId, "terminal-rpc", "Terminal RPC");
    await storage.writeFile(userId, "terminal-rpc", "index.html", "<h1>Committed</h1>");
    actionAttemptRpc.terminal.mockRejectedValue(new Error("ambiguous Durable Object RPC"));

    const response = await app.request(
      "http://site-studio.test/api/projects/terminal-rpc/publish",
      { method: "POST", headers: csrf.headers },
      createEnv(bucket)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      url: "http://site-studio.test/u/janedoe/terminal-rpc/"
    });
    expect(actionAttemptRpc.terminal).toHaveBeenCalledTimes(2);
    expect(await storage.getProjectMetadata(userId, "terminal-rpc")).toMatchObject({
      published: true,
      slug: "terminal-rpc"
    });
  });

  it("fences a stale publisher after another project reclaims its slug", async () => {
    await storage.createProjectIfAbsent(userId, "former-owner", "Shared");
    await storage.writeFile(userId, "former-owner", "index.html", "<h1>Former</h1>");
    await storage.createProjectIfAbsent(userId, "new-owner", "Shared");
    await storage.writeFile(userId, "new-owner", "index.html", "<h1>New</h1>");

    const reservationKey = `slugreservations/${userId}/shared.json`;
    // SAFETY: createMockBucket exposes put as a Vitest mock for the slug-race
    // failure injection; retain the original R2 implementation for pass-through.
    const putMock = bucket.put as ReturnType<typeof vi.fn>;
    const originalPut = putMock.getMockImplementation();
    if (!originalPut) {
      throw new Error("Expected the route regression bucket fixture to expose a put implementation.");
    }
    // SAFETY: Vitest exposes this fixture's R2 put implementation as a callable
    // function; the constructor overload is not used by this test boundary.
    const passThroughPut = originalPut as (
      key: string,
      data: MockDataInput,
      options?: R2PutOptions,
    ) => Promise<R2Object | null>;
    let releaseFormer!: () => void;
    const formerReleased = new Promise<void>((resolve) => {
      releaseFormer = resolve;
    });
    let formerReachedFence!: () => void;
    const reachedFence = new Promise<void>((resolve) => {
      formerReachedFence = resolve;
    });
    let paused = false;

    putMock.mockImplementation(async (key: string, data: MockDataInput, options?: R2PutOptions) => {
      // SAFETY: Reservation writes at this key are JSON strings in this fixture.
      const record =
        key === reservationKey && !(data instanceof ArrayBuffer) && !(data instanceof Uint8Array)
          ? (JSON.parse(data) as { projectId?: string })
          : null;
      if (
        !paused &&
        record?.projectId === "former-owner" &&
        testConditional(options)?.etagMatches
      ) {
        paused = true;
        formerReachedFence();
        await formerReleased;
      }
      return passThroughPut(key, data, options);
    });

    const formerPublish = app.request(
      "http://site-studio.test/api/projects/former-owner/publish",
      { method: "POST", headers: csrf.headers },
      createEnv(bucket)
    );
    await reachedFence;

    // Age the exact generation the former request resolved. The new owner can
    // now take it with an ETag CAS while the former request remains paused.
    const reservation = bucket.store.get(reservationKey)!;
    bucket.store.set(reservationKey, {
      ...reservation,
      data: JSON.stringify({
        projectId: "former-owner",
        reservedAt: "2020-01-01T00:00:00.000Z"
      })
    });

    const newPublish = await app.request(
      "http://site-studio.test/api/projects/new-owner/publish",
      { method: "POST", headers: csrf.headers },
      createEnv(bucket)
    );
    expect(newPublish.status).toBe(200);

    releaseFormer();
    const formerResponse = await formerPublish;
    expect(formerResponse.status).toBe(200);

    await expect(storage.getProjectMetadata(userId, "new-owner")).resolves.toMatchObject({
      published: true,
      slug: "shared"
    });
    await expect(storage.getProjectMetadata(userId, "former-owner")).resolves.toMatchObject({
      published: true,
      slug: "shared-2"
    });
    expect(
      putMock.mock.calls.some(([key, data]) => {
        if (key !== `projects/${userId}/former-owner/.metadata.json` || data instanceof ArrayBuffer || data instanceof Uint8Array) {
          return false;
        }
        // SAFETY: This reservation fixture writes JSON strings at this key.
        const written = JSON.parse(data) as { slug?: string };
        return written.slug === "shared";
      })
    ).toBe(false);
  });

  it("uses the configured published base URL when provided", async () => {
    await storage.createProjectIfAbsent(userId, "configured-url", "Configured Url");
    await storage.writeFile(userId, "configured-url", "index.html", "<h1>Configured</h1>");

    const response = await app.request(
      "http://site-studio.test/api/projects/configured-url/publish",
      { method: "POST", headers: csrf.headers },
      {
        ...createEnv(bucket),
        PUBLISHED_BASE_URL: "https://publish.example.edu/"
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      url: "https://publish.example.edu/u/janedoe/configured-url/"
    });
  });

  it("uses the local worker origin for published URLs during loopback development", async () => {
    await storage.createProjectIfAbsent(userId, "local-publish", "Local Publish");
    await storage.writeFile(userId, "local-publish", "index.html", "<h1>Local</h1>");

    const response = await app.request(
      "http://localhost:8792/api/projects/local-publish/publish",
      { method: "POST", headers: csrf.headers },
      {
        ...createEnv(bucket),
        PUBLISHED_BASE_URL: "https://tools.cuny.qzz.io"
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      url: "http://localhost:8792/u/janedoe/local-publish/"
    });
  });

  it("derives existing published links from the current base without mutating metadata", async () => {
    await storage.createProjectIfAbsent(userId, "portable", "Portable");
    await storage.writeFile(userId, "portable", "index.html", "<h1>Portable</h1>");
    await storage.updateProjectMetadata(userId, "portable", {
      published: true,
      slug: "portable",
      publishedAt: "2026-04-01T00:00:00.000Z"
    });
    seedHandle(bucket, userId, handle);

    // An older record may still contain the former derived field. Reading it
    // must ignore that extra data and must not rewrite the project.
    const metadataKey = `projects/${userId}/portable/.metadata.json`;
    const metadataObject = await bucket.get(metadataKey);
    if (!metadataObject) throw new Error("Expected portable metadata fixture");
    const rawMetadata = z.object({
      id: z.string(),
      name: z.string(),
      createdAt: z.string(),
      updatedAt: z.string(),
      published: z.boolean(),
      publishedAt: z.string().optional(),
      slug: z.string().optional(),
      publishedUrl: z.string().optional(),
    }).parse(JSON.parse(await metadataObject.text()));
    rawMetadata.publishedUrl = "https://old.example/u/janedoe/portable/";
    await bucket.put(metadataKey, JSON.stringify(rawMetadata));
    const before = await bucket.get(metadataKey);
    if (!before) throw new Error("Expected portable metadata after legacy-field seed");
    const beforeBytes = await before.text();

    const oldBase = "https://tools.example.edu/site-studio";
    const oldListResponse = await app.request(
      "https://site-studio.test/api/projects",
      undefined,
      { ...createEnv(bucket), PUBLISHED_BASE_URL: oldBase }
    );
    expect(oldListResponse.status).toBe(200);
    const projectListResponseSchema = z.object({
      projects: z.array(z.object({ id: z.string(), publishedUrl: z.string().optional() })),
    });
    const oldList = projectListResponseSchema.parse(await oldListResponse.json());
    const oldProject = oldList.projects.find((project) => project.id === "portable");
    expect(oldProject?.publishedUrl).toBe(`${oldBase}/u/${handle}/portable/`);

    const oldPublicResponse = await app.request(
      new URL(oldProject?.publishedUrl ?? "https://invalid.example").pathname.replace("/site-studio", ""),
      undefined,
      { ...createEnv(bucket), PUBLISHED_BASE_URL: oldBase }
    );
    expect(oldPublicResponse.status).toBe(200);
    await expect(oldPublicResponse.text()).resolves.toContain("<h1>Portable</h1>");

    const newBase = "https://projects.ailab.gc.cuny.edu";
    const newListResponse = await app.request(
      "https://site-studio.test/api/projects",
      undefined,
      { ...createEnv(bucket), PUBLISHED_BASE_URL: newBase }
    );
    const newList = projectListResponseSchema.parse(await newListResponse.json());
    const newProject = newList.projects.find((project) => project.id === "portable");
    expect(newProject?.publishedUrl).toBe(`${newBase}/u/${handle}/portable/`);

    const after = await bucket.get(metadataKey);
    if (!after) throw new Error("Portable metadata disappeared while listing");
    expect(await after.text()).toBe(beforeBytes);
  });

  it("skips malformed project metadata instead of failing the projects list", async () => {
    await bucket.put(`projects/${userId}/broken-project/.metadata.json`, "{not valid json");
    await storage.createProjectIfAbsent(userId, "healthy-project", "Healthy Project");

    const response = await app.request(
      "http://site-studio.test/api/projects",
      undefined,
      createEnv(bucket)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      projects: [
        {
          id: "broken-project",
          name: "broken-project",
          published: false,
          publishedUrl: undefined,
          thumbnailUrl: undefined
        },
        {
          id: "healthy-project",
          name: "Healthy Project",
          published: false,
          publishedUrl: undefined,
          thumbnailUrl: undefined
        }
      ]
    });
  });

  it("serves the most recently published project when legacy duplicate slugs exist", async () => {
    await storage.createProjectIfAbsent(userId, "bar", "Bar");
    await storage.writeFile(userId, "bar", "index.html", "<h1>Alpha</h1>");
    await storage.updateProjectMetadata(userId, "bar", {
      published: true,
      slug: "foo",
      publishedAt: "2026-04-01T00:00:00.000Z"
    });

    await storage.createProjectIfAbsent(userId, "foo", "Foo");
    await storage.writeFile(userId, "foo", "index.html", "<h1>Beta</h1>");
    await storage.updateProjectMetadata(userId, "foo", {
      published: true,
      slug: "foo",
      publishedAt: "2026-04-02T00:00:00.000Z"
    });

    const response = await app.request(
      "http://site-studio.test/u/janedoe/foo/",
      undefined,
      createEnv(bucket)
    );

    expect(await response.text()).toContain("<h1>Beta</h1>");
  });

  it("returns 409 handle_required when publishing without a handle", async () => {
    // A user with no handle record cannot publish until they claim one.
    bucket.store.delete(`userhandles/${userId}.json`);
    bucket.store.delete(`handles/${handle}.json`);

    await storage.createProjectIfAbsent(userId, "nohandle", "No Handle");
    await storage.writeFile(userId, "nohandle", "index.html", "<h1>Hi</h1>");

    const response = await app.request(
      "http://site-studio.test/api/projects/nohandle/publish",
      { method: "POST", headers: csrf.headers },
      createEnv(bucket)
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "handle_required" });
  });

  it("returns handle_required when the reverse handle record has no matching forward owner", async () => {
    bucket.store.set(`userhandles/${userId}.json`, {
      data: JSON.stringify({
        handle: "stale-handle",
        claimedAt: "2026-01-01T00:00:00.000Z"
      })
    });
    bucket.store.delete(`handles/${handle}.json`);

    await storage.createProjectIfAbsent(userId, "stalepair", "Stale Pair");
    await storage.writeFile(userId, "stalepair", "index.html", "<h1>Hi</h1>");

    const response = await app.request(
      "http://site-studio.test/api/projects/stalepair/publish",
      { method: "POST", headers: csrf.headers },
      createEnv(bucket)
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "handle_required" });
  });

  it("301s a slashless canonical root to the trailing-slash URL with its query", async () => {
    await storage.createProjectIfAbsent(userId, "slashroot", "Slash Root");
    await storage.writeFile(userId, "slashroot", "index.html", '<link href="styles.css">');
    await storage.updateProjectMetadata(userId, "slashroot", {
      published: true,
      slug: "slashroot"
    });

    const response = await app.request(
      "http://site-studio.test/u/janedoe/slashroot?ref=x",
      { redirect: "manual" },
      createEnv(bucket)
    );

    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe("/u/janedoe/slashroot/?ref=x");
  });

  it("retains the configured ingress prefix in slashless redirects", async () => {
    await storage.createProjectIfAbsent(userId, "prefixed-root", "Prefixed Root");
    await storage.writeFile(userId, "prefixed-root", "index.html", "<h1>Prefixed</h1>");
    await storage.updateProjectMetadata(userId, "prefixed-root", {
      published: true,
      slug: "prefixed-root"
    });

    const response = await app.request(
      "https://tools.ailab.gc.cuny.edu/u/janedoe/prefixed-root?ref=x",
      { redirect: "manual" },
      {
        ...createEnv(bucket),
        PUBLISHED_BASE_URL: "https://tools.ailab.gc.cuny.edu/site-studio"
      }
    );

    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe("/site-studio/u/janedoe/prefixed-root/?ref=x");
  });

  it("retains the configured ingress prefix in styled 404 home links", async () => {
    await storage.createProjectIfAbsent(userId, "prefixed-404", "Prefixed 404");
    await storage.writeFile(userId, "prefixed-404", "index.html", "<h1>Home</h1>");
    await storage.updateProjectMetadata(userId, "prefixed-404", {
      published: true,
      slug: "prefixed-404"
    });

    const response = await app.request(
      "https://tools.ailab.gc.cuny.edu/u/janedoe/prefixed-404/missing",
      { headers: { Accept: "text/html" } },
      {
        ...createEnv(bucket),
        PUBLISHED_BASE_URL: "https://tools.ailab.gc.cuny.edu/site-studio"
      }
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toContain('href="/site-studio/u/janedoe/prefixed-404/"');
  });

  it("SS-14: resolves an extensionless path to {path}.html", async () => {
    await storage.createProjectIfAbsent(userId, "flat", "Flat");
    await storage.writeFile(userId, "flat", "index.html", "<h1>Home</h1>");
    await storage.writeFile(userId, "flat", "about.html", "<h1>Flat About</h1>");
    await storage.updateProjectMetadata(userId, "flat", { published: true, slug: "flat" });

    const response = await app.request(
      "http://site-studio.test/u/janedoe/flat/about",
      { headers: { Accept: "text/html" } },
      createEnv(bucket)
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Flat About");
  });

  it("SS-14: prefers {path}.html over {path}/index.html", async () => {
    await storage.createProjectIfAbsent(userId, "both", "Both");
    await storage.writeFile(userId, "both", "index.html", "<h1>Home</h1>");
    await storage.writeFile(userId, "both", "about.html", "<h1>Flat</h1>");
    await storage.writeFile(userId, "both", "about/index.html", "<h1>Nested</h1>");
    await storage.updateProjectMetadata(userId, "both", { published: true, slug: "both" });

    const response = await app.request(
      "http://site-studio.test/u/janedoe/both/about",
      { headers: { Accept: "text/html" } },
      createEnv(bucket)
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Flat");
  });

  it("published HTML revalidates mutable URLs and carries ETag with the CSP", async () => {
    await storage.createProjectIfAbsent(userId, "cache", "Cache");
    await storage.writeFile(userId, "cache", "index.html", "<h1>Home</h1>");
    await storage.updateProjectMetadata(userId, "cache", { published: true, slug: "cache" });

    const response = await app.request(
      "http://site-studio.test/u/janedoe/cache/",
      undefined,
      createEnv(bucket)
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
    // The §3¾ containment coexists with the caching validators.
    expect(response.headers.get("Content-Security-Policy")).toBe("sandbox allow-scripts");
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  it("returns 304 when a published file validator still matches", async () => {
    await storage.createProjectIfAbsent(userId, "cache-304", "Cache 304");
    await storage.writeFile(userId, "cache-304", "index.html", "<h1>Home</h1>");
    await storage.updateProjectMetadata(userId, "cache-304", { published: true, slug: "cache-304" });

    const first = await app.request(
      "http://site-studio.test/u/janedoe/cache-304/",
      undefined,
      createEnv(bucket)
    );
    const etag = first.headers.get("ETag");
    expect(first.status).toBe(200);
    expect(etag).toBeTruthy();

    const revalidated = await app.request(
      "http://site-studio.test/u/janedoe/cache-304/",
      { headers: { "If-None-Match": `W/"${etag}"` } },
      createEnv(bucket)
    );
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe("");
    expect(revalidated.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
    expect(revalidated.headers.get("Content-Security-Policy")).toBe("sandbox allow-scripts");
  });

  it("SS-27: a missing published ASSET does not download the project 404.html", async () => {
    await storage.createProjectIfAbsent(userId, "gate", "Gate");
    await storage.writeFile(userId, "gate", "index.html", "<h1>Home</h1>");
    await storage.writeFile(userId, "gate", "404.html", "<h1>Custom missing</h1>");
    await storage.updateProjectMetadata(userId, "gate", { published: true, slug: "gate" });

    const response = await app.request(
      "http://site-studio.test/u/janedoe/gate/missing.png",
      { headers: { Accept: "image/png,*/*" } },
      createEnv(bucket)
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type") || "").toContain("text/plain");
    expect(await response.text()).not.toContain("Custom missing");
  });
});

/**
 * docs/security-and-recovery.md (browser and serving defenses) active-content
 * invariant. Every served user/agent byte
 * (published sites, previews, a project-supplied 404.html) must carry the
 * opaque-origin CSP (`sandbox allow-scripts`, NEVER allow-same-origin) + nosniff
 * so it can never read our cookie/session. JSON API responses and the styled
 * fallback 404 are our own trusted output and must NOT carry it.
 */
describe("served-bytes security headers (§3¾)", () => {
  const userId = "user_test123";
  const handle = "janedoe";
  let bucket: ReturnType<typeof createMockBucket>;
  let storage: R2ProjectStorage;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    bucket = createMockBucket();
    storage = new R2ProjectStorage(bucket);
    app = createTestApp();
    kv = createMockKV();
    csrf = await mintCsrfSession(bucket, userId);
    seedHandle(bucket, userId, handle);
  });

  function expectSandboxed(response: Response) {
    expect(response.headers.get("Content-Security-Policy")).toBe("sandbox allow-scripts");
    expect(response.headers.get("Content-Security-Policy") || "").not.toContain("allow-same-origin");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  }

  it("sandboxes a served published page (/u/)", async () => {
    await storage.createProjectIfAbsent(userId, "sec", "Sec");
    await storage.writeFile(userId, "sec", "index.html", "<h1>Home</h1>");
    await storage.updateProjectMetadata(userId, "sec", { published: true, slug: "sec" });

    const response = await app.request(
      "http://site-studio.test/u/janedoe/sec/",
      undefined,
      createEnv(bucket)
    );
    expect(response.status).toBe(200);
    expectSandboxed(response);
  });

  it("sandboxes a served published asset (e.g. .svg)", async () => {
    await storage.createProjectIfAbsent(userId, "sec2", "Sec2");
    await storage.writeFile(userId, "sec2", "index.html", "<h1>Home</h1>");
    await storage.writeFile(userId, "sec2", "art.svg", "<svg xmlns='http://www.w3.org/2000/svg'></svg>");
    await storage.updateProjectMetadata(userId, "sec2", { published: true, slug: "sec2" });

    const response = await app.request(
      "http://site-studio.test/u/janedoe/sec2/art.svg",
      undefined,
      createEnv(bucket)
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
    expectSandboxed(response);
  });

  it("sandboxes a project-supplied 404.html", async () => {
    await storage.createProjectIfAbsent(userId, "sec3", "Sec3");
    await storage.writeFile(userId, "sec3", "index.html", "<h1>Home</h1>");
    await storage.writeFile(userId, "sec3", "404.html", "<h1>Custom missing</h1>");
    await storage.updateProjectMetadata(userId, "sec3", { published: true, slug: "sec3" });

    const response = await app.request(
      "http://site-studio.test/u/janedoe/sec3/nope.html",
      { headers: { Accept: "text/html" } },
      createEnv(bucket)
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Custom missing");
    expectSandboxed(response);
  });

  it("sandboxes a served preview page", async () => {
    await storage.createProjectIfAbsent(userId, "prev", "Prev");
    await storage.writeFile(userId, "prev", "index.html", "<h1>Preview</h1>");

    const response = await app.request(
      "http://site-studio.test/preview/prev/index.html",
      undefined,
      createEnv(bucket)
    );
    expect(response.status).toBe(200);
    expectSandboxed(response);
  });

  it("does NOT sandbox the JSON publish API response", async () => {
    await storage.createProjectIfAbsent(userId, "apisec", "ApiSec");
    await storage.writeFile(userId, "apisec", "index.html", "<h1>Home</h1>");

    const response = await app.request(
      "http://site-studio.test/api/projects/apisec/publish",
      { method: "POST", headers: csrf.headers },
      createEnv(bucket)
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("hardens the styled fallback 404 without sandboxing our own trusted markup", async () => {
    await storage.createProjectIfAbsent(userId, "fb", "Fb");
    await storage.writeFile(userId, "fb", "index.html", "<h1>Home</h1>");
    await storage.updateProjectMetadata(userId, "fb", { published: true, slug: "fb" });

    const response = await app.request(
      "http://site-studio.test/u/janedoe/fb/missing.html",
      { headers: { Accept: "text/html" } },
      createEnv(bucket)
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Page not found");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(response.headers.get("Content-Security-Policy")).not.toContain("sandbox");
  });

  it("adds nosniff but does NOT sandbox the owner thumbnail PNG", async () => {
    await storage.createProjectIfAbsent(userId, "thumb", "Thumb");
    await storage.writeThumbnail(userId, "thumb", pngBytes());

    const response = await app.request(
      "http://site-studio.test/api/projects/thumb/thumbnail",
      undefined,
      createEnv(bucket)
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Security-Policy")).toBeNull();
  });

  // SS-21: the thumbnail POST previously trusted image.type === "image/png".
  // Sniff the magic bytes and reject a non-PNG body posted as image/png.
  it("SS-21: rejects a non-PNG body posted to the thumbnail route as image/png", async () => {
    await storage.createProjectIfAbsent(userId, "thumbsniff", "Thumb Sniff");
    const html = new TextEncoder().encode("<!DOCTYPE html><html></html>");
    const form = new FormData();
    // SAFETY: The encoder's backing buffer is an ArrayBuffer in this fixture.
    form.append(
      "image",
      new File([new Blob([html.buffer as ArrayBuffer])], "thumb.png", { type: "image/png" })
    );

    const response = await app.request(
      "http://site-studio.test/api/projects/thumbsniff/thumbnail",
      { method: "POST", body: form, headers: csrf.headers },
      createEnv(bucket)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Thumbnail must be a valid PNG image." });
    // Nothing was written.
    expect(await storage.readThumbnail(userId, "thumbsniff")).toBeNull();
  });

  it("rejects a PNG signature without a valid IHDR chunk", async () => {
    await storage.createProjectIfAbsent(userId, "thumbihdr", "Thumb IHDR");
    const signatureOnly = new Uint8Array(32);
    signatureOnly.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const form = new FormData();
    form.append("image", new File([signatureOnly], "thumb.png", { type: "image/png" }));

    const response = await app.request(
      "http://site-studio.test/api/projects/thumbihdr/thumbnail",
      { method: "POST", body: form, headers: csrf.headers },
      createEnv(bucket)
    );

    expect(response.status).toBe(400);
    expect(await storage.readThumbnail(userId, "thumbihdr")).toBeNull();
  });

  it("SS-21: accepts a real PNG body on the thumbnail route and preserves its bytes", async () => {
    await storage.createProjectIfAbsent(userId, "thumbok", "Thumb OK");
    const bytes = pngBytes();
    const form = new FormData();
    // SAFETY: The PNG fixture's backing buffer is an ArrayBuffer.
    form.append(
      "image",
      new File([new Blob([bytes.buffer as ArrayBuffer])], "thumb.png", { type: "image/png" })
    );

    const response = await app.request(
      "http://site-studio.test/api/projects/thumbok/thumbnail",
      { method: "POST", body: form, headers: csrf.headers },
      createEnv(bucket)
    );

    expect(response.status).toBe(200);
    expect(Array.from(await storage.readThumbnail(userId, "thumbok") ?? [])).toEqual(Array.from(bytes));
  });

  it("rejects a thumbnail whose IHDR dimensions exceed the render ceiling", async () => {
    await storage.createProjectIfAbsent(userId, "thumbdimensions", "Thumb Dimensions");
    const png = pngBytes();
    new DataView(png.buffer).setUint32(16, 5000);
    const form = new FormData();
    // SAFETY: The PNG fixture's backing buffer is an ArrayBuffer.
    form.append("image", new File([png.buffer as ArrayBuffer], "thumb.png", { type: "image/png" }));

    const response = await app.request(
      "http://site-studio.test/api/projects/thumbdimensions/thumbnail",
      { method: "POST", body: form, headers: csrf.headers },
      createEnv(bucket)
    );

    expect(response.status).toBe(400);
    expect(await storage.readThumbnail(userId, "thumbdimensions")).toBeNull();
  });

  it("rejects a thumbnail body above the thumbnail byte ceiling before buffering it again", async () => {
    await storage.createProjectIfAbsent(userId, "thumbbytes", "Thumb Bytes");
    const form = new FormData();
    // SAFETY: pngBytes returns an ArrayBuffer-backed Uint8Array fixture.
    form.append("image", new File([pngBytes(2 * 1024 * 1024 + 1).buffer as ArrayBuffer], "thumb.png", { type: "image/png" }));

    const response = await app.request(
      "http://site-studio.test/api/projects/thumbbytes/thumbnail",
      { method: "POST", body: form, headers: csrf.headers },
      createEnv(bucket)
    );

    expect(response.status).toBe(413);
    expect(await storage.readThumbnail(userId, "thumbbytes")).toBeNull();
  });

  it("SS-33: thumbnail POST to a missing project 404s without fabricating project keys", async () => {
    const form = new FormData();
    // SAFETY: pngBytes returns an ArrayBuffer-backed Uint8Array fixture.
    form.append(
      "image",
      new File([new Blob([pngBytes().buffer as ArrayBuffer])], "thumb.png", { type: "image/png" })
    );

    const response = await app.request(
      "http://site-studio.test/api/projects/missing-thumb/thumbnail",
      { method: "POST", body: form, headers: csrf.headers },
      createEnv(bucket)
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Project not found" });
    expect(bucket.store.has(`projects/${userId}/missing-thumb/.metadata.json`)).toBe(false);
    expect(bucket.store.has(`projects/${userId}/missing-thumb/.thumbnail.png`)).toBe(false);
  });

  it("SS-33: thumbnail GET to a missing project returns project 404", async () => {
    const response = await app.request(
      "http://site-studio.test/api/projects/missing-thumb/thumbnail",
      undefined,
      createEnv(bucket)
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Project not found" });
  });

  it("SS-33: unpublish returns 404 for a missing project", async () => {
    const response = await app.request(
      "http://site-studio.test/api/projects/missing-unpublish/unpublish",
      { method: "POST", headers: csrf.headers },
      createEnv(bucket)
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Project not found" });
  });

  it("SS-33: unpublish keeps 400 for an existing unpublished project", async () => {
    await storage.createProjectIfAbsent(userId, "draft", "Draft");

    const response = await app.request(
      "http://site-studio.test/api/projects/draft/unpublish",
      { method: "POST", headers: csrf.headers },
      createEnv(bucket)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Project is not currently published" });
  });

  it("SS-40: GET file returns the content ETag", async () => {
    await storage.createProjectIfAbsent(userId, "editor-etag", "Editor ETag");
    const etag = await storage.writeFile(userId, "editor-etag", "index.html", "first");

    const response = await app.request(
      "http://site-studio.test/api/projects/editor-etag/file?path=index.html",
      undefined,
      createEnv(bucket)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      path: "index.html",
      content: "first",
      etag
    });
  });

  it("SS-40: POST file rejects a stale base ETag without overwriting", async () => {
    await storage.createProjectIfAbsent(userId, "editor-conflict", "Editor Conflict");
    const staleEtag = await storage.writeFile(userId, "editor-conflict", "index.html", "first");
    const currentEtag = await storage.writeFile(userId, "editor-conflict", "index.html", "newer");

    const response = await app.request(
      "http://site-studio.test/api/projects/editor-conflict/file",
      {
        method: "POST",
        body: JSON.stringify({ path: "index.html", content: "stale save", baseEtag: staleEtag }),
        headers: { "Content-Type": "application/json", ...csrf.headers }
      },
      createEnv(bucket)
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "file_conflict",
      message: "This file changed since you opened it. Reload to get the latest version.",
      etag: currentEtag
    });
    await expect(storage.readFile(userId, "editor-conflict", "index.html")).resolves.toBe("newer");
  });

  it("SS-40: POST file rejects a missing base ETag without overwriting", async () => {
    await storage.createProjectIfAbsent(userId, "editor-missing-etag", "Editor Missing ETag");
    await storage.writeFile(userId, "editor-missing-etag", "index.html", "current");

    const response = await app.request(
      "http://site-studio.test/api/projects/editor-missing-etag/file",
      {
        method: "POST",
        body: JSON.stringify({ path: "index.html", content: "unguarded save" }),
        headers: { "Content-Type": "application/json", ...csrf.headers }
      },
      createEnv(bucket)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid file payload" });
    await expect(storage.readFile(userId, "editor-missing-etag", "index.html")).resolves.toBe("current");
  });

  it("SS-40: POST file cannot create a file through a fabricated base ETag", async () => {
    await storage.createProjectIfAbsent(userId, "editor-no-create", "Editor No Create");

    const response = await app.request(
      "http://site-studio.test/api/projects/editor-no-create/file",
      {
        method: "POST",
        body: JSON.stringify({ path: "new.html", content: "new", baseEtag: "not-an-existing-etag" }),
        headers: { "Content-Type": "application/json", ...csrf.headers }
      },
      createEnv(bucket)
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "file_conflict",
      message: "This file changed since you opened it. Reload to get the latest version.",
      etag: null
    });
    await expect(storage.fileExists(userId, "editor-no-create", "new.html")).resolves.toBe(false);
  });

  it("SS-40: POST file accepts a matching base ETag and returns the new ETag", async () => {
    await storage.createProjectIfAbsent(userId, "editor-save", "Editor Save");
    const baseEtag = await storage.writeFile(userId, "editor-save", "index.html", "first");

    const response = await app.request(
      "http://site-studio.test/api/projects/editor-save/file",
      {
        method: "POST",
        body: JSON.stringify({ path: "index.html", content: "second", baseEtag }),
        headers: { "Content-Type": "application/json", ...csrf.headers }
      },
      createEnv(bucket)
    );

    expect(response.status).toBe(200);
    // SAFETY: The file mutation route returns the documented ETag response.
    const body = await response.json() as { etag: string };
    expect(body.etag).toBeTruthy();
    expect(body.etag).not.toBe(baseEtag);
    await expect(storage.readFile(userId, "editor-save", "index.html")).resolves.toBe("second");
  });

  it("SS-31: PATCH rename returns 409 if the target project appears after preflight", async () => {
    await storage.createProjectIfAbsent(userId, "old-name", "Old Name");
    await storage.writeFile(userId, "old-name", "index.html", "<h1>Old</h1>");
    const targetMetadataKey = `projects/${userId}/new-name/.metadata.json`;
    const originalPut = bucket.put;
    let injected = false;

    // SAFETY: This replacement preserves the R2 put signature while injecting
    // the concurrent project target.
    bucket.put = vi.fn(async (key: string, data: MockDataInput, options?: R2PutOptions) => {
      if (key === targetMetadataKey && testConditional(options)?.etagDoesNotMatch === "*" && !injected) {
        injected = true;
        bucket.store.set(targetMetadataKey, {
          data: JSON.stringify({
            id: "new-name",
            name: "Concurrent New",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            published: false
          })
        });
        bucket.store.set(`projects/${userId}/new-name/index.html`, { data: "<h1>Concurrent</h1>" });
      }
      return originalPut(key, data, options);
    });

    const response = await app.request(
      "http://site-studio.test/api/projects/old-name",
      {
        method: "PATCH",
        body: JSON.stringify({ name: "New Name" }),
        headers: { "Content-Type": "application/json", ...csrf.headers }
      },
      createEnv(bucket)
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Project already exists" });
    await expect(storage.readFile(userId, "old-name", "index.html")).resolves.toBe("<h1>Old</h1>");
    await expect(storage.readFile(userId, "new-name", "index.html")).resolves.toBe("<h1>Concurrent</h1>");
  });

  it("SS-50: PUT files/rename returns 409 when the destination appears after the preflight", async () => {
    await storage.createProjectIfAbsent(userId, "rename-race", "Rename Race");
    await storage.writeFile(userId, "rename-race", "a.html", "mine");
    const destKey = `projects/${userId}/rename-race/b.html`;
    const originalPut = bucket.put;
    let injected = false;

    // A concurrent writer takes the destination between the route's advisory
    // fileExists preflight and renameFile's atomic destination claim.
    // SAFETY: This replacement preserves the R2 put signature while injecting
    // the concurrent file destination.
    bucket.put = vi.fn(async (key: string, data: MockDataInput, options?: R2PutOptions) => {
      if (key === destKey && testConditional(options)?.etagDoesNotMatch === "*" && !injected) {
        injected = true;
        bucket.store.set(destKey, { data: "concurrent content", etag: `${destKey}:c1` });
      }
      return originalPut(key, data, options);
    });

    const response = await app.request(
      "http://site-studio.test/api/projects/rename-race/files/rename",
      {
        method: "PUT",
        body: JSON.stringify({ oldPath: "a.html", newPath: "b.html" }),
        headers: { "Content-Type": "application/json", ...csrf.headers }
      },
      createEnv(bucket)
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "A file with that name already exists" });
    // The concurrent writer's content was not clobbered and the source survives.
    await expect(storage.readFile(userId, "rename-race", "b.html")).resolves.toBe("concurrent content");
    await expect(storage.readFile(userId, "rename-race", "a.html")).resolves.toBe("mine");
  });

  it("SS-51: publish racing a delete returns 404 instead of resurrecting a published ghost", async () => {
    await storage.createProjectIfAbsent(userId, "pub-race", "Pub Race");
    await storage.writeFile(userId, "pub-race", "index.html", "<h1>Hi</h1>");
    const metadataKey = `projects/${userId}/pub-race/.metadata.json`;
    const originalPut = bucket.put;
    let injected = false;

    // The slug-reservation write sits between the route's metadata preflight
    // and the final metadata update — land the concurrent delete right there.
    // SAFETY: This replacement preserves the R2 put signature while injecting
    // the concurrent project deletion.
    bucket.put = vi.fn(async (key: string, data: MockDataInput, options?: R2PutOptions) => {
      if (key.startsWith(`slugreservations/${userId}/`) && !injected) {
        injected = true;
        await storage.deleteProject(userId, "pub-race");
      }
      return originalPut(key, data, options);
    });

    const response = await app.request(
      "http://site-studio.test/api/projects/pub-race/publish",
      { method: "POST", headers: { "Content-Type": "application/json", ...csrf.headers } },
      createEnv(bucket)
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Project not found" });
    // The deleted project stays deleted — no fabricated {published: true} record.
    expect(bucket.store.has(metadataKey)).toBe(false);
  });
});

/** Minimal PNG magic-byte prefix, padded to a plausible file size. */
function pngBytes(len = 64): Uint8Array {
  const arr = new Uint8Array(len);
  arr.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // Minimal IHDR layout for validation: length=13, type=IHDR, 1x1 dimensions.
  arr.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1], 8);
  return arr;
}

/** Build a multipart upload request body with an optional `dir` field. */
function uploadRequest(
  fileName: string,
  data: Uint8Array,
  opts: { dir?: string } = {}
): RequestInit {
  const form = new FormData();
  // SAFETY: Upload fixtures use ArrayBuffer-backed Uint8Arrays.
  form.append("file", new File([new Blob([data.buffer as ArrayBuffer])], fileName));
  if (opts.dir !== undefined) {
    form.append("dir", opts.dir);
  }
  // Uploads are mutations: carry the session CSRF token + compliant posture.
  return { method: "POST", body: form, headers: csrf.headers };
}

describe("image upload hardening", () => {
  const userId = "user_test123";
  let bucket: ReturnType<typeof createMockBucket>;
  let storage: R2ProjectStorage;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    bucket = createMockBucket();
    storage = new R2ProjectStorage(bucket);
    app = createTestApp();
    kv = createMockKV();
    csrf = await mintCsrfSession(bucket, userId);
    await storage.createProjectIfAbsent(userId, "imgproj", "Image Project");
  });

  it("accepts an image whose magic bytes match its extension", async () => {
    const response = await app.request(
      "http://site-studio.test/api/projects/imgproj/upload",
      uploadRequest("photo.png", pngBytes()),
      createEnv(bucket)
    );

    expect(response.status).toBe(200);
    // SAFETY: Successful upload responses contain the documented path field.
    const body = (await response.json()) as { path: string };
    expect(body.path).toBe("photo.png");
  });

  it("rejects uploads to protected bookkeeping filenames", async () => {
    const response = await app.request(
      "http://site-studio.test/api/projects/imgproj/upload",
      uploadRequest(".metadata.json", new TextEncoder().encode("{}")),
      createEnv(bucket)
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Cannot upload protected files" });
  });

  it("rejects a file whose bytes do not match its image extension", async () => {
    const html = new TextEncoder().encode("<!DOCTYPE html><html></html>");
    const response = await app.request(
      "http://site-studio.test/api/projects/imgproj/upload",
      uploadRequest("fake.png", html),
      createEnv(bucket)
    );

    expect(response.status).toBe(400);
    // SAFETY: The rejected upload response contains the documented error field.
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("not a valid PNG");
  });

  it("rejects an oversized image with 400", async () => {
    // 10MB cap + 1 byte, filled with the PNG signature so only size can fail.
    const big = pngBytes(10 * 1024 * 1024 + 1);
    const response = await app.request(
      "http://site-studio.test/api/projects/imgproj/upload",
      uploadRequest("huge.png", big),
      createEnv(bucket)
    );

    expect(response.status).toBe(400);
    // SAFETY: The rejected upload response contains the documented error field.
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("too large");
  });

  it("stores dir=images uploads under the images/ prefix and collision-suffixes", async () => {
    const first = await app.request(
      "http://site-studio.test/api/projects/imgproj/upload",
      uploadRequest("hero.png", pngBytes(), { dir: "images" }),
      createEnv(bucket)
    );
    expect(first.status).toBe(200);
    // SAFETY: Successful upload responses contain the documented path field.
    const firstBody = (await first.json()) as { path: string };
    expect(firstBody.path).toBe("images/hero.png");

    const second = await app.request(
      "http://site-studio.test/api/projects/imgproj/upload",
      uploadRequest("hero.png", pngBytes(), { dir: "images" }),
      createEnv(bucket)
    );
    expect(second.status).toBe(200);
    // SAFETY: Successful upload responses contain the documented path field.
    const secondBody = (await second.json()) as { path: string };
    expect(secondBody.path).toBe("images/hero_1.png");
  });

  it("rejects a dir value other than images with 400", async () => {
    const response = await app.request(
      "http://site-studio.test/api/projects/imgproj/upload",
      uploadRequest("evil.png", pngBytes(), { dir: "../secrets" }),
      createEnv(bucket)
    );

    expect(response.status).toBe(400);
    // SAFETY: The rejected upload response contains the documented error field.
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Only \"images\" is allowed");
  });

  it("keeps generic (non-image) uploads working with no dir field", async () => {
    const text = new TextEncoder().encode("hello world");
    const response = await app.request(
      "http://site-studio.test/api/projects/imgproj/upload",
      uploadRequest("notes.txt", text),
      createEnv(bucket)
    );

    expect(response.status).toBe(200);
    // SAFETY: Successful upload responses contain the documented path field.
    const body = (await response.json()) as { path: string };
    expect(body.path).toBe("notes.txt");
  });

  // SS-5: two concurrent uploads with the SAME name. The read-check-write
  // collision loop was a TOCTOU — both could see "absent" and the second clobber
  // the first. The atomic put-if-absent guarantees one keeps photo.png and the
  // other is suffixed to photo_1.png; NO upload is lost.
  it("SS-5 race: two concurrent same-name uploads get distinct paths, no clobber", async () => {
    const bytesA = pngBytes();
    const bytesB = pngBytes();
    bytesB[bytesB.length - 1] = 0x42; // distinguishable payloads

    const [respA, respB] = await Promise.all([
      app.request(
        "http://site-studio.test/api/projects/imgproj/upload",
        uploadRequest("photo.png", bytesA),
        createEnv(bucket)
      ),
      app.request(
        "http://site-studio.test/api/projects/imgproj/upload",
        uploadRequest("photo.png", bytesB),
        createEnv(bucket)
      )
    ]);

    expect(respA.status).toBe(200);
    expect(respB.status).toBe(200);
    // SAFETY: Both successful upload responses contain the documented path field.
    const pathA = (await respA.json()) as { path: string };
    // SAFETY: Both successful upload responses contain the documented path field.
    const pathB = (await respB.json()) as { path: string };
    const paths = [pathA.path, pathB.path].sort();
    expect(paths).toEqual(["photo.png", "photo_1.png"]);

    // Both files landed and neither overwrote the other.
    expect(await storage.fileExists(userId, "imgproj", "photo.png")).toBe(true);
    expect(await storage.fileExists(userId, "imgproj", "photo_1.png")).toBe(true);
  });

  // SS-29: the upload route rejects an over-ceiling body from its declared
  // Content-Length BEFORE `c.req.formData()` buffers the multipart body into
  // isolate memory (defense-in-depth on top of the per-file storage caps).
  it("SS-29: over-ceiling Content-Length → 413 before formData, nothing stored", async () => {
    const before = bucket.store.size;
    // Declare a body far larger than the 32MB cap + 1MB envelope margin, but send
    // a tiny actual body — the guard rejects on the header before parsing, so the
    // body is never buffered and no file is written.
    const response = await app.request(
      "http://site-studio.test/api/projects/imgproj/upload",
      {
        method: "POST",
        body: "x",
        headers: { ...csrf.headers, "content-length": String(64 * 1024 * 1024) }
      },
      createEnv(bucket)
    );

    expect(response.status).toBe(413);
    // SAFETY: The rejected upload response contains the documented error field.
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("too large");
    // Guard fired before formData(): no upload landed in storage.
    expect(bucket.store.size).toBe(before);
    expect(await storage.fileExists(userId, "imgproj", "huge.png")).toBe(false);
  });

  it("stores the exact bytes of a valid multipart upload", async () => {
    const response = await app.request(
      "http://site-studio.test/api/projects/imgproj/upload",
      uploadRequest("ok.png", pngBytes()),
      createEnv(bucket)
    );

    expect(response.status).toBe(200);
    // SAFETY: Successful upload responses contain the documented path field.
    const body = (await response.json()) as { path: string };
    expect(body.path).toBe("ok.png");
    expect(await storage.readFileBuffer(userId, "imgproj", "ok.png")).toEqual(pngBytes());
  });

  it("rejects malformed multipart framing without writing a file", async () => {
    const before = await storage.listFiles(userId, "imgproj");
    const response = await app.request(
      "http://site-studio.test/api/projects/imgproj/upload",
      {
        method: "POST",
        headers: { ...csrf.headers, "content-type": "multipart/form-data; boundary=broken" },
        body: "not multipart framing"
      },
      createEnv(bucket)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid multipart form data" });
    expect(await storage.listFiles(userId, "imgproj")).toEqual(before);
  });

  it("suffixes beyond 50 occupied names without clobbering their bytes", async () => {
    const original = new Uint8Array([1, 2, 3]);
    await storage.uploadToProject(userId, "imgproj", "photo.png", original);
    for (let counter = 1; counter <= 51; counter += 1) {
      await storage.uploadToProject(userId, "imgproj", `photo_${counter}.png`, new Uint8Array([counter]));
    }

    const replacement = pngBytes();
    replacement[replacement.length - 1] = 0x42;
    const response = await app.request(
      "http://site-studio.test/api/projects/imgproj/upload",
      uploadRequest("photo.png", replacement),
      createEnv(bucket)
    );

    expect(response.status).toBe(200);
    // SAFETY: Successful upload responses contain the documented path field.
    const body = (await response.json()) as { path: string };
    expect(body.path).toBe("photo_52.png");
    expect(Array.from(await storage.readFileBuffer(userId, "imgproj", "photo.png"))).toEqual(Array.from(original));
    expect(Array.from(await storage.readFileBuffer(userId, "imgproj", "photo_52.png"))).toEqual(Array.from(replacement));
  });
});

describe("images inventory endpoint", () => {
  const userId = "user_test123";
  let bucket: ReturnType<typeof createMockBucket>;
  let storage: R2ProjectStorage;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    bucket = createMockBucket();
    storage = new R2ProjectStorage(bucket);
    app = createTestApp();
    kv = createMockKV();
    csrf = await mintCsrfSession(bucket, userId);
  });

  it("lists project images and placeholder findings with an extractable src", async () => {
    await storage.createProjectIfAbsent(userId, "inv", "Inventory");
    await storage.uploadToProject(userId, "inv", "images/hero.png", pngBytes());
    await storage.writeFile(
      userId,
      "inv",
      "index.html",
      `<!DOCTYPE html>\n<html lang="en">\n<head>\n<title>T</title>\n<meta name="description" content="d">\n</head>\n<body>\n<h1>Hi</h1>\n<img src="https://placehold.co/600x400" alt="Placeholder — replace with a photo">\n</body>\n</html>`
    );

    const response = await app.request(
      "http://site-studio.test/api/projects/inv/images",
      undefined,
      createEnv(bucket)
    );

    expect(response.status).toBe(200);
    // SAFETY: The images route returns the documented image inventory shape.
    const body = (await response.json()) as {
      images: Array<{ path: string; size: number }>;
      placeholders: Array<{ file: string; line: number | null; message: string; src?: string }>;
    };

    expect(body.images.map((i) => i.path)).toContain("images/hero.png");
    expect(body.placeholders.length).toBe(1);
    expect(body.placeholders[0].file).toBe("index.html");
    expect(body.placeholders[0].src).toBe("https://placehold.co/600x400");
    expect(body.placeholders[0].message).toContain("placeholder");
  });

  it("returns 404 for a missing project", async () => {
    const response = await app.request(
      "http://site-studio.test/api/projects/nope/images",
      undefined,
      createEnv(bucket)
    );
    expect(response.status).toBe(404);
  });
});

/**
 * docs/security-and-recovery.md (browser and serving defenses) rules over every
 * state-changing route. Each mutation
 * must: reject without the token (403 + exact envelope), reject a valid token
 * arriving with `Sec-Fetch-Site: cross-site` (403), and proceed past CSRF with
 * the token + compliant same-origin posture (whatever domain-level status the
 * route then returns, it is never the CSRF envelope).
 */
describe("csrf protection on all mutation routes", () => {
  const userId = "user_test123";
  let bucket: ReturnType<typeof createMockBucket>;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    bucket = createMockBucket();
    app = createTestApp();
    kv = createMockKV();
    csrf = await mintCsrfSession(bucket, userId);
  });

  const json = (body: JsonValue): Pick<RequestInit, "body" | "headers"> => ({
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" }
  });
  const form = (): Pick<RequestInit, "body"> => ({ body: new FormData() });

  // The 14 state-changing routes (POST/PUT/PATCH/DELETE — rule 1 keeps
  // GET/HEAD side-effect free, so nothing else needs the token).
  const mutations: Array<{
    method: string;
    path: string;
    init?: () => Pick<RequestInit, "body" | "headers">;
  }> = [
    { method: "POST", path: "/api/handle", init: () => json({ handle: "table-check" }) },
    { method: "POST", path: "/api/agents/site-builder/proj-x/refresh-credential" },
    { method: "POST", path: "/api/projects/proj-x/file", init: () => json({ path: "a.html", content: "hi" }) },
    { method: "DELETE", path: "/api/projects/proj-x/files?path=a.html" },
    { method: "PUT", path: "/api/projects/proj-x/files/rename", init: () => json({ oldPath: "a.html", newPath: "b.html" }) },
    { method: "POST", path: "/api/projects/proj-x/upload", init: form },
    { method: "POST", path: "/api/projects/proj-x/publish" },
    { method: "POST", path: "/api/projects/proj-x/unpublish" },
    { method: "POST", path: "/api/projects/proj-x/thumbnail", init: form },
    { method: "POST", path: "/api/projects", init: () => json({ name: "table-proj" }) },
    { method: "PATCH", path: "/api/projects/proj-x", init: () => json({ name: "renamed" }) },
    { method: "DELETE", path: "/api/projects/proj-x" },
    { method: "POST", path: "/api/projects/proj-x/snapshots" },
    { method: "POST", path: "/api/projects/proj-x/snapshots/snap-1/restore" }
  ];

  const request = (
    mutation: (typeof mutations)[number],
    csrfHeaders: Record<string, string>
  ) => {
    const init = mutation.init?.() ?? {};
    return app.request(
      `http://site-studio.test${mutation.path}`,
      {
        method: mutation.method,
        body: init.body,
        // SAFETY: Mutation fixtures provide string request headers only.
        headers: { ...(init.headers as Record<string, string> | undefined), ...csrfHeaders }
      },
      createEnv(bucket)
    );
  };

  for (const mutation of mutations) {
    describe(`${mutation.method} ${mutation.path.split("?")[0]}`, () => {
      it("403s without a token", async () => {
        const res = await request(mutation, {});
        expect(res.status).toBe(403);
        await expect(res.json()).resolves.toEqual(CSRF_ERROR_BODY);
      });

      it("403s with a valid token but Sec-Fetch-Site: cross-site", async () => {
        const res = await request(mutation, {
          [CSRF_HEADER_NAME]: csrf.token,
          "Sec-Fetch-Site": "cross-site"
        });
        expect(res.status).toBe(403);
        await expect(res.json()).resolves.toEqual(CSRF_ERROR_BODY);
      });

      it("passes CSRF with the token + same-origin posture", async () => {
        const res = await request(mutation, csrf.headers);
        // Domain-level outcomes vary (200/400/404/409 depending on seeded
        // state) but none of these routes 403 on their success path here, so
        // any 403 would be a CSRF false positive.
        expect(res.status).not.toBe(403);
      });
    });
  }
});

// SS-28: the MANUAL snapshot endpoint. A snapshot the user explicitly asked for
// should tell them it was too large (413) rather than silently 201-ing with no
// restore point. A normal-sized project still snapshots (201).
describe("SS-28 manual snapshot cap (over-cap → 413, normal → 201)", () => {
  const userId = "user_test123";
  let bucket: ReturnType<typeof createMockBucket>;
  let storage: R2ProjectStorage;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    bucket = createMockBucket();
    storage = new R2ProjectStorage(bucket);
    app = createTestApp();
    kv = createMockKV();
    csrf = await mintCsrfSession(bucket, userId);
    await storage.createProjectIfAbsent(userId, "snapproj", "Snap Project");
  });

  it("normal-sized project → 201 with a snapshot", async () => {
    await storage.writeFile(userId, "snapproj", "index.html", "<h1>Small</h1>");

    const res = await app.request(
      "http://site-studio.test/api/projects/snapproj/snapshots",
      { method: "POST", body: "{}", headers: { "Content-Type": "application/json", ...csrf.headers } },
      createEnv(bucket)
    );

    expect(res.status).toBe(201);
    // SAFETY: Successful snapshot responses contain the documented snapshot id.
    const body = (await res.json()) as { snapshot: { id: string } };
    expect(body.snapshot.id).toBeTruthy();
  });

  it("over-cap project → 413 (too large), not a silent skip", async () => {
    await storage.writeFile(userId, "snapproj", "big.txt", "x".repeat(MAX_SNAPSHOT_BYTES + 1));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await app.request(
      "http://site-studio.test/api/projects/snapproj/snapshots",
      { method: "POST", body: "{}", headers: { "Content-Type": "application/json", ...csrf.headers } },
      createEnv(bucket)
    );
    warnSpy.mockRestore();

    expect(res.status).toBe(413);
    // SAFETY: The rejected snapshot response contains the documented error field.
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("too large");

    // Nothing was zipped/stored for the over-cap manual snapshot.
    const snapshots = await storage.listSnapshots(userId, "snapproj");
    expect(snapshots).toHaveLength(0);
  });
});
