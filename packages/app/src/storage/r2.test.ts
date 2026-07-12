import { describe, it, expect, beforeEach, vi } from "vitest";
import { FileExistsError, ProjectExistsError, ProjectNotFoundError, R2ProjectStorage } from "./r2";
import { isSnapshotSkipped } from "../types";
import type { ProjectMetadata, ProjectSnapshot } from "../types";
import { MAX_SNAPSHOT_BYTES, SNAPSHOT_KEEP_COUNT } from "../lib/constants";

// Mock R2 bucket
function createMockBucket() {
  const store = new Map<string, { data: ArrayBuffer | string; httpMetadata?: any; customMetadata?: Record<string, string>; etag: string; uploaded: Date }>();
  const versions = new Map<string, number>();

  function objectSize(data: ArrayBuffer | string): number {
    return typeof data === "string" ? data.length : data.byteLength;
  }

  function nextEtag(key: string): string {
    const version = (versions.get(key) || 0) + 1;
    versions.set(key, version);
    return `${key}:${version}`;
  }

  function toStored(data: any): ArrayBuffer | string {
    if (typeof data === "string") {
      return data;
    }
    if (data instanceof ArrayBuffer) {
      return data;
    }
    if (data instanceof Uint8Array) {
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    }
    return String(data);
  }

  return {
    store,
    head: vi.fn(async (key: string) => {
      const entry = store.get(key);
      return entry ? { key, size: objectSize(entry.data), etag: entry.etag, uploaded: entry.uploaded } : null;
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
        text: async () => typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer),
        arrayBuffer: async () => typeof data === "string" ? new TextEncoder().encode(data).buffer : data,
      };
    }),
    put: vi.fn(async (key: string, data: any, options?: any) => {
      if (options?.onlyIf?.etagDoesNotMatch === "*" && store.has(key)) {
        return null;
      }
      if (options?.onlyIf?.etagMatches !== undefined && store.get(key)?.etag !== options.onlyIf.etagMatches) {
        return null;
      }
      const stored = toStored(data);
      const entry = {
        data: stored,
        httpMetadata: options?.httpMetadata,
        customMetadata: options?.customMetadata,
        etag: nextEtag(key),
        uploaded: new Date()
      };
      store.set(key, entry);
      return { key, size: objectSize(stored), etag: entry.etag, uploaded: entry.uploaded };
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async ({ prefix, delimiter, cursor, limit, include }: any = {}) => {
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
      const objects: any[] = [];
      const delimitedPrefixes: string[] = [];

      for (const listedEntry of page) {
        if (listedEntry.kind === "prefix") {
          delimitedPrefixes.push(listedEntry.key);
          continue;
        }

        const key = listedEntry.key;
        const entry = store.get(key);
        const size = entry ? objectSize(entry.data) : 0;
        const object: any = {
          key,
          size,
          etag: entry?.etag,
          uploaded: entry?.uploaded || new Date(),
          httpMetadata: entry?.httpMetadata || {},
        };
        if (includeCustomMetadata) {
          object.customMetadata = entry?.customMetadata || {};
        }
        objects.push(object);
      }

      const next = start + pageSize;
      return {
        objects,
        truncated: next < entries.length,
        cursor: next < entries.length ? String(next) : undefined,
        delimitedPrefixes,
      };
    }),
  } as unknown as R2Bucket & { store: Map<string, any> };
}

