import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { MutationCoordinator } from "../agents/mutation-coordinator";
import { createMockKV, createTestNamespace, createTestR2Object } from "../lib/test-utils";
import { requireProject } from "../lib/require-project";
import type { OwnerMutation } from "../lib/owner-mutations";
import { ProjectNotFoundError, SnapshotNotFoundError } from "../storage/r2";
import type { Env, ProjectMetadata, ProjectSnapshot } from "../types";
import { createProjectRouter } from "./projects";

const USER_ID = "user_persistence_test";
const PROJECT_ID = "project-a";
const SNAPSHOT_ID = "snapshot-a";

type StoredValue = string | ArrayBuffer;

function createBucket() {
  const store = new Map<string, StoredValue>();
  const get = vi.fn(async (key: string) => {
    const value = store.get(key);
    if (value === undefined) return null;
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new TextEncoder().encode(value);
    // SAFETY: The route failure paths exercise only get/list; all mutation
    // binding methods are intentionally outside this fixture's boundary.
    return {
      ...createTestR2Object(key, `${key}:etag`, bytes.byteLength),
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () => bytes.buffer,
    } as R2ObjectBody;
  });
  const list = vi.fn(async ({ prefix, delimiter }: { prefix?: string; delimiter?: string } = {}) => {
    const keys = [...store.keys()].filter((key) => !prefix || key.startsWith(prefix));
    const objects = keys.filter((key) => {
      if (!delimiter) return true;
      return !key.slice(prefix?.length ?? 0).includes(delimiter);
    }).map((key) => createTestR2Object(key));
    const delimitedPrefixes = [...new Set(keys.flatMap((key) => {
      if (!delimiter) return [];
      const relative = key.slice(prefix?.length ?? 0);
      const index = relative.indexOf(delimiter);
      return index < 0 ? [] : [`${prefix ?? ""}${relative.slice(0, index + delimiter.length)}`];
    }))];
    return { objects, delimitedPrefixes, truncated: false };
  });
  const head = vi.fn(async (key: string) => {
    const value = store.get(key);
    if (value === undefined) return null;
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new TextEncoder().encode(value);
    return createTestR2Object(key, `${key}:etag`, bytes.byteLength);
  });
  const unsupportedPut = vi.fn(async () => {
    throw new Error("route persistence fixture does not write R2 objects");
  });
  const unsupportedDelete = vi.fn(async () => undefined);
  const unsupportedCreateMultipartUpload = vi.fn(async () => {
    throw new Error("multipart upload is outside this route fixture");
  });
  const unsupportedResumeMultipartUpload = vi.fn(() => {
    throw new Error("multipart upload is outside this route fixture");
  });

  // SAFETY: The route failure paths exercise only get/list; all mutation
  // binding methods are intentionally outside this fixture's boundary.
  return {
    store,
    head,
    get,
    put: unsupportedPut,
    createMultipartUpload: unsupportedCreateMultipartUpload,
    resumeMultipartUpload: unsupportedResumeMultipartUpload,
    delete: unsupportedDelete,
    list,
  } as R2Bucket & { store: Map<string, StoredValue> };
}

function projectMetadata(): ProjectMetadata {
  return {
    id: PROJECT_ID,
    name: "Project A",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    published: false,
  };
}

function snapshotMetadata(): ProjectSnapshot {
  return {
    id: SNAPSHOT_ID,
    projectId: PROJECT_ID,
    createdAt: "2026-01-01T00:00:00.000Z",
    trigger: "manual",
    fileCount: 0,
  };
}

function metadataKey(): string {
  return `projects/${USER_ID}/${PROJECT_ID}/.metadata.json`;
}

function snapshotKey(): string {
  return `snapshots/${USER_ID}/${PROJECT_ID}/${SNAPSHOT_ID}.json`;
}

function createApp(mutationError: Error) {
  const bucket = createBucket();
  bucket.store.set(metadataKey(), JSON.stringify(projectMetadata()));
  bucket.store.set(snapshotKey(), JSON.stringify(snapshotMetadata()));

  const execute = vi.fn(async (_ownerId: string, _operation: OwnerMutation) => {
    throw mutationError;
  });
  const coordinator = createTestNamespace<MutationCoordinator>({
    // SAFETY: The coordinator fixture ignores the opaque Durable Object id.
    idFromName: () => ({}) as DurableObjectId,
    get: () => ({ execute }),
  });
  const env: Env = {
    CAIL_LOG_ENV: "test",
    SESSION_KV: createMockKV(),
    SITE_STUDIO_BUCKET: bucket,
    // SAFETY: This route boundary suite exercises only the mutation coordinator.
    SITE_BUILDER_AGENT: {} as DurableObjectNamespace<any>,
    // SAFETY: This route boundary suite exercises no anonymous migration path.
    MIGRATION_COORDINATOR: {} as DurableObjectNamespace<any>,
    MUTATION_COORDINATOR: coordinator,
    // SAFETY: This route boundary suite does not load Worker modules.
    LOADER: {} as WorkerLoader,
    ASSETS: undefined,
  };

  const app = new Hono<{ Bindings: Env; Variables: { user: { id: string; createdAt: string } } }>();
  app.use("*", async (c, next) => {
    c.set("user", {
      id: USER_ID,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await next();
  });
  app.use("/api/projects/:id", requireProject());
  app.use("/api/projects/:id/*", requireProject());
  app.route("/", createProjectRouter());
  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json({ error: error.message }, error.status);
    }
    throw error;
  });

  return { app, env, execute };
}

describe("project persistence error boundary", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["typed ProjectNotFoundError", new ProjectNotFoundError(PROJECT_ID)],
    ["RPC-like plain Error", new Error("Project not found")],
  ])("maps stale rename failures from %s to 404", async (_label, error) => {
    const { app, env, execute } = createApp(error);
    const response = await app.request(
      `http://site-studio.test/api/projects/${PROJECT_ID}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed" }),
      },
      env,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Project not found" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each([
    ["typed SnapshotNotFoundError", new SnapshotNotFoundError(SNAPSHOT_ID)],
    ["RPC-like plain Error", new Error("Snapshot not found")],
  ])("maps stale restore failures from %s to 404", async (_label, error) => {
    const { app, env, execute } = createApp(error);
    const response = await app.request(
      `http://site-studio.test/api/projects/${PROJECT_ID}/snapshots/${SNAPSHOT_ID}/restore`,
      { method: "POST" },
      env,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Snapshot not found" });
    expect(execute).toHaveBeenCalledOnce();
  });
});
