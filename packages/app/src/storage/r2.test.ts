import { describe, it, expect, beforeEach, vi } from "vitest";
import { FileExistsError, ProjectExistsError, ProjectNotFoundError, R2ProjectStorage } from "./r2";
import { isSnapshotSkipped } from "../types";
import type { ProjectMetadata, ProjectSnapshot } from "../types";
import { MAX_SNAPSHOT_BYTES, SNAPSHOT_KEEP_COUNT } from "../lib/constants";
import { OwnerMutationService, type MutationJournalStore } from "../lib/owner-mutations";
import { createSiteStudioBoundaryContext } from "../lib/logging";
import { createTestR2Object } from "../lib/test-utils";
import { unzipSync } from "fflate";
import { createProjectTools } from "../agents/site-builder";

type R2TestData = string | ArrayBuffer | Uint8Array;
type DiagnosticEvent = { [key: string]: string | number | boolean | null | undefined };

function testConditional(options?: R2PutOptions): R2Conditional | undefined {
  const conditional = options?.onlyIf;
  return conditional instanceof Headers ? undefined : conditional;
}

function testMetadata(options?: R2PutOptions): R2HTTPMetadata | undefined {
  const metadata = options?.httpMetadata;
  return metadata instanceof Headers ? undefined : metadata;
}

// Mock R2 bucket
function createMockBucket() {
  type MockData = string | ArrayBuffer;
  type MockEntry = { data: MockData; httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string>; etag: string; uploaded: Date };
  type MockObject = R2Object;
  const store = new Map<string, MockEntry>();
  const versions = new Map<string, number>();

  function objectSize(data: MockData): number {
    return data instanceof ArrayBuffer ? data.byteLength : data.length;
  }

  function nextEtag(key: string): string {
    const version = (versions.get(key) || 0) + 1;
    versions.set(key, version);
    return `${key}:${version}`;
  }

  function toStored(data: string | ArrayBuffer | Uint8Array): MockData {
    if (data instanceof ArrayBuffer) {
      return data;
    }
    if (data instanceof Uint8Array) {
      const copy = new Uint8Array(data.byteLength);
      copy.set(data);
      return copy.buffer;
    }
    return data;
  }

  // SAFETY: This fixture implements the R2 methods exercised by R2ProjectStorage;
  // uncalled binding methods are outside this test boundary.
  return {
    store,
    head: vi.fn(async (key: string) => {
      const entry = store.get(key);
      return entry
        ? {
            key,
            size: objectSize(entry.data),
            etag: entry.etag,
            uploaded: entry.uploaded,
            httpMetadata: entry.httpMetadata || {},
            customMetadata: entry.customMetadata || {},
          }
        : null;
    }),
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      const data = entry.data;
      return {
        key,
        size: objectSize(data),
        etag: entry.etag,
        uploaded: entry.uploaded,
        httpMetadata: entry.httpMetadata || {},
        customMetadata: entry.customMetadata || {},
        text: async () => data instanceof ArrayBuffer ? new TextDecoder().decode(data) : data,
        arrayBuffer: async () => data instanceof ArrayBuffer ? data : new TextEncoder().encode(data).buffer,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(data instanceof ArrayBuffer ? new Uint8Array(data) : new TextEncoder().encode(data));
            controller.close();
          },
        }),
      };
    }),
    put: vi.fn(async (key: string, data: string | ArrayBuffer | Uint8Array, options?: R2PutOptions) => {
      const conditional = testConditional(options);
      if (conditional?.etagDoesNotMatch === "*" && store.has(key)) {
        return null;
      }
      if (conditional?.etagMatches !== undefined && store.get(key)?.etag !== conditional.etagMatches) {
        return null;
      }
      const stored = toStored(data);
      const entry = {
        data: stored,
        httpMetadata: testMetadata(options),
        customMetadata: options?.customMetadata,
        etag: nextEtag(key),
        uploaded: new Date()
      };
      store.set(key, entry);
      return createTestR2Object(key, entry.etag, objectSize(stored));
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async ({ prefix, delimiter, cursor, limit, include }: R2ListOptions = {}) => {
      const entries: Array<{ kind: "object"; key: string } | { kind: "prefix"; key: string }> = [];
      const seenPrefixes = new Set<string>();
      const includeCustomMetadata = Array.isArray(include) && include.includes("customMetadata");

      for (const key of [...store.keys()].sort()) {
        if (prefix && !key.startsWith(prefix)) continue;

        if (delimiter) {
          const rest = key.slice(prefix?.length || 0);
          const delimIndex = rest.indexOf(delimiter);
          if (delimIndex >= 0) {
            const delimitedPrefix = (prefix || "") + rest.slice(0, delimIndex + 1);
            if (!seenPrefixes.has(delimitedPrefix)) {
              seenPrefixes.add(delimitedPrefix);
              entries.push({ kind: "prefix", key: delimitedPrefix });
            }
            continue;
          }
        }

        entries.push({ kind: "object", key });
      }

      const pageSize = limit ?? 3;
      const start = cursor ? Number(cursor) : 0;
      const page = entries.slice(start, start + pageSize);
      const objects: MockObject[] = [];
      const delimitedPrefixes: string[] = [];

      for (const listedEntry of page) {
        if (listedEntry.kind === "prefix") {
          delimitedPrefixes.push(listedEntry.key);
          continue;
        }

        const key = listedEntry.key;
        const entry = store.get(key);
        const size = entry ? objectSize(entry.data) : 0;
        if (includeCustomMetadata) {
          objects.push(createTestR2Object(key, entry?.etag || `${key}:etag`, size, {
            uploaded: entry?.uploaded || new Date(),
            httpMetadata: entry?.httpMetadata || {},
            customMetadata: entry?.customMetadata || {},
          }));
        } else {
          objects.push(createTestR2Object(key, entry?.etag || `${key}:etag`, size, {
            uploaded: entry?.uploaded || new Date(),
            httpMetadata: entry?.httpMetadata || {},
          }));
        }
      }

      const next = start + pageSize;
      return {
        objects,
        truncated: next < entries.length,
        cursor: next < entries.length ? String(next) : undefined,
        delimitedPrefixes,
      };
    }),
    createMultipartUpload: vi.fn(async () => { throw new Error("multipart upload is not part of this fixture"); }),
    resumeMultipartUpload: vi.fn(() => { throw new Error("multipart upload is not part of this fixture"); }),
  } as R2Bucket & { store: Map<string, MockEntry> };
}