describe("R2ProjectStorage", () => {
  let bucket: ReturnType<typeof createMockBucket>;
  let storage: R2ProjectStorage;
  const userId = "user_test123";
  const projectId = "my-project";

  beforeEach(() => {
    bucket = createMockBucket();
    storage = new R2ProjectStorage(bucket as any);
  });

  describe("createProject", () => {
    it("creates metadata in R2", async () => {
      const result = await storage.createProject(userId, projectId, "My Project");
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
  });

  describe("projectExists", () => {
    it("returns false for non-existent project", async () => {
      expect(await storage.projectExists(userId, "nope")).toBe(false);
    });

    it("returns true when metadata exists", async () => {
      await storage.createProject(userId, projectId, "Test");
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
        await storage.createProject(userId, `project-${index}`, `Project ${index}`);
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
    it("writes and reads a text file", async () => {
      await storage.createProject(userId, projectId, "Test");
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
      const slug = await storage.resolvePublishedSlug(userId, "My Blog!");
      expect(slug).toBe("my-blog");
    });

    it("suffixes when the desired slug is already published by another project", async () => {
      await storage.createProject(userId, "p1", "P1");
      await storage.updateProjectMetadata(userId, "p1", { published: true, slug: "blog" });
      const slug = await storage.resolvePublishedSlug(userId, "blog", "p2");
      expect(slug).toBe("blog-2");
    });

    it("is idempotent for the same project re-publishing its slug", async () => {
      const first = await storage.resolvePublishedSlug(userId, "portfolio", "same-proj");
      const second = await storage.resolvePublishedSlug(userId, "portfolio", "same-proj");
      expect(first).toBe("portfolio");
      expect(second).toBe("portfolio");
    });

    it("SS-5 race: two concurrent publishes of different projects can't both take the same slug", async () => {
      const [a, b] = await Promise.all([
        storage.resolvePublishedSlug(userId, "blog", "proj-a"),
        storage.resolvePublishedSlug(userId, "blog", "proj-b")
      ]);
      expect(new Set([a, b]).size).toBe(2); // distinct slugs
      expect([a, b].sort()).toEqual(["blog", "blog-2"]);
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
      const slug = await storage.resolvePublishedSlug(userId, "notes", "proj-b");
      expect(slug).toBe("notes");
    });

    it("does NOT reclaim a FRESH reservation held by another project (concurrency guard holds)", async () => {
      const fresh = new Date().toISOString();
      await bucket.put(
        `slugreservations/${userId}/notes.json`,
        JSON.stringify({ projectId: "proj-a", reservedAt: fresh })
      );
      const slug = await storage.resolvePublishedSlug(userId, "notes", "proj-b");
      expect(slug).toBe("notes-2");
    });
  });

  describe("listFiles", () => {
    it("returns empty list for empty project", async () => {
      await storage.createProject(userId, projectId, "Test");
      const files = await storage.listFiles(userId, projectId);
      expect(files).toEqual([]);
    });

    it("lists files excluding metadata", async () => {
      await storage.createProject(userId, projectId, "Test");
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
      await storage.createProject(userId, projectId, "Test");
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
      await storage.createProject(userId, projectId, "Test");
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
      await storage.createProject(userId, projectId, "Test");
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
      await storage.createProject(userId, projectId, "Test");
      await storage.writeFile(userId, projectId, "images/a.png", "A");

      const files = await storage.listFiles(userId, projectId, "images/");
      expect(files.map((f) => f.path)).toEqual(["images/a.png"]);
    });

    it("marks binary files as non-text", async () => {
      await storage.createProject(userId, projectId, "Test");
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
      await storage.renameFile(userId, projectId, "old.html", "new.html");

      expect(await storage.fileExists(userId, projectId, "old.html")).toBe(false);
      expect(await storage.fileExists(userId, projectId, "new.html")).toBe(true);

      const content = await storage.readFile(userId, projectId, "new.html");
      expect(content).toBe("content");
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
      await storage.createProject(userId, "old-complete", "Old Complete");
      await storage.writeFile(userId, "old-complete", "index.html", "<h1>Hi</h1>");
      await storage.writeThumbnail(userId, "old-complete", new Uint8Array([137, 80, 78, 71]));
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

    it("SS-43: rolls back a partial target and preserves the source when a snapshot copy fails", async () => {
      await storage.createProject(userId, "old-atomic", "Old Atomic");
      await storage.writeFile(userId, "old-atomic", "index.html", "source file");
      const snapshot = (await storage.createSnapshot(userId, "old-atomic", {
        trigger: "manual",
        label: "Source snapshot"
      })) as ProjectSnapshot;
      const failingKey = `snapshots/${userId}/new-atomic/${snapshot.id}.zip`;
      const originalPut = bucket.put;
      bucket.put = vi.fn(async (key: string, data: any, options?: any) => {
        if (key === failingKey) {
          throw new Error("snapshot copy failed");
        }
        return originalPut(key, data, options);
      }) as unknown as typeof bucket.put;

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
      await storage.createProject(userId, "old-id", "Old");
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
      await storage.createProject(userId, "old-id2", "Old2");
      await storage.writeFile(userId, "old-id2", "index.html", "<h1>Hi</h1>");

      await storage.renameProject(userId, "old-id2", "new-id2");

      const metadata = await storage.getProjectMetadata(userId, "new-id2");
      expect(metadata?.thumbnailUrl).toBeUndefined();
    });

    it("SS-31: throws when the target metadata appears and leaves the target untouched", async () => {
      await storage.createProject(userId, "old-id3", "Old3");
      await storage.writeFile(userId, "old-id3", "index.html", "<h1>Old</h1>");
      await storage.createProject(userId, "new-id3", "Existing");
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
      await storage.createProject(userId, projectId, "Test");
      await storage.writeFile(userId, projectId, "index.html", "hi");
      await storage.writeFile(userId, projectId, "styles.css", "body {}");

      await storage.deleteProject(userId, projectId);

      expect(await storage.projectExists(userId, projectId)).toBe(false);
    });

    it("removes project and snapshot keys across paginated listings", async () => {
      await storage.createProject(userId, projectId, "Test");
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
      await storage.createProject(userId, projectId, "My Project");
      const metadata = await storage.getProjectMetadata(userId, projectId);
      expect(metadata?.name).toBe("My Project");
      expect(metadata?.published).toBe(false);
    });

    it("returns null for malformed metadata", async () => {
      await bucket.put(`projects/${userId}/${projectId}/.metadata.json`, "{not valid json");

      await expect(storage.getProjectMetadata(userId, projectId)).resolves.toBeNull();
    });

    it("updates metadata fields", async () => {
      await storage.createProject(userId, projectId, "My Project");
      const updated = await storage.updateProjectMetadata(userId, projectId, {
        published: true,
        publishedUrl: "https://example.com"
      });
      expect(updated.published).toBe(true);
      expect(updated.publishedUrl).toBe("https://example.com");
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
      await storage.createProject(userId, projectId, "My Project");
      const key = `projects/${userId}/${projectId}/.metadata.json`;
      const originalPut = bucket.put;
      let injected = false;

      // Simulate a concurrent deleteProject landing between the CAS loop's read
      // and its conditional write: the metadata object vanishes, so the
      // etag-matched put loses and the retry observes an absent record.
      bucket.put = vi.fn(async (putKey: string, data: any, options?: any) => {
        if (putKey === key && options?.onlyIf?.etagMatches && !injected) {
          injected = true;
          bucket.store.delete(key);
        }
        return originalPut(putKey, data, options);
      }) as unknown as typeof bucket.put;

      await expect(
        storage.updateProjectMetadata(userId, projectId, { published: true, slug: "blog" })
      ).rejects.toThrow(ProjectNotFoundError);
      // The deleted project stays deleted — no published ghost.
      expect(bucket.store.has(key)).toBe(false);
    });

    it("SS-30: retries a stale metadata write and preserves both concurrent updates", async () => {
      await storage.createProject(userId, projectId, "My Project");
      const key = `projects/${userId}/${projectId}/.metadata.json`;
      const originalPut = bucket.put;
      let injected = false;

      bucket.put = vi.fn(async (putKey: string, data: any, options?: any) => {
        if (putKey === key && options?.onlyIf?.etagMatches && !injected) {
          injected = true;
          const current = JSON.parse(await (await bucket.get(key))!.text()) as ProjectMetadata;
          await originalPut(key, JSON.stringify({ ...current, thumbnailUrl: "/api/projects/my-project/thumbnail" }), {
            httpMetadata: { contentType: "application/json" }
          });
        }
        return originalPut(putKey, data, options);
      }) as unknown as typeof bucket.put;

      const updated = await storage.updateProjectMetadata(userId, projectId, {
        published: true,
        publishedUrl: "https://example.com/u/janedoe/my-project/",
        slug: "my-project"
      });

      expect(updated).toMatchObject({
        published: true,
        publishedUrl: "https://example.com/u/janedoe/my-project/",
        slug: "my-project",
        thumbnailUrl: "/api/projects/my-project/thumbnail"
      });
      await expect(storage.getProjectMetadata(userId, projectId)).resolves.toMatchObject({
        published: true,
        thumbnailUrl: "/api/projects/my-project/thumbnail"
      });
    });

    it("SS-30: throws after repeated metadata CAS conflicts", async () => {
      await storage.createProject(userId, projectId, "My Project");
      const key = `projects/${userId}/${projectId}/.metadata.json`;
      const original = await storage.getProjectMetadata(userId, projectId);
      bucket.put = vi.fn(async (putKey: string, _data: any, options?: any) => {
        if (putKey === key && options?.onlyIf) {
          return null;
        }
        return { key: putKey };
      }) as unknown as typeof bucket.put;

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
      await storage.createProject(userId, projectId, "Test");
      await storage.writeFile(userId, projectId, "index.html", "<h1>Hello</h1>");
      await storage.writeFile(userId, projectId, "styles.css", "body {}");

      const zip = await storage.exportProjectZip(userId, projectId);
      expect(zip).toBeInstanceOf(Uint8Array);
      expect(zip.length).toBeGreaterThan(0);
    });

    it("adds README for projects without index.html", async () => {
      await storage.createProject(userId, projectId, "Test");
      await storage.writeFile(userId, projectId, "about.html", "<p>About</p>");

      const zip = await storage.exportProjectZip(userId, projectId);
      expect(zip.length).toBeGreaterThan(0);
    });
  });

  describe("snapshots", () => {
    it("creates and lists snapshots", async () => {
      await storage.createProject(userId, projectId, "Test");
      await storage.writeFile(userId, projectId, "index.html", "<h1>Hello</h1>");

      const result = await storage.createSnapshot(userId, projectId, {
        trigger: "manual",
        label: "Test snapshot"
      });

      expect(isSnapshotSkipped(result)).toBe(false);
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
      await storage.createProject(userId, projectId, "Test");
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
        await storage.createProject(userId, projectId, "Test");
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
        await storage.createProject(userId, projectId, "Test");
        await storage.writeFile(userId, projectId, "index.html", "<h1>Hello</h1>");

        const created: ProjectSnapshot[] = [];
        for (let index = 0; index < SNAPSHOT_KEEP_COUNT + 1; index += 1) {
          vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 0, index)));
          created.push(
            (await storage.createSnapshot(userId, projectId, {
              trigger: "manual",
              label: `Snapshot ${index}`
            })) as ProjectSnapshot
          );
        }

        const oldest = created[0];
        expect(bucket.store.has(`snapshots/${userId}/${projectId}/${oldest.id}.zip`)).toBe(false);
        expect(bucket.store.has(`snapshots/${userId}/${projectId}/${oldest.id}.json`)).toBe(false);

        const snapshots = await storage.listSnapshots(userId, projectId);
        expect(snapshots).toHaveLength(SNAPSHOT_KEEP_COUNT);
        expect(new Set(snapshots.map((snapshot) => snapshot.id))).toEqual(
          new Set(created.slice(1).map((snapshot) => snapshot.id))
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("SS-39: lists modern snapshots without GETs for snapshot metadata objects", async () => {
      await storage.createProject(userId, projectId, "Test");
      await storage.writeFile(userId, projectId, "index.html", "<h1>Hello</h1>");

      for (let index = 0; index < 4; index += 1) {
        await storage.createSnapshot(userId, projectId, {
          trigger: "manual",
          label: `Snapshot ${index}`
        });
      }

      const getMock = bucket.get as unknown as ReturnType<typeof vi.fn>;
      getMock.mockClear();

      const snapshots = await storage.listSnapshots(userId, projectId);
      const snapshotMetadataGets = getMock.mock.calls.filter(([key]) =>
        String(key).startsWith(`snapshots/${userId}/${projectId}/`) && String(key).endsWith(".json")
      );
      expect(snapshots).toHaveLength(4);
      expect(snapshotMetadataGets).toHaveLength(0);
    });

    it("SS-39: falls back to one GET for a legacy snapshot without custom metadata", async () => {
      await storage.createProject(userId, projectId, "Test");
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

      const getMock = bucket.get as unknown as ReturnType<typeof vi.fn>;
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
      // The prune failure is surfaced as a structured cail-log event (one JSON
      // object on console.log), not an ad-hoc console.warn.
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await storage.createProject(userId, projectId, "Test");
        await storage.writeFile(userId, projectId, "index.html", "<h1>Hello</h1>");

        for (let index = 0; index < SNAPSHOT_KEEP_COUNT; index += 1) {
          vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 0, index)));
          await storage.createSnapshot(userId, projectId, {
            trigger: "manual",
            label: `Snapshot ${index}`
          });
        }

        const deleteMock = bucket.delete as unknown as ReturnType<typeof vi.fn>;
        deleteMock.mockImplementationOnce(async () => {
          throw new Error("delete failed");
        });

        vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 1, 0)));
        const resilient = await storage.createSnapshot(userId, projectId, {
          trigger: "manual",
          label: "Resilient"
        });
        expect(isSnapshotSkipped(resilient)).toBe(false);
        expect((resilient as ProjectSnapshot).label).toBe("Resilient");
        expect(
          logSpy.mock.calls.some(
            ([line]) => typeof line === "string" && line.includes('"event":"snapshot.prune_failed"')
          )
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

    it("returns empty list when no snapshots exist", async () => {
      const snapshots = await storage.listSnapshots(userId, projectId);
      expect(snapshots).toEqual([]);
    });

    it("restores a snapshot", async () => {
      await storage.createProject(userId, projectId, "Test");
      await storage.writeFile(userId, projectId, "index.html", "<h1>Original</h1>");

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
      await storage.createProject(userId, projectId, "Small");
      await storage.writeFile(userId, projectId, "index.html", "<h1>Small site</h1>");

      const result = await storage.createSnapshot(userId, projectId, { trigger: "agent" });

      expect(isSnapshotSkipped(result)).toBe(false);
      const snapshots = await storage.listSnapshots(userId, projectId);
      expect(snapshots).toHaveLength(1);
    });

    it("SS-28: skips (visibly) when the project exceeds MAX_SNAPSHOT_BYTES and writes no archive", async () => {
      await storage.createProject(userId, projectId, "Huge");
      // One oversized file pushes the summed project size past the cap.
      const oversized = "x".repeat(MAX_SNAPSHOT_BYTES + 1);
      await storage.writeFile(userId, projectId, "big.txt", oversized);

      // The skip is surfaced as a structured cail-log event (one JSON object
      // on console.log), not an ad-hoc console.warn.
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const result = await storage.createSnapshot(userId, projectId, { trigger: "agent" });

      // Skip is signalled, not silent.
      expect(isSnapshotSkipped(result)).toBe(true);
      if (isSnapshotSkipped(result)) {
        expect(result.reason).toBe("too-large");
        expect(result.totalBytes).toBeGreaterThan(MAX_SNAPSHOT_BYTES);
        expect(result.limitBytes).toBe(MAX_SNAPSHOT_BYTES);
      }
      expect(
        logSpy.mock.calls.some(
          ([line]) => typeof line === "string" && line.includes('"event":"snapshot.skipped"')
        )
      ).toBe(true);
      logSpy.mockRestore();

      // No snapshot archive/metadata was written for the skipped turn.
      const snapshots = await storage.listSnapshots(userId, projectId);
      expect(snapshots).toHaveLength(0);
    });
  });

  describe("findPublishedProjectBySlug", () => {
    it("returns null when no published project matches", async () => {
      await storage.createProject(userId, projectId, "Test");
      const result = await storage.findPublishedProjectBySlug(userId, "my-slug");
      expect(result).toBeNull();
    });

    it("finds published project by slug", async () => {
      await storage.createProject(userId, projectId, "Test");
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