describe("R2ProjectStorage", () => {
  let bucket: ReturnType<typeof createMockBucket>;
  let storage: R2ProjectStorage;
  const userId = "user_test123";
  const projectId = "my-project";

  beforeEach(() => {
    bucket = createMockBucket();
    // SAFETY: createMockBucket implements the R2 methods consumed by storage.
    storage = new R2ProjectStorage(
      bucket as R2Bucket,
      createSiteStudioBoundaryContext({ CAIL_LOG_ENV: "test" }),
    );
  });

  describe("createProjectIfAbsent", () => {
    it("creates metadata in R2", async () => {
      const result = await storage.createProjectIfAbsent(userId, projectId, "My Project");
      expect(result.id).toBe(projectId);
      expect(result.name).toBe("My Project");
      expect(result.published).toBe(false);
      expect(result.createdAt).toBeTruthy();

      const stored = bucket.store.get(`projects/${userId}/${projectId}/.metadata.json`);
      expect(stored).toBeTruthy();
    });

    it("SS-42: atomically rejects a second create for the same project id", async () => {
      const first = await storage.createProjectIfAbsent(userId, projectId, "First");

      expect(first).toMatchObject({ id: projectId, name: "First" });
      await expect(
        storage.createProjectIfAbsent(userId, projectId, "Second")
      ).rejects.toBeInstanceOf(ProjectExistsError);
      await expect(storage.getProjectMetadata(userId, projectId)).resolves.toMatchObject({
        id: projectId,
        name: "First"
      });
    });

    it("keeps an owner-mutation create hidden until its operation marker clears", async () => {
      await storage.createProjectIfAbsent(
        userId,
        projectId,
        "Pending",
        "operation-123"
      );
      await storage.writeFile(userId, projectId, "index.html", "<h1>Partial</h1>");

      await expect(storage.projectExists(userId, projectId)).resolves.toBe(false);
      await expect(storage.listProjects(userId)).resolves.not.toContain(projectId);

      await storage.updateProjectMetadata(userId, projectId, {
        creatingOperationId: undefined
      });
      await expect(storage.projectExists(userId, projectId)).resolves.toBe(true);
      await expect(storage.listProjects(userId)).resolves.toContain(projectId);
    });
  });

  describe("projectExists", () => {
    it("returns false for non-existent project", async () => {
      expect(await storage.projectExists(userId, "nope")).toBe(false);
    });

    it("returns true when metadata exists", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "Test");
      expect(await storage.projectExists(userId, projectId)).toBe(true);
    });

    it("returns true when files exist without metadata", async () => {
      await bucket.put(`projects/${userId}/${projectId}/index.html`, "<h1>Hi</h1>");
      expect(await storage.projectExists(userId, projectId)).toBe(true);
    });
  });

  describe("listProjects", () => {
    it("returns projects across paginated delimiter listings", async () => {
      for (let index = 0; index < 7; index += 1) {
        await storage.createProjectIfAbsent(userId, `project-${index}`, `Project ${index}`);
      }

      await expect(storage.listProjects(userId)).resolves.toEqual([
        "project-0",
        "project-1",
        "project-2",
        "project-3",
        "project-4",
        "project-5",
        "project-6"
      ]);
    });
  });

  describe("readFile / writeFile", () => {
    it("rejects system-file writes even with the current metadata ETag", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "Protected");
      const original = await storage.readFileWithEtag(userId, projectId, ".metadata.json");
      if (!original) throw new Error("Missing fixture metadata");
      for (const path of [".metadata.json", "folder/.metadata.json", ".thumbnail.png"]) {
        await expect(storage.writeFile(userId, projectId, path, "changed")).rejects.toThrow("Protected files");
        await expect(storage.writeFileIfMatch(userId, projectId, path, "changed", original.etag)).rejects.toThrow("Protected files");
        await expect(storage.writeFileIfAbsent(userId, projectId, path, "changed")).rejects.toThrow("Protected files");
      }
      expect(await storage.readFileWithEtag(userId, projectId, ".metadata.json")).toEqual(original);
    });
    it("writes and reads a text file", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "Test");
      await storage.writeFile(userId, projectId, "index.html", "<h1>Hello</h1>");
      const content = await storage.readFile(userId, projectId, "index.html");
      expect(content).toBe("<h1>Hello</h1>");
    });

    it("throws on reading non-existent file", async () => {
      await expect(storage.readFile(userId, projectId, "nope.html")).rejects.toThrow("File not found");
    });

    it("SS-40: round-trips content with its ETag and returns null when absent", async () => {
      const etag = await storage.writeFile(userId, projectId, "index.html", "first");

      await expect(storage.readFileWithEtag(userId, projectId, "index.html")).resolves.toEqual({
        content: "first",
        etag
      });
      await expect(storage.readFileWithEtag(userId, projectId, "missing.html")).resolves.toBeNull();
    });

    it("SS-40: conditionally writes only when the expected ETag matches", async () => {
      const firstEtag = await storage.writeFile(userId, projectId, "index.html", "first");
      const nextEtag = await storage.writeFileIfMatch(
        userId,
        projectId,
        "index.html",
        "second",
        firstEtag
      );

      expect(nextEtag).not.toBeNull();
      await expect(
        storage.writeFileIfMatch(userId, projectId, "index.html", "stale", firstEtag)
      ).resolves.toBeNull();
      await expect(storage.readFile(userId, projectId, "index.html")).resolves.toBe("second");
    });

    it("SS-40: put-if-absent refuses to overwrite an existing file", async () => {
      const createdEtag = await storage.writeFileIfAbsent(userId, projectId, "new.txt", "first");

      expect(createdEtag).not.toBeNull();
      await expect(
        storage.writeFileIfAbsent(userId, projectId, "new.txt", "second")
      ).resolves.toBeNull();
      await expect(storage.readFile(userId, projectId, "new.txt")).resolves.toBe("first");
    });
  });

  describe("fileExists", () => {
    it("returns false for missing file", async () => {
      expect(await storage.fileExists(userId, projectId, "missing.html")).toBe(false);
    });

    it("returns true for existing file", async () => {
      await storage.writeFile(userId, projectId, "test.html", "content");
      expect(await storage.fileExists(userId, projectId, "test.html")).toBe(true);
    });
  });

  describe("deleteFile", () => {
    it("removes a file", async () => {
      await storage.writeFile(userId, projectId, "test.html", "content");
      expect(await storage.fileExists(userId, projectId, "test.html")).toBe(true);
      await storage.deleteFile(userId, projectId, "test.html");
      expect(await storage.fileExists(userId, projectId, "test.html")).toBe(false);
    });
  });

  describe("putIfAbsent / uploadToProjectIfAbsent (atomic collision guard)", () => {
    it("writes when the key is free and reports true", async () => {
      const wrote = await storage.uploadToProjectIfAbsent(userId, projectId, "images/a.png", new Uint8Array([1, 2, 3]));
      expect(wrote).toBe(true);
      expect(await storage.fileExists(userId, projectId, "images/a.png")).toBe(true);
    });

    it("refuses to overwrite an existing key and reports false (no clobber)", async () => {
      await storage.uploadToProjectIfAbsent(userId, projectId, "images/a.png", new Uint8Array([1, 2, 3]));
      const second = await storage.uploadToProjectIfAbsent(userId, projectId, "images/a.png", new Uint8Array([9, 9, 9]));
      expect(second).toBe(false);
      // Original bytes survive.
      const buf = await storage.readFileBuffer(userId, projectId, "images/a.png");
      expect(Array.from(buf)).toEqual([1, 2, 3]);
    });

    it("SS-5 race: two concurrent writers to the same key — one wins, one loses, no clobber", async () => {
      const [a, b] = await Promise.all([
        storage.uploadToProjectIfAbsent(userId, projectId, "images/x.png", new Uint8Array([1])),
        storage.uploadToProjectIfAbsent(userId, projectId, "images/x.png", new Uint8Array([2]))
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      expect([a, b].filter((w) => !w)).toHaveLength(1);
    });
  });

  describe("resolvePublishedSlug (atomic slug reservation, SS-5)", () => {
    it("returns the normalized slug when free", async () => {
      const claim = await storage.resolvePublishedSlug(userId, "My Blog!");
      expect(claim.slug).toBe("my-blog");
      expect(claim.etag).toBeTruthy();
    });

    it("suffixes when the desired slug is already published by another project", async () => {
      await storage.createProjectIfAbsent(userId, "p1", "P1");
      await storage.updateProjectMetadata(userId, "p1", { published: true, slug: "blog" });
      const claim = await storage.resolvePublishedSlug(userId, "blog", "p2");
      expect(claim.slug).toBe("blog-2");
    });

    it("is idempotent for the same project re-publishing its slug", async () => {
      const first = await storage.resolvePublishedSlug(userId, "portfolio", "same-proj");
      const second = await storage.resolvePublishedSlug(userId, "portfolio", "same-proj");
      expect(first.slug).toBe("portfolio");
      expect(second.slug).toBe("portfolio");
      expect(second.etag).not.toBe(first.etag);
    });

    it("SS-5 race: two concurrent publishes of different projects can't both take the same slug", async () => {
      const [a, b] = await Promise.all([
        storage.resolvePublishedSlug(userId, "blog", "proj-a"),
        storage.resolvePublishedSlug(userId, "blog", "proj-b")
      ]);
      expect(new Set([a.slug, b.slug]).size).toBe(2); // distinct slugs
      expect([a.slug, b.slug].sort()).toEqual(["blog", "blog-2"]);
    });

    it("reuses an ABANDONED (aged) reservation rather than holding the slug forever", async () => {
      // Seed a stale reservation for "notes" owned by proj-a, older than the
      // in-flight window, to simulate an abandoned/unpublished claim.
      const stale = new Date(Date.now() - 5 * 60_000).toISOString();
      await bucket.put(
        `slugreservations/${userId}/notes.json`,
        JSON.stringify({ projectId: "proj-a", reservedAt: stale })
      );

      // proj-b can reclaim the aged slug.
      const claim = await storage.resolvePublishedSlug(userId, "notes", "proj-b");
      expect(claim.slug).toBe("notes");
    });

    it("does NOT reclaim a FRESH reservation held by another project (concurrency guard holds)", async () => {
      const fresh = new Date().toISOString();
      await bucket.put(
        `slugreservations/${userId}/notes.json`,
        JSON.stringify({ projectId: "proj-a", reservedAt: fresh })
      );
      const claim = await storage.resolvePublishedSlug(userId, "notes", "proj-b");
      expect(claim.slug).toBe("notes-2");
    });
  });

  describe("listFiles", () => {
    it("returns empty list for empty project", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "Test");
      const files = await storage.listFiles(userId, projectId);
      expect(files).toEqual([]);
    });

    it("lists files excluding metadata", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "Test");
      await storage.writeFile(userId, projectId, "index.html", "<h1>Hi</h1>");
      await storage.writeFile(userId, projectId, "styles.css", "body {}");

      const files = await storage.listFiles(userId, projectId);
      expect(files).toHaveLength(2);
      expect(files.map(f => f.path).sort()).toEqual(["index.html", "styles.css"]);
      expect(files.find((file) => file.path === "index.html")).toMatchObject({
        contentType: "text/html",
        isText: true
      });
    });

    it("returns all files across paginated listings", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "Test");
      for (let index = 0; index < 7; index += 1) {
        await storage.writeFile(userId, projectId, `page-${index}.html`, `<h1>${index}</h1>`);
      }

      const files = await storage.listFiles(userId, projectId);
      expect(files.map((file) => file.path)).toEqual([
        "page-0.html",
        "page-1.html",
        "page-2.html",
        "page-3.html",
        "page-4.html",
        "page-5.html",
        "page-6.html"
      ]);
    });

    it("excludes protected files", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "Test");
      await storage.writeFile(userId, projectId, "index.html", "hi");
      // .metadata.json is already excluded by the listing logic
      const files = await storage.listFiles(userId, projectId);
      const names = files.map(f => f.name);
      expect(names).not.toContain(".metadata.json");
      expect(names).not.toContain(".thumbnail.png");
    });

    // SS-7: a list prefix without a trailing slash matches sibling keys — listing
    // "images" also caught "images2.txt" and "images-old/…". The prefix must be a
    // directory boundary.
    it("SS-7: a prefix listing does not include sibling keys sharing the prefix", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "Test");
      await storage.writeFile(userId, projectId, "images/a.png", "A");
      await storage.writeFile(userId, projectId, "images/b.png", "B");
      await storage.writeFile(userId, projectId, "images2.txt", "sibling file");
      await storage.writeFile(userId, projectId, "images-old/c.png", "sibling dir");

      const files = await storage.listFiles(userId, projectId, "images");
      const paths = files.map((f) => f.path).sort();
      expect(paths).toEqual(["images/a.png", "images/b.png"]);
      expect(paths).not.toContain("images2.txt");
      expect(paths.some((p) => p.startsWith("images-old/"))).toBe(false);
    });

    it("SS-7: a prefix already ending in / is not double-slashed", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "Test");
      await storage.writeFile(userId, projectId, "images/a.png", "A");

      const files = await storage.listFiles(userId, projectId, "images/");
      expect(files.map((f) => f.path)).toEqual(["images/a.png"]);
    });

    it("marks binary files as non-text", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "Test");
      await storage.writeFile(userId, projectId, "paper.pdf", new Uint8Array([1, 2, 3]));

      const files = await storage.listFiles(userId, projectId);

      expect(files).toEqual([
        expect.objectContaining({
          path: "paper.pdf",
          contentType: "application/pdf",
          isText: false
        })
      ]);
    });
  });

  describe("renameFile", () => {
    it("renames a file by copy + delete", async () => {
      await storage.writeFile(userId, projectId, "old.html", "content");
      const sourceKey = `projects/${userId}/${projectId}/old.html`;
      const source = bucket.store.get(sourceKey);
      if (!source) throw new Error("source fixture missing");
      source.httpMetadata = {
        contentType: "text/custom",
        cacheControl: "public, max-age=60",
      };
      source.customMetadata = { author: "test" };
      await storage.renameFile(userId, projectId, "old.html", "new.html", { operationId: "rename-op" });

      expect(await storage.fileExists(userId, projectId, "old.html")).toBe(false);
      expect(await storage.fileExists(userId, projectId, "new.html")).toBe(true);

      const content = await storage.readFile(userId, projectId, "new.html");
      expect(content).toBe("content");
      const destination = bucket.store.get(`projects/${userId}/${projectId}/new.html`);
      expect(destination?.httpMetadata).toEqual(source.httpMetadata);
      expect(destination?.customMetadata).toEqual({
        author: "test",
        "site-studio-rename-operation-id": "rename-op",
      });
    });

    it("SS-50: refuses to clobber an existing destination and keeps the source", async () => {
      await storage.writeFile(userId, projectId, "old.html", "source");
      await storage.writeFile(userId, projectId, "taken.html", "already here");

      await expect(storage.renameFile(userId, projectId, "old.html", "taken.html")).rejects.toThrow(
        FileExistsError
      );

      await expect(storage.readFile(userId, projectId, "taken.html")).resolves.toBe("already here");
      await expect(storage.readFile(userId, projectId, "old.html")).resolves.toBe("source");
    });

    it("SS-50: two concurrent renames to the same destination — one wins, the loser's source survives", async () => {
      await storage.writeFile(userId, projectId, "a.html", "content-a");
      await storage.writeFile(userId, projectId, "b.html", "content-b");

      // Both renames pass a probe-then-put fileExists check for "c.html"; only
      // the atomic destination claim makes exactly one win. The old plain-put
      // copy let the second write silently clobber the first, and BOTH deletes
      // then removed both sources — one file's content lost.
      const [a, b] = await Promise.allSettled([
        storage.renameFile(userId, projectId, "a.html", "c.html"),
        storage.renameFile(userId, projectId, "b.html", "c.html")
      ]);

      const outcomes = [a, b];
      expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      // SAFETY: Filtering Promise.allSettled outcomes by status yields rejected results.
      const rejected = outcomes.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(FileExistsError);

      const winner = a.status === "fulfilled"
        ? { source: "a.html", content: "content-a", loserSource: "b.html", loserContent: "content-b" }
        : { source: "b.html", content: "content-b", loserSource: "a.html", loserContent: "content-a" };

      // The winner's content landed and was never clobbered by the loser.
      await expect(storage.readFile(userId, projectId, "c.html")).resolves.toBe(winner.content);
      // The winner's source is gone; the loser's source (and content) survive.
      expect(await storage.fileExists(userId, projectId, winner.source)).toBe(false);
      await expect(storage.readFile(userId, projectId, winner.loserSource)).resolves.toBe(winner.loserContent);
    });
  });

  describe("renameProject", () => {
    it("SS-43: moves files, snapshots, and thumbnail only after every copy succeeds", async () => {
      await storage.createProjectIfAbsent(userId, "old-complete", "Old Complete");
      await storage.writeFile(userId, "old-complete", "index.html", "<h1>Hi</h1>");
      await storage.writeThumbnail(userId, "old-complete", new Uint8Array([137, 80, 78, 71]));
      // SAFETY: This project contains files, so createSnapshot returns a full snapshot.
      const snapshot = (await storage.createSnapshot(userId, "old-complete", {
        trigger: "manual",
        label: "Before rename"
      })) as ProjectSnapshot;

      await storage.renameProject(userId, "old-complete", "new-complete");

      await expect(storage.readFile(userId, "new-complete", "index.html")).resolves.toBe("<h1>Hi</h1>");
      await expect(storage.readThumbnail(userId, "new-complete")).resolves.toEqual(
        new Uint8Array([137, 80, 78, 71])
      );
      await expect(storage.getSnapshot(userId, "new-complete", snapshot.id)).resolves.toMatchObject({
        id: snapshot.id,
        label: "Before rename"
      });
      await expect(storage.projectExists(userId, "old-complete")).resolves.toBe(false);
      expect([...bucket.store.keys()].some((key) => key.startsWith(`snapshots/${userId}/old-complete/`))).toBe(false);
    });

    it("keeps a published rename target hidden until every object is copied", async () => {
      await storage.createProjectIfAbsent(userId, "aaa-source", "Published");
      await storage.writeFile(userId, "aaa-source", "index.html", "complete");
      await storage.updateProjectMetadata(userId, "aaa-source", {
        published: true,
        slug: "published"
      });

      await storage.renameProject(userId, "aaa-source", "zzz-target", {
        afterTargetClaim: async () => {
          expect(await storage.getProjectMetadata(userId, "zzz-target")).toMatchObject({
            published: false,
            slug: "published"
          });
          expect(await storage.listProjects(userId)).not.toContain("zzz-target");
          expect(await storage.fileExists(userId, "zzz-target", "index.html")).toBe(false);
          expect(await storage.findPublishedProjectBySlug(userId, "published")).toMatchObject({
            projectId: "aaa-source"
          });
        },
        beforeSourceDelete: async (activateTarget) => {
          expect(await storage.readFile(userId, "zzz-target", "index.html")).toBe("complete");
          expect(await storage.getProjectMetadata(userId, "zzz-target")).toMatchObject({
            published: false
          });
          await activateTarget();
          expect(await storage.getProjectMetadata(userId, "zzz-target")).toMatchObject({
            published: true
          });
        }
      });

      expect(await storage.projectExists(userId, "aaa-source")).toBe(false);
      expect(await storage.findPublishedProjectBySlug(userId, "published")).toMatchObject({
        projectId: "zzz-target"
      });
    });

    it("SS-43: rolls back a partial target and preserves the source when a snapshot copy fails", async () => {
      await storage.createProjectIfAbsent(userId, "old-atomic", "Old Atomic");
      await storage.writeFile(userId, "old-atomic", "index.html", "source file");
      // SAFETY: This project contains files, so createSnapshot returns a full snapshot.
      const snapshot = (await storage.createSnapshot(userId, "old-atomic", {
        trigger: "manual",
        label: "Source snapshot"
      })) as ProjectSnapshot;
      const failingKey = `snapshots/${userId}/new-atomic/${snapshot.id}.zip`;
      const originalPut = bucket.put;
      // SAFETY: This replacement preserves the R2 put signature while injecting
      // the requested snapshot-copy failure.
      bucket.put = vi.fn(async (key: string, data: R2TestData, options?: R2PutOptions) => {
        if (key === failingKey) {
          throw new Error("snapshot copy failed");
        }
        return originalPut(key, data, options);
      }) as typeof bucket.put;

      await expect(
        storage.renameProject(userId, "old-atomic", "new-atomic")
      ).rejects.toThrow("snapshot copy failed");

      await expect(storage.readFile(userId, "old-atomic", "index.html")).resolves.toBe("source file");
      await expect(storage.getSnapshot(userId, "old-atomic", snapshot.id)).resolves.toMatchObject({
        id: snapshot.id,
        label: "Source snapshot"
      });
      expect(bucket.store.has(`snapshots/${userId}/old-atomic/${snapshot.id}.zip`)).toBe(true);
      expect(bucket.store.has(`projects/${userId}/new-atomic/.metadata.json`)).toBe(false);
      await expect(storage.projectExists(userId, "new-atomic")).resolves.toBe(false);
    });

    // SS-25: thumbnailUrl embeds the project id, so after a rename it must point
    // at the new id (or be cleared), never at the old/now-deleted project.
    it("SS-25: re-points thumbnailUrl to the new project id", async () => {
      await storage.createProjectIfAbsent(userId, "old-id", "Old");
      await storage.writeFile(userId, "old-id", "index.html", "<h1>Hi</h1>");
      await storage.updateProjectMetadata(userId, "old-id", {
        thumbnailUrl: "/api/projects/old-id/thumbnail"
      });

      await storage.renameProject(userId, "old-id", "new-id");

      const metadata = await storage.getProjectMetadata(userId, "new-id");
      expect(metadata?.id).toBe("new-id");
      expect(metadata?.thumbnailUrl).toBe("/api/projects/new-id/thumbnail");
      // The stale reference to the old id is gone.
      expect(metadata?.thumbnailUrl).not.toContain("old-id");
    });

    it("SS-25: leaves thumbnailUrl unset when the old metadata had none", async () => {
      await storage.createProjectIfAbsent(userId, "old-id2", "Old2");
      await storage.writeFile(userId, "old-id2", "index.html", "<h1>Hi</h1>");

      await storage.renameProject(userId, "old-id2", "new-id2");

      const metadata = await storage.getProjectMetadata(userId, "new-id2");
      expect(metadata?.thumbnailUrl).toBeUndefined();
    });

    it("SS-31: throws when the target metadata appears and leaves the target untouched", async () => {
      await storage.createProjectIfAbsent(userId, "old-id3", "Old3");
      await storage.writeFile(userId, "old-id3", "index.html", "<h1>Old</h1>");
      await storage.createProjectIfAbsent(userId, "new-id3", "Existing");
      await storage.writeFile(userId, "new-id3", "index.html", "<h1>Existing</h1>");

      await expect(storage.renameProject(userId, "old-id3", "new-id3")).rejects.toBeInstanceOf(ProjectExistsError);

      const targetMetadata = await storage.getProjectMetadata(userId, "new-id3");
      expect(targetMetadata?.name).toBe("Existing");
      await expect(storage.readFile(userId, "new-id3", "index.html")).resolves.toBe("<h1>Existing</h1>");
      await expect(storage.readFile(userId, "old-id3", "index.html")).resolves.toBe("<h1>Old</h1>");
    });
  });

  describe("deleteProject", () => {
    it("removes all project files and metadata", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "Test");
      await storage.writeFile(userId, projectId, "index.html", "hi");
      await storage.writeFile(userId, projectId, "styles.css", "body {}");

      await storage.deleteProject(userId, projectId);

      expect(await storage.projectExists(userId, projectId)).toBe(false);
    });

    it("removes project and snapshot keys across paginated listings", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "Test");
      for (let index = 0; index < 7; index += 1) {
        await storage.writeFile(userId, projectId, `file-${index}.html`, `<h1>${index}</h1>`);
      }
      const snapshot = await storage.createSnapshot(userId, projectId, { trigger: "manual" });
      expect(isSnapshotSkipped(snapshot)).toBe(false);
      if (!isSnapshotSkipped(snapshot)) {
        expect(snapshot.fileCount).toBe(7);
      }

      await storage.deleteProject(userId, projectId);

      expect([...bucket.store.keys()].filter((key) => key.includes(`/${projectId}/`))).toEqual([]);
    });
  });

  describe("getProjectMetadata / updateProjectMetadata", () => {
    it("returns null for non-existent project", async () => {
      const metadata = await storage.getProjectMetadata(userId, "nope");
      expect(metadata).toBeNull();
    });

    it("returns metadata for existing project", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "My Project");
      const metadata = await storage.getProjectMetadata(userId, projectId);
      expect(metadata?.name).toBe("My Project");
      expect(metadata?.published).toBe(false);
    });

    it("returns null for malformed metadata", async () => {
      await bucket.put(`projects/${userId}/${projectId}/.metadata.json`, "{not valid json");

      await expect(storage.getProjectMetadata(userId, projectId)).resolves.toBeNull();
    });

    it("updates metadata fields", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "My Project");
      const updated = await storage.updateProjectMetadata(userId, projectId, {
        published: true,
        slug: "example"
      });
      expect(updated.published).toBe(true);
      expect(updated.slug).toBe("example");
      expect(updated.name).toBe("My Project"); // preserved
    });

    it("SS-51: refuses to fabricate metadata for a project that does not exist", async () => {
      await expect(storage.updateProjectMetadata(userId, projectId, { name: "New" })).rejects.toThrow(
        ProjectNotFoundError
      );
      // Nothing was written: the ghost record must not exist.
      expect(bucket.store.has(`projects/${userId}/${projectId}/.metadata.json`)).toBe(false);
    });

    it("SS-51: a publish update racing a delete fails instead of resurrecting the project", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "My Project");
      const key = `projects/${userId}/${projectId}/.metadata.json`;
      const originalPut = bucket.put;
      let injected = false;

      // Simulate a concurrent deleteProject landing between the CAS loop's read
      // and its conditional write: the metadata object vanishes, so the
      // etag-matched put loses and the retry observes an absent record.
      // SAFETY: This replacement preserves the R2 put signature while deleting
      // the metadata key to model a concurrent project removal.
      bucket.put = vi.fn(async (putKey: string, data: R2TestData, options?: R2PutOptions) => {
        if (putKey === key && testConditional(options)?.etagMatches && !injected) {
          injected = true;
          bucket.store.delete(key);
        }
        return originalPut(putKey, data, options);
      }) as typeof bucket.put;

      await expect(
        storage.updateProjectMetadata(userId, projectId, { published: true, slug: "blog" })
      ).rejects.toThrow(ProjectNotFoundError);
      // The deleted project stays deleted — no published ghost.
      expect(bucket.store.has(key)).toBe(false);
    });

    it("SS-30: retries a stale metadata write and preserves both concurrent updates", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "My Project");
      const key = `projects/${userId}/${projectId}/.metadata.json`;
      const originalPut = bucket.put;
      let injected = false;

      // SAFETY: This replacement preserves the R2 put signature while injecting
      // one stale-writer race for the metadata CAS loop.
      bucket.put = vi.fn(async (putKey: string, data: R2TestData, options?: R2PutOptions) => {
        if (putKey === key && testConditional(options)?.etagMatches && !injected) {
          injected = true;
          // SAFETY: The metadata object is written by R2ProjectStorage using ProjectMetadata.
          const current = JSON.parse(await (await bucket.get(key))!.text()) as ProjectMetadata;
          await originalPut(key, JSON.stringify({ ...current, thumbnailUrl: "/api/projects/my-project/thumbnail" }), {
            httpMetadata: { contentType: "application/json" }
          });
        }
        return originalPut(putKey, data, options);
      }) as typeof bucket.put;

      const updated = await storage.updateProjectMetadata(userId, projectId, {
        published: true,
        slug: "my-project"
      });

      expect(updated).toMatchObject({
        published: true,
        slug: "my-project",
        thumbnailUrl: "/api/projects/my-project/thumbnail"
      });
      await expect(storage.getProjectMetadata(userId, projectId)).resolves.toMatchObject({
        published: true,
        thumbnailUrl: "/api/projects/my-project/thumbnail"
      });
    });

    it("SS-30: throws after repeated metadata CAS conflicts", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "My Project");
      const key = `projects/${userId}/${projectId}/.metadata.json`;
      const original = await storage.getProjectMetadata(userId, projectId);
      // SAFETY: This replacement preserves the R2 put signature while forcing
      // the metadata CAS conflict path.
      bucket.put = vi.fn(async (putKey: string, _data: R2TestData, options?: R2PutOptions) => {
        if (putKey === key && testConditional(options)) {
          return null;
        }
        return createTestR2Object(putKey, `${putKey}:conflict`);
      }) as typeof bucket.put;

      await expect(storage.updateProjectMetadata(userId, projectId, { published: true })).rejects.toThrow(
        `Concurrent metadata update conflict for ${key}`
      );
      await expect(storage.getProjectMetadata(userId, projectId)).resolves.toEqual(original);
    });
  });

  describe("thumbnail", () => {
    it("writes and reads thumbnail", async () => {
      const data = new Uint8Array([137, 80, 78, 71]); // PNG header bytes
      await storage.writeThumbnail(userId, projectId, data);
      const result = await storage.readThumbnail(userId, projectId);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result?.length).toBe(4);
    });

    it("returns null for missing thumbnail", async () => {
      const result = await storage.readThumbnail(userId, "nope");
      expect(result).toBeNull();
    });
  });

  describe("exportProjectZip", () => {
    it("creates a zip archive of project files", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "Test");
      await storage.writeFile(userId, projectId, "index.html", "<h1>Hello</h1>");
      await storage.writeFile(userId, projectId, "styles.css", "body {}");

      const zip = await storage.exportProjectZip(userId, projectId);
      const entries = unzipSync(new Uint8Array(await new Response(zip).arrayBuffer()));
      expect(Object.keys(entries).sort()).toEqual(["index.html", "styles.css"]);
      expect(new TextDecoder().decode(entries["index.html"])).toBe("<h1>Hello</h1>");
      expect(new TextDecoder().decode(entries["styles.css"])).toBe("body {}");
    });

    it("adds README for projects without index.html", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "Test");
      await storage.writeFile(userId, projectId, "about.html", "<p>About</p>");
      await storage.writeFile(userId, projectId, "README.txt", "authored readme");

      const zip = await storage.exportProjectZip(userId, projectId);
      const entries = unzipSync(new Uint8Array(await new Response(zip).arrayBuffer()));
      expect(new TextDecoder().decode(entries["README.txt"])).toBe("authored readme");
    });

    it("adds a README to an empty project", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "Test");
      const zip = await storage.exportProjectZip(userId, projectId);
      const entries = unzipSync(new Uint8Array(await new Response(zip).arrayBuffer()));
      expect(new TextDecoder().decode(entries["README.txt"])).toBe("This project does not currently include index.html.");
    });

    it("reads on demand and cancels the active R2 body without opening the next file", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "Test");
      await storage.writeFile(userId, projectId, "a.bin", "first");
      await storage.writeFile(userId, projectId, "b.bin", "second");
      const originalGet = bucket.get;
      const read = vi.fn();
      const cancel = vi.fn();
      bucket.get = vi.fn(async (key: string) => {
        const object = await originalGet(key);
        if (!object || !key.endsWith("/a.bin")) return object;
        return Object.assign(object, {
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              read();
              controller.enqueue(crypto.getRandomValues(new Uint8Array(65536)));
            },
            cancel,
          }, { highWaterMark: 0 }),
          arrayBuffer: async () => { throw new Error("Export must stream bodies"); },
        });
      });
      const zip = await storage.exportProjectZip(userId, projectId);
      expect(read).not.toHaveBeenCalled();
      const output = zip.getReader();
      await output.read();
      const readsAfterDemand = read.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(read).toHaveBeenCalledTimes(readsAfterDemand);
      await output.cancel("download abandoned");
      expect(cancel).toHaveBeenCalledWith("download abandoned");
      expect(bucket.get).not.toHaveBeenCalledWith(`projects/${userId}/${projectId}/b.bin`);
    });

    it("fails the output stream when an R2 body fails", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "Test");
      await storage.writeFile(userId, projectId, "index.html", "first");
      const originalGet = bucket.get;
      bucket.get = vi.fn(async (key: string) => {
        const object = await originalGet(key);
        if (!object || !key.endsWith("/index.html")) return object;
        return Object.assign(object, {
          body: new ReadableStream<Uint8Array>({
            pull(controller) { controller.error(new Error("R2 read failed")); },
          }),
        });
      });
      const zip = await storage.exportProjectZip(userId, projectId);
      await expect(new Response(zip).arrayBuffer()).rejects.toThrow("R2 read failed");
    });
  });

  describe("snapshots", () => {
    it("creates and lists snapshots", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "Test");
      await storage.writeFile(userId, projectId, "index.html", "<h1>Hello</h1>");

      const result = await storage.createSnapshot(userId, projectId, {
        trigger: "manual",
        label: "Test snapshot"
      });

      expect(isSnapshotSkipped(result)).toBe(false);
      // SAFETY: The preceding discriminant check establishes the snapshot branch.
      const snapshot = result as ProjectSnapshot;
      expect(snapshot.id).toBeTruthy();
      expect(snapshot.trigger).toBe("manual");
      expect(snapshot.label).toBe("Test snapshot");
      expect(snapshot.fileCount).toBe(1);

      const snapshots = await storage.listSnapshots(userId, projectId);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].id).toBe(snapshot.id);
    });

    it("returns snapshots across paginated listings", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "Test");
      await storage.writeFile(userId, projectId, "index.html", "<h1>Hello</h1>");

      for (let index = 0; index < 7; index += 1) {
        await storage.createSnapshot(userId, projectId, {
          trigger: "manual",
          label: `Snapshot ${index}`
        });
      }

      const snapshots = await storage.listSnapshots(userId, projectId);
      expect(snapshots.map((snapshot) => snapshot.label).sort()).toEqual([
        "Snapshot 0",
        "Snapshot 1",
        "Snapshot 2",
        "Snapshot 3",
        "Snapshot 4",
        "Snapshot 5",
        "Snapshot 6"
      ]);
    });

    it("SS-38: keeps exactly 50 snapshots without pruning at the boundary", async () => {
      vi.useFakeTimers();
      try {
        await storage.createProjectIfAbsent(userId, projectId, "Test");
        await storage.writeFile(userId, projectId, "index.html", "<h1>Hello</h1>");

        for (let index = 0; index < SNAPSHOT_KEEP_COUNT; index += 1) {
          vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 0, index)));
          await storage.createSnapshot(userId, projectId, {
            trigger: "manual",
            label: `Snapshot ${index}`
          });
        }

        const snapshots = await storage.listSnapshots(userId, projectId);
        expect(snapshots).toHaveLength(SNAPSHOT_KEEP_COUNT);
        expect(snapshots.map((snapshot) => snapshot.label)).toEqual(
          Array.from({ length: SNAPSHOT_KEEP_COUNT }, (_, index) => `Snapshot ${SNAPSHOT_KEEP_COUNT - 1 - index}`)
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("SS-38: prunes exactly the oldest archive and metadata on the 51st snapshot", async () => {
      vi.useFakeTimers();
      try {
        await storage.createProjectIfAbsent(userId, projectId, "Test");
        await storage.writeFile(userId, projectId, "index.html", "<h1>Hello</h1>");

        const created: ProjectSnapshot[] = [];
        for (let index = 0; index < SNAPSHOT_KEEP_COUNT; index += 1) {
          vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 0, index)));
          // SAFETY: Each seeded project contains a file, so snapshot creation succeeds.
          created.push(
            (await storage.createSnapshot(userId, projectId, {
              trigger: "manual",
              label: `Snapshot ${index}`
            })) as ProjectSnapshot
          );
        }

        vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 0, SNAPSHOT_KEEP_COUNT)));
        // SAFETY: The project has a file, so this snapshot cannot be skipped.
        const newest = (await storage.createSnapshot(userId, projectId, {
          trigger: "manual",
          label: `Snapshot ${SNAPSHOT_KEEP_COUNT}`
        })) as ProjectSnapshot;

        const oldest = created[0];
        expect(bucket.store.has(`snapshots/${userId}/${projectId}/${oldest.id}.zip`)).toBe(false);
        expect(bucket.store.has(`snapshots/${userId}/${projectId}/${oldest.id}.json`)).toBe(false);

        const snapshots = await storage.listSnapshots(userId, projectId);
        expect(snapshots).toHaveLength(SNAPSHOT_KEEP_COUNT);
        expect(new Set(snapshots.map((snapshot) => snapshot.id))).toEqual(
          new Set([...created.slice(1), newest].map((snapshot) => snapshot.id))
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("SS-39: lists modern snapshots without GETs for snapshot metadata objects", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "Test");
      await storage.writeFile(userId, projectId, "index.html", "<h1>Hello</h1>");

      for (let index = 0; index < 4; index += 1) {
        await storage.createSnapshot(userId, projectId, {
          trigger: "manual",
          label: `Snapshot ${index}`
        });
      }

      // SAFETY: createMockBucket exposes get as a Vitest mock for call inspection.
      const getMock = bucket.get as ReturnType<typeof vi.fn>;
      getMock.mockClear();

      const snapshots = await storage.listSnapshots(userId, projectId);
      const snapshotMetadataGets = getMock.mock.calls.filter(([key]) =>
        String(key).startsWith(`snapshots/${userId}/${projectId}/`) && String(key).endsWith(".json")
      );
      expect(snapshots).toHaveLength(4);
      expect(snapshotMetadataGets).toHaveLength(0);
    });

    it("SS-39: falls back to one GET for a legacy snapshot without custom metadata", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "Test");
      await storage.writeFile(userId, projectId, "index.html", "<h1>Hello</h1>");

      await storage.createSnapshot(userId, projectId, {
        trigger: "manual",
        label: "Modern 1"
      });
      await storage.createSnapshot(userId, projectId, {
        trigger: "manual",
        label: "Modern 2"
      });

      const legacy: ProjectSnapshot = {
        id: "legacy-snapshot",
        createdAt: "2026-01-01T00:00:00.000Z",
        projectId,
        trigger: "manual",
        label: "Legacy",
        fileCount: 1
      };
      await bucket.put(`snapshots/${userId}/${projectId}/${legacy.id}.json`, JSON.stringify(legacy), {
        httpMetadata: { contentType: "application/json" }
      });

      // SAFETY: createMockBucket exposes get as a Vitest mock for call inspection.
      const getMock = bucket.get as ReturnType<typeof vi.fn>;
      getMock.mockClear();

      const snapshots = await storage.listSnapshots(userId, projectId);
      const snapshotMetadataGets = getMock.mock.calls.filter(([key]) =>
        String(key).startsWith(`snapshots/${userId}/${projectId}/`) && String(key).endsWith(".json")
      );
      expect(snapshots.map((snapshot) => snapshot.label).sort()).toEqual(["Legacy", "Modern 1", "Modern 2"]);
      expect(snapshotMetadataGets).toEqual([[`snapshots/${userId}/${projectId}/${legacy.id}.json`]]);
    });

    it("SS-38: returns the created snapshot when prune delete fails, then converges on the next create", async () => {
      vi.useFakeTimers();
      // The prune failure is surfaced through the structured Worker sink.
      const logSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await storage.createProjectIfAbsent(userId, projectId, "Test");
        await storage.writeFile(userId, projectId, "index.html", "<h1>Hello</h1>");

        for (let index = 0; index < SNAPSHOT_KEEP_COUNT; index += 1) {
          vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 0, index)));
          await storage.createSnapshot(userId, projectId, {
            trigger: "manual",
            label: `Snapshot ${index}`
          });
        }

        // SAFETY: createMockBucket exposes delete as a Vitest mock for failure injection.
        const deleteMock = bucket.delete as ReturnType<typeof vi.fn>;
        deleteMock.mockImplementationOnce(async () => {
          throw new Error("delete failed");
        });

        vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 1, 0)));
        const resilient = await storage.createSnapshot(userId, projectId, {
          trigger: "manual",
          label: "Resilient"
        });
        expect(isSnapshotSkipped(resilient)).toBe(false);
        // SAFETY: The preceding discriminant check establishes the snapshot branch.
        expect((resilient as ProjectSnapshot).label).toBe("Resilient");
        expect(
          logSpy.mock.calls.some(([event]) => {
            // SAFETY: Structured logging emits concrete scalar diagnostic fields.
            const record = event as DiagnosticEvent;
            return (
              record["event.name"] === "site_studio.diagnostic.warning" &&
              record["error.type"] === "snapshot_prune_failed"
            );
          })
        ).toBe(true);
        expect(await storage.listSnapshots(userId, projectId)).toHaveLength(SNAPSHOT_KEEP_COUNT + 1);

        vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 1, 1)));
        await storage.createSnapshot(userId, projectId, {
          trigger: "manual",
          label: "Converges"
        });

        const snapshots = await storage.listSnapshots(userId, projectId);
        expect(snapshots).toHaveLength(SNAPSHOT_KEEP_COUNT);
        expect(snapshots.some((snapshot) => snapshot.label === "Converges")).toBe(true);
        expect(snapshots.some((snapshot) => snapshot.label === "Resilient")).toBe(true);
        expect(snapshots.some((snapshot) => snapshot.label === "Snapshot 0")).toBe(false);
        expect(snapshots.some((snapshot) => snapshot.label === "Snapshot 1")).toBe(false);
      } finally {
        logSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it("removes an archive when snapshot metadata fails before committing", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "Test");
      await storage.writeFile(userId, projectId, "index.html", "<h1>Hello</h1>");

      const originalPut = bucket.put;
      // SAFETY: This replacement preserves the R2 put signature while injecting
      // the requested snapshot-metadata failure.
      bucket.put = vi.fn(async (key: string, data: R2TestData, options?: R2PutOptions) => {
        if (key.startsWith(`snapshots/${userId}/${projectId}/`) && key.endsWith(".json")) {
          throw new Error("snapshot metadata write failed");
        }
        return originalPut(key, data, options);
      }) as typeof bucket.put;

      await expect(storage.createSnapshot(userId, projectId, { trigger: "manual" })).rejects.toThrow(
        "snapshot metadata write failed",
      );
      expect([...bucket.store.keys()].some((key) =>
        key.startsWith(`snapshots/${userId}/${projectId}/`) && key.endsWith(".zip")
      )).toBe(false);
    });

    it("sweeps an orphan archive after metadata-first prune deletion fails", async () => {
      vi.useFakeTimers();
      try {
        await storage.createProjectIfAbsent(userId, projectId, "Test");
        await storage.writeFile(userId, projectId, "index.html", "<h1>Hello</h1>");

        const created: ProjectSnapshot[] = [];
        for (let index = 0; index < SNAPSHOT_KEEP_COUNT; index += 1) {
          vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 0, index)));
          // SAFETY: The project has a file, so this snapshot cannot be skipped.
          created.push((await storage.createSnapshot(userId, projectId, {
            trigger: "manual",
            label: `Snapshot ${index}`,
          })) as ProjectSnapshot);
        }

        const oldestArchiveKey = `snapshots/${userId}/${projectId}/${created[0].id}.zip`;
        const originalDelete = bucket.delete;
        let failed = false;
        // SAFETY: This replacement preserves the R2 delete signature while
        // injecting the requested archive-delete failure.
        bucket.delete = vi.fn(async (key: string) => {
          if (!failed && key === oldestArchiveKey) {
            failed = true;
            throw new Error("archive delete failed");
          }
          return originalDelete(key);
        }) as typeof bucket.delete;

        vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 1, 0)));
        await storage.createSnapshot(userId, projectId, { trigger: "manual", label: "After failure" });
        expect(bucket.store.has(oldestArchiveKey)).toBe(true);

        vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 1, 1)));
        await storage.createSnapshot(userId, projectId, { trigger: "manual", label: "Converged" });
        expect(bucket.store.has(oldestArchiveKey)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("retains an archive paired with malformed metadata for recovery", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "Test");
      await storage.writeFile(userId, projectId, "index.html", "<h1>Hello</h1>");

      const corruptMetadataKey = `snapshots/${userId}/${projectId}/corrupt.json`;
      const corruptArchiveKey = `snapshots/${userId}/${projectId}/corrupt.zip`;
      await bucket.put(corruptMetadataKey, "{not valid snapshot metadata", {
        httpMetadata: { contentType: "application/json" },
      });
      await bucket.put(corruptArchiveKey, new Uint8Array([1, 2, 3]), {
        httpMetadata: { contentType: "application/zip" },
      });

      await storage.createSnapshot(userId, projectId, { trigger: "manual" });

      expect(bucket.store.has(corruptMetadataKey)).toBe(true);
      expect(bucket.store.has(corruptArchiveKey)).toBe(true);
    });

    it("returns empty list when no snapshots exist", async () => {
      const snapshots = await storage.listSnapshots(userId, projectId);
      expect(snapshots).toEqual([]);
    });

    it("restores a snapshot", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "Test");
      await storage.writeFile(userId, projectId, "index.html", "<h1>Original</h1>");

      // SAFETY: This project contains files, so createSnapshot returns a full snapshot.
    // SAFETY: This project contains files, so createSnapshot returns a full snapshot.
    const snapshot = (await storage.createSnapshot(userId, projectId, {
        trigger: "manual"
    })) as ProjectSnapshot;

      // Modify the file
      await storage.writeFile(userId, projectId, "index.html", "<h1>Modified</h1>");
      await storage.writeFile(userId, projectId, "extra.css", "body {}");

      // Restore
      await storage.restoreSnapshot(userId, projectId, snapshot.id);

      const content = await storage.readFile(userId, projectId, "index.html");
      expect(content).toBe("<h1>Original</h1>");

      // Extra file should be deleted
      expect(await storage.fileExists(userId, projectId, "extra.css")).toBe(false);
    });

    it("rolls back every partial write when restoring a snapshot fails", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "Test");
      await storage.writeFile(userId, projectId, "a.txt", "snapshot-a");
      await storage.writeFile(userId, projectId, "b.txt", "snapshot-b");
      // SAFETY: This project contains files, so createSnapshot returns a full snapshot.
      const snapshot = (await storage.createSnapshot(userId, projectId, {
        trigger: "manual"
      })) as ProjectSnapshot;

      await storage.writeFile(userId, projectId, "a.txt", "current-a");
      await storage.writeFile(userId, projectId, "b.txt", "current-b");
      await storage.writeFile(userId, projectId, "extra.txt", "current-extra");

      // SAFETY: createMockBucket exposes put as a Vitest mock for failure injection.
      const putMock = bucket.put as ReturnType<typeof vi.fn>;
      const originalPut = putMock.getMockImplementation();
      if (!originalPut) throw new Error("R2 put fixture implementation is missing");
      // SAFETY: Vitest exposes this fixture's R2 put implementation as a
      // callable function; the constructor overload is not used here.
      const passThroughPut = originalPut as (
        key: string,
        data: R2TestData,
        options?: R2PutOptions,
      ) => Promise<R2Object | null>;
      let injected = false;
      putMock.mockImplementation(async (key: string, data: R2TestData, options?: R2PutOptions) => {
        if (key.endsWith("/b.txt") && !injected) {
          injected = true;
          throw new Error("restore write failed");
        }
        return passThroughPut(key, data, options);
      });

      await expect(storage.restoreSnapshot(userId, projectId, snapshot.id)).rejects.toThrow(
        "restore write failed"
      );
      await expect(storage.readFile(userId, projectId, "a.txt")).resolves.toBe("current-a");
      await expect(storage.readFile(userId, projectId, "b.txt")).resolves.toBe("current-b");
      await expect(storage.readFile(userId, projectId, "extra.txt")).resolves.toBe("current-extra");
    });

    it("rolls back overwritten and deleted files when a restore delete fails", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "Test");
      await storage.writeFile(userId, projectId, "index.html", "snapshot");
      // SAFETY: This project contains a file, so createSnapshot returns a full snapshot.
      const snapshot = (await storage.createSnapshot(userId, projectId, {
        trigger: "manual"
      })) as ProjectSnapshot;

      await storage.writeFile(userId, projectId, "index.html", "current");
      await storage.writeFile(userId, projectId, "extra.txt", "keep me");

      // SAFETY: createMockBucket exposes delete as a Vitest mock for failure injection.
      const deleteMock = bucket.delete as ReturnType<typeof vi.fn>;
      const originalDelete = bucket.delete;
      let injected = false;
      deleteMock.mockImplementation(async (key: string) => {
        if (key.endsWith("/extra.txt") && !injected) {
          injected = true;
          throw new Error("restore delete failed");
        }
        return originalDelete(key);
      });

      await expect(storage.restoreSnapshot(userId, projectId, snapshot.id)).rejects.toThrow(
        "restore delete failed"
      );
      await expect(storage.readFile(userId, projectId, "index.html")).resolves.toBe("current");
      await expect(storage.readFile(userId, projectId, "extra.txt")).resolves.toBe("keep me");
    });

    it("throws when restoring non-existent snapshot", async () => {
      await expect(
        storage.restoreSnapshot(userId, projectId, "nonexistent")
      ).rejects.toThrow("Snapshot not found");
    });

    it("getSnapshot returns null for non-existent snapshot", async () => {
      const result = await storage.getSnapshot(userId, projectId, "nope");
      expect(result).toBeNull();
    });

    // SS-28: a project under MAX_SNAPSHOT_BYTES snapshots normally; a project
    // over it SKIPS (no read+zip of every file) and returns a visible skip
    // signal instead of a ProjectSnapshot.
    it("SS-28: snapshots a project under MAX_SNAPSHOT_BYTES normally", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "Small");
      await storage.writeFile(userId, projectId, "index.html", "<h1>Small site</h1>");

      const result = await storage.createSnapshot(userId, projectId, { trigger: "agent" });

      expect(isSnapshotSkipped(result)).toBe(false);
      const snapshots = await storage.listSnapshots(userId, projectId);
      expect(snapshots).toHaveLength(1);
    });

    it("SS-28: skips (visibly) when the project exceeds MAX_SNAPSHOT_BYTES and writes no archive", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "Huge");
      // One oversized file pushes the summed project size past the cap.
      const oversized = "x".repeat(MAX_SNAPSHOT_BYTES + 1);
      await storage.writeFile(userId, projectId, "big.txt", oversized);

      // The skip is surfaced through the structured Worker sink.
      const logSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = await storage.createSnapshot(userId, projectId, { trigger: "agent" });

      // Skip is signalled, not silent.
      expect(isSnapshotSkipped(result)).toBe(true);
      if (isSnapshotSkipped(result)) {
        expect(result.reason).toBe("too-large");
        expect(result.totalBytes).toBeGreaterThan(MAX_SNAPSHOT_BYTES);
        expect(result.limitBytes).toBe(MAX_SNAPSHOT_BYTES);
      }
      expect(
        logSpy.mock.calls.some(([event]) => {
          // SAFETY: Structured logging emits concrete scalar diagnostic fields.
          const record = event as DiagnosticEvent;
          return (
            record["event.name"] === "site_studio.diagnostic.warning" &&
            record["error.type"] === "snapshot_too_large"
          );
        })
      ).toBe(true);
      logSpy.mockRestore();

      // No snapshot archive/metadata was written for the skipped turn.
      const snapshots = await storage.listSnapshots(userId, projectId);
      expect(snapshots).toHaveLength(0);
    });
  });

  describe("findPublishedProjectBySlug", () => {
    it("returns null when no published project matches", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "Test");
      const result = await storage.findPublishedProjectBySlug(userId, "my-slug");
      expect(result).toBeNull();
    });

    it("finds published project by slug", async () => {
      await storage.createProjectIfAbsent(userId, projectId, "Test");
      await storage.updateProjectMetadata(userId, projectId, {
        published: true,
        slug: "my-slug"
      });

      const result = await storage.findPublishedProjectBySlug(userId, "my-slug");
      expect(result).toBeTruthy();
      expect(result!.projectId).toBe(projectId);
    });
  });
});

describe("OwnerMutationService recovery journal", () => {
  function journalStore() {
    const values = new Map<string, unknown>();
    const store: MutationJournalStore & { values: Map<string, unknown> } = {
      values,
      async get<T>(key: string) {
        // SAFETY: The journal service reads values through its generic store contract.
        return values.get(key) as T | undefined;
      },
      async put<T>(key: string, value: T) { values.set(key, value); },
      async delete(key: string) { return values.delete(key); }
    };
    return store;
  }

  it("model read/edit and owner CAS cannot rewrite metadata while authored edits persist", async () => {
    const bucket = createMockBucket();
    const storage = new R2ProjectStorage(bucket);
    const service = new OwnerMutationService(bucket, journalStore());
    await storage.createProjectIfAbsent("user-a", "site", "Protected");
    await storage.writeFile("user-a", "site", "index.html", "before");
    const tools = createProjectTools(
      { SITE_STUDIO_BUCKET: bucket }, { userId: "user-a", projectId: "site" }, null,
      undefined, undefined, undefined, undefined, storage,
      (ownerId, operation) => service.execute(ownerId, operation),
    );
    const options = { toolCallId: "metadata-regression", messages: [] };
    const original = await storage.readFileWithEtag("user-a", "site", ".metadata.json");
    if (!original || !tools.read_file.execute || !tools.edit_file.execute) throw new Error("Missing fixture");
    expect(await tools.read_file.execute({ path: ".metadata.json" }, options)).toMatchObject({ ok: true, content: original.content });
    expect(await tools.edit_file.execute({ path: ".metadata.json", oldText: "Protected", newText: "changed", replaceAll: false }, options)).toMatchObject({ ok: false });
    await expect(service.execute("user-a", {
      type: "write-file", projectId: "site", path: ".metadata.json", baseEtag: original.etag,
      content: original.content.replace('"published":false', '"published":true'),
    })).rejects.toThrow("Protected files");
    expect(await storage.readFileWithEtag("user-a", "site", ".metadata.json")).toEqual(original);
    expect(await tools.edit_file.execute({ path: "index.html", oldText: "before", newText: "after", replaceAll: false }, options)).toMatchObject({ ok: true });
    expect(await storage.readFile("user-a", "site", "index.html")).toBe("after");
  });

  it("compensates a partially scaffolded project when a template write fails", async () => {
    const bucket = createMockBucket();
    const journal = journalStore();
    const service = new OwnerMutationService(bucket, journal);
    const originalPut = bucket.put;
    // SAFETY: This replacement preserves the R2 put signature while injecting
    // the template-write failure.
    bucket.put = vi.fn(async (key: string, data: R2TestData, options?: R2PutOptions) => {
      if (key.endsWith("/styles.css")) throw new Error("injected R2 failure");
      return originalPut(key, data, options);
    });

    await expect(service.execute("user-a", {
      type: "create-project",
      projectId: "new-site",
      name: "New Site",
      files: { "index.html": "home", "styles.css": "body{}" }
    })).rejects.toThrow("injected R2 failure");

    expect([...bucket.store.keys()].filter((key) => key.startsWith("projects/user-a/new-site/"))).toEqual([]);
    expect(journal.values.size).toBe(0);
  });

  it("preserves a destination that does not carry the interrupted create operation id", async () => {
    const bucket = createMockBucket();
    const storage = new R2ProjectStorage(bucket);
    const journal = journalStore();
    await storage.createProjectIfAbsent("user-a", "existing", "Existing");
    await storage.writeFile("user-a", "existing", "index.html", "keep me");
    journal.values.set("owner-mutation", {
      type: "create",
      projectId: "existing",
      operationId: "different-operation"
    });

    const service = new OwnerMutationService(bucket, journal);
    await service.recover("user-a");

    expect(await storage.readFile("user-a", "existing", "index.html")).toBe("keep me");
    expect(await storage.projectExists("user-a", "existing")).toBe(true);
    expect(journal.values.size).toBe(0);
  });

  it("does not delete a complete project for an operation-less create journal", async () => {
    const bucket = createMockBucket();
    const storage = new R2ProjectStorage(bucket);
    const journal = journalStore();
    await storage.createProjectIfAbsent("user-a", "existing", "Existing");
    await storage.writeFile("user-a", "existing", "index.html", "keep me");
    journal.values.set("owner-mutation", { type: "create", projectId: "existing" });

    const service = new OwnerMutationService(bucket, journal);
    await service.recover("user-a");

    await expect(storage.readFile("user-a", "existing", "index.html")).resolves.toBe("keep me");
    expect(journal.values.size).toBe(0);
  });

  it("finishes the committed half of an interrupted file rename before the next mutation", async () => {
    const bucket = createMockBucket();
    const storage = new R2ProjectStorage(bucket);
    const journal = journalStore();
    await storage.createProjectIfAbsent("user-a", "site", "Site");
    await storage.writeFile("user-a", "site", "old.txt", "content");
    await storage.writeFile("user-a", "site", "new.txt", "content");
    journal.values.set("owner-mutation", {
      type: "rename-file",
      projectId: "site",
      oldPath: "old.txt",
      newPath: "new.txt",
      operationId: "rename-op",
      stage: "committing"
    });
    bucket.store.get("projects/user-a/site/new.txt")!.customMetadata = {
      "site-studio-rename-operation-id": "rename-op"
    };

    const service = new OwnerMutationService(bucket, journal);
    await service.execute("user-a", { type: "delete-file", projectId: "site", path: "unrelated.txt" });

    expect(await storage.fileExists("user-a", "site", "old.txt")).toBe(false);
    expect(await storage.readFile("user-a", "site", "new.txt")).toBe("content");
    expect(journal.values.size).toBe(0);
  });

  it("does not delete an unowned destination during file-rename recovery", async () => {
    const bucket = createMockBucket();
    const storage = new R2ProjectStorage(bucket);
    const journal = journalStore();
    await storage.createProjectIfAbsent("user-a", "site", "Site");
    await storage.writeFile("user-a", "site", "old.txt", "source");
    await storage.writeFile("user-a", "site", "new.txt", "unowned destination");
    journal.values.set("owner-mutation", {
      type: "rename-file",
      projectId: "site",
      oldPath: "old.txt",
      newPath: "new.txt",
      operationId: "different-operation",
      stage: "committing"
    });

    const service = new OwnerMutationService(bucket, journal);
    await service.recover("user-a");

    await expect(storage.readFile("user-a", "site", "old.txt")).resolves.toBe("source");
    await expect(storage.readFile("user-a", "site", "new.txt")).resolves.toBe("unowned destination");
    expect(journal.values.size).toBe(0);
  });

  it("recovers a file rename when the committing journal write fails after claiming the destination", async () => {
    const bucket = createMockBucket();
    const storage = new R2ProjectStorage(bucket);
    const journal = journalStore();
    await storage.createProjectIfAbsent("user-a", "site", "Site");
    await storage.writeFile("user-a", "site", "old.txt", "source");

    let ownerJournalWrites = 0;
    const originalJournalPut = journal.put.bind(journal);
    journal.put = vi.fn(async <T>(key: string, value: T) => {
      if (key === "owner-mutation") {
        ownerJournalWrites += 1;
        if (ownerJournalWrites === 2) throw new Error("journal commit failed");
      }
      await originalJournalPut(key, value);
    });

    const service = new OwnerMutationService(bucket, journal);
    await expect(service.execute("user-a", {
      type: "rename-file",
      projectId: "site",
      oldPath: "old.txt",
      newPath: "new.txt"
    })).rejects.toThrow("journal commit failed");

    await expect(storage.readFile("user-a", "site", "old.txt")).resolves.toBe("source");
    expect(await storage.fileExists("user-a", "site", "new.txt")).toBe(false);
    expect(journal.values.size).toBe(0);
  });

  it("does not write orphan files after a serialized project deletion", async () => {
    const bucket = createMockBucket();
    const storage = new R2ProjectStorage(bucket);
    const service = new OwnerMutationService(bucket, journalStore());
    await storage.createProjectIfAbsent("user-a", "site", "Site");
    await service.execute("user-a", { type: "delete-project", projectId: "site" });

    await expect(service.execute("user-a", {
      type: "write-file",
      projectId: "site",
      path: "index.html",
      content: "orphan",
      baseEtag: "missing-project-etag"
    })).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(await storage.fileExists("user-a", "site", "index.html")).toBe(false);
  });

  it("does not report deletion complete until private chat history is cleared", async () => {
    const bucket = createMockBucket();
    const storage = new R2ProjectStorage(bucket);
    const journal = journalStore();
    let clearFails = true;
    const history = {
      clear: vi.fn(async () => {
        if (clearFails) throw new Error("injected history failure");
      }),
      move: vi.fn(async () => undefined)
    };
    const service = new OwnerMutationService(bucket, journal, undefined, history);
    await storage.createProjectIfAbsent("user-a", "site", "Site");

    await expect(service.execute("user-a", {
      type: "delete-project",
      projectId: "site"
    })).rejects.toThrow("injected history failure");

    expect(await storage.projectExists("user-a", "site")).toBe(true);
    expect(journal.values.get("owner-mutation")).toEqual({
      type: "delete",
      projectId: "site"
    });

    clearFails = false;
    await service.recover("user-a");
    expect(await storage.projectExists("user-a", "site")).toBe(false);
    expect(history.clear).toHaveBeenCalledTimes(2);
    expect(journal.values.size).toBe(0);
  });

  it("moves private chat history before committing a project rename", async () => {
    const bucket = createMockBucket();
    const storage = new R2ProjectStorage(bucket);
    const journal = journalStore();
    let moveFails = true;
    const history = {
      clear: vi.fn(async () => undefined),
      move: vi.fn(async () => {
        expect(await storage.projectExists("user-a", "source")).toBe(true);
        expect(await storage.projectExists("user-a", "target")).toBe(true);
        if (moveFails) throw new Error("injected history move failure");
      })
    };
    const service = new OwnerMutationService(bucket, journal, undefined, history);
    await storage.createProjectIfAbsent("user-a", "source", "Site");
    await storage.writeFile("user-a", "source", "index.html", "complete");

    await expect(service.execute("user-a", {
      type: "rename-project",
      projectId: "source",
      nextProjectId: "target",
      name: "Renamed"
    })).rejects.toThrow("injected history move failure");

    expect(journal.values.get("owner-mutation")).toMatchObject({
      type: "rename-project",
      stage: "committing"
    });
    moveFails = false;
    await service.recover("user-a");
    expect(await storage.projectExists("user-a", "source")).toBe(false);
    expect(await storage.projectExists("user-a", "target")).toBe(true);
    expect(history.move).toHaveBeenCalledTimes(3);
    expect(journal.values.size).toBe(0);
  });

  it("clears an activation journal when the owned target is rolled back", async () => {
    const bucket = createMockBucket();
    const storage = new R2ProjectStorage(bucket);
    const journal = journalStore();
    await storage.createProjectIfAbsent("user-a", "source", "Site");
    await storage.writeFile("user-a", "source", "index.html", "complete");

    const targetMetadataKey = "projects/user-a/target/.metadata.json";
    const originalPut = bucket.put;
    let failActivation = true;
    // SAFETY: This replacement preserves the R2 put signature while failing
    // only the existing target metadata update that activates the rename.
    bucket.put = vi.fn(async (key: string, data: R2TestData, options?: R2PutOptions) => {
      if (failActivation && key === targetMetadataKey && bucket.store.has(key)) {
        throw new Error("activation failed");
      }
      return originalPut(key, data, options);
    }) as typeof bucket.put;

    const service = new OwnerMutationService(bucket, journal);
    await expect(service.execute("user-a", {
      type: "rename-project",
      projectId: "source",
      nextProjectId: "target",
      name: "Site"
    })).rejects.toThrow("activation failed");

    await expect(storage.readFile("user-a", "source", "index.html")).resolves.toBe("complete");
    await expect(storage.projectExists("user-a", "target")).resolves.toBe(false);
    expect(journal.values.size).toBe(0);

    failActivation = false;
    await expect(service.execute("user-a", {
      type: "rename-project",
      projectId: "source",
      nextProjectId: "target",
      name: "Site"
    })).resolves.toEqual({ ok: true });
    await expect(storage.readFile("user-a", "target", "index.html")).resolves.toBe("complete");
  });

  it("fences a published project before deleting any of its files", async () => {
    const bucket = createMockBucket();
    const storage = new R2ProjectStorage(bucket);
    const journal = journalStore();
    const service = new OwnerMutationService(bucket, journal);
    await storage.createProjectIfAbsent("user-a", "site", "Site");
    await storage.writeFile("user-a", "site", "index.html", "public");
    await storage.updateProjectMetadata("user-a", "site", {
      published: true,
      slug: "site"
    });

    const originalDelete = bucket.delete;
    let failed = false;
    // SAFETY: This replacement preserves the R2 delete signature while injecting
    // the deletion failure.
    bucket.delete = vi.fn(async (key: string) => {
      if (!failed && key.endsWith("/index.html")) {
        failed = true;
        throw new Error("injected delete failure");
      }
      return originalDelete(key);
    });

    await expect(service.execute("user-a", {
      type: "delete-project",
      projectId: "site"
    })).rejects.toThrow("injected delete failure");

    expect(await storage.getProjectMetadata("user-a", "site")).toMatchObject({
      published: false
    });
    expect(await storage.findPublishedProjectBySlug("user-a", "site")).toBeNull();
    expect(await storage.fileExists("user-a", "site", "index.html")).toBe(true);
    expect(journal.values.get("owner-mutation")).toEqual({
      type: "delete",
      projectId: "site"
    });

    bucket.delete = originalDelete;
    await service.execute("user-a", {
      type: "delete-project",
      projectId: "site"
    });
    expect(await storage.projectExists("user-a", "site")).toBe(false);
    expect(journal.values.size).toBe(0);
  });

  it("journals published rename activation before switching visibility", async () => {
    const bucket = createMockBucket();
    const storage = new R2ProjectStorage(bucket);
    const journal = journalStore();
    const service = new OwnerMutationService(bucket, journal);
    await storage.createProjectIfAbsent("user-a", "aaa-source", "Site");
    await storage.writeFile("user-a", "aaa-source", "index.html", "complete");
    await service.execute("user-a", {
      type: "publish-project",
      projectId: "aaa-source",
      desiredSlug: "site"
    });

    const phases: Array<{
      stage: string;
      sourcePublished: boolean | undefined;
      targetPublished: boolean | undefined;
      targetHasFile: boolean;
    }> = [];
    const originalJournalPut = journal.put.bind(journal);
    // SAFETY: This replacement preserves MutationJournalStore.put while recording
    // the typed rename-project lifecycle entries.
    journal.put = vi.fn(async <T>(key: string, value: T) => {
      // SAFETY: The lifecycle assertions only inspect rename-project journal entries.
      const record = value as { type?: string; stage?: string };
      if (record.type === "rename-project" && record.stage) {
        phases.push({
          stage: record.stage,
          sourcePublished: (await storage.getProjectMetadata("user-a", "aaa-source"))?.published,
          targetPublished: (await storage.getProjectMetadata("user-a", "zzz-target"))?.published,
          targetHasFile: await storage.fileExists("user-a", "zzz-target", "index.html")
        });
      }
      await originalJournalPut(key, value);
    }) as MutationJournalStore["put"];

    await service.execute("user-a", {
      type: "rename-project",
      projectId: "aaa-source",
      nextProjectId: "zzz-target",
      name: "Site"
    });

    expect(phases).toEqual([
      {
        stage: "preparing",
        sourcePublished: true,
        targetPublished: undefined,
        targetHasFile: false
      },
      {
        stage: "activating",
        sourcePublished: true,
        targetPublished: false,
        targetHasFile: true
      },
      {
        stage: "committing",
        sourcePublished: false,
        targetPublished: true,
        targetHasFile: true
      }
    ]);
    expect(await storage.projectExists("user-a", "aaa-source")).toBe(false);
    expect(await storage.findPublishedProjectBySlug("user-a", "site")).toMatchObject({
      projectId: "zzz-target"
    });
  });

  it("rolls an interrupted published rename activation forward", async () => {
    const bucket = createMockBucket();
    const storage = new R2ProjectStorage(bucket);
    const journal = journalStore();
    const service = new OwnerMutationService(bucket, journal);
    await storage.createProjectIfAbsent("user-a", "source", "Site");
    await storage.writeFile("user-a", "source", "index.html", "complete");
    await service.execute("user-a", {
      type: "publish-project",
      projectId: "source",
      desiredSlug: "site"
    });
    await storage.createProjectIfAbsent("user-a", "target", "Site");
    await storage.writeFile("user-a", "target", "index.html", "complete");
    await storage.updateProjectMetadata("user-a", "target", {
      published: false,
      slug: "site"
    });
    journal.values.set("owner-mutation", {
      type: "rename-project",
      projectId: "source",
      nextProjectId: "target",
      name: "Site",
      operationId: "rename-op",
      slug: "site",
      published: true,
      stage: "activating"
    });

    await service.execute("user-a", {
      type: "delete-file",
      projectId: "target",
      path: "unrelated.txt"
    });

    expect(await storage.projectExists("user-a", "source")).toBe(false);
    expect(await storage.getProjectMetadata("user-a", "target")).toMatchObject({
      published: true,
      slug: "site"
    });
    expect(await storage.findPublishedProjectBySlug("user-a", "site")).toMatchObject({
      projectId: "target"
    });
    expect(journal.values.size).toBe(0);
  });

  it("keeps a published slug reserved to a project across rename", async () => {
    const bucket = createMockBucket();
    const storage = new R2ProjectStorage(bucket);
    const service = new OwnerMutationService(bucket, journalStore());
    await storage.createProjectIfAbsent("user-a", "old-site", "Blog");

    await expect(service.execute("user-a", {
      type: "publish-project",
      projectId: "old-site",
      desiredSlug: "blog"
    })).resolves.toMatchObject({ published: { slug: "blog" } });
    await service.execute("user-a", {
      type: "rename-project",
      projectId: "old-site",
      nextProjectId: "new-site",
      name: "Blog"
    });
    await expect(service.execute("user-a", {
      type: "publish-project",
      projectId: "new-site",
      desiredSlug: "blog"
    })).resolves.toMatchObject({ published: { slug: "blog" } });
  });

  it("never compensates an existing project when create loses its metadata claim", async () => {
    const bucket = createMockBucket();
    const storage = new R2ProjectStorage(bucket);
    const journal = journalStore();
    await storage.createProjectIfAbsent("user-a", "existing", "Existing");
    await storage.writeFile("user-a", "existing", "index.html", "keep me");
    const service = new OwnerMutationService(bucket, journal);
    const journalPut = vi.spyOn(journal, "put");

    await expect(service.execute("user-a", {
      type: "create-project",
      projectId: "existing",
      name: "Collision",
      files: { "index.html": "overwrite" }
    })).rejects.toBeInstanceOf(ProjectExistsError);

    expect(await storage.readFile("user-a", "existing", "index.html")).toBe("keep me");
    expect(journalPut).toHaveBeenCalledWith(
      "owner-mutation",
      expect.objectContaining({
        type: "create",
        projectId: "existing",
        operationId: expect.any(String)
      })
    );
    expect(journal.values.size).toBe(0);
  });

  it("never deletes a pre-existing rename destination after losing the claim", async () => {
    const bucket = createMockBucket();
    const storage = new R2ProjectStorage(bucket);
    const journal = journalStore();
    await storage.createProjectIfAbsent("user-a", "site", "Site");
    await storage.writeFile("user-a", "site", "old.txt", "source");
    await storage.writeFile("user-a", "site", "new.txt", "existing destination");
    const service = new OwnerMutationService(bucket, journal);
    const journalPut = vi.spyOn(journal, "put");

    await expect(service.execute("user-a", {
      type: "rename-file",
      projectId: "site",
      oldPath: "old.txt",
      newPath: "new.txt"
    })).rejects.toBeInstanceOf(FileExistsError);
    await service.execute("user-a", { type: "delete-file", projectId: "site", path: "unrelated.txt" });

    expect(await storage.readFile("user-a", "site", "old.txt")).toBe("source");
    expect(await storage.readFile("user-a", "site", "new.txt")).toBe("existing destination");
    expect(journalPut).toHaveBeenCalledWith(
      "owner-mutation",
      expect.objectContaining({
        type: "rename-file",
        stage: "preparing",
        operationId: expect.any(String),
      }),
    );
    expect(journal.values.size).toBe(0);
  });
});
