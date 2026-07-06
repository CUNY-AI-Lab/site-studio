import { describe, it, expect, beforeEach, vi } from "vitest";
import { R2ProjectStorage } from "./r2";
import { isSnapshotSkipped } from "../types";
import type { ProjectMetadata, ProjectSnapshot } from "../types";
import { MAX_SNAPSHOT_BYTES } from "../lib/constants";

// Mock R2 bucket
function createMockBucket() {
  const store = new Map<string, { data: ArrayBuffer | string; httpMetadata?: any }>();

  return {
    store,
    head: vi.fn(async (key: string) => {
      return store.has(key) ? { key, size: 0 } : null;
    }),
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      const data = entry.data;
      return {
        key,
        size: typeof data === "string" ? data.length : (data as ArrayBuffer).byteLength,
        httpMetadata: entry.httpMetadata || {},
        text: async () => typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer),
        arrayBuffer: async () => typeof data === "string" ? new TextEncoder().encode(data).buffer : data,
      };
    }),
    put: vi.fn(async (key: string, data: any, options?: any) => {
      // Honor R2's put-if-absent condition: onlyIf.etagDoesNotMatch:"*" writes
      // only when the key is empty, and R2 returns null on a failed condition.
      if (options?.onlyIf?.etagDoesNotMatch === "*" && store.has(key)) {
        return null;
      }
      let stored: ArrayBuffer | string;
      if (typeof data === "string") {
        stored = data;
      } else if (data instanceof ArrayBuffer) {
        stored = data;
      } else if (data instanceof Uint8Array) {
        stored = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      } else {
        stored = String(data);
      }
      store.set(key, { data: stored, httpMetadata: options?.httpMetadata });
      return { key };
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async ({ prefix, delimiter, cursor, limit }: any = {}) => {
      const objects: any[] = [];
      const delimitedPrefixes: string[] = [];

      for (const key of store.keys()) {
        if (prefix && !key.startsWith(prefix)) continue;

        if (delimiter) {
          const rest = key.slice(prefix?.length || 0);
          const delimIndex = rest.indexOf(delimiter);
          if (delimIndex >= 0) {
            const delimitedPrefix = (prefix || "") + rest.slice(0, delimIndex + 1);
            if (!delimitedPrefixes.includes(delimitedPrefix)) {
              delimitedPrefixes.push(delimitedPrefix);
            }
            continue;
          }
        }

        const entry = store.get(key);
        const size = entry
          ? typeof entry.data === "string"
            ? entry.data.length
            : (entry.data as ArrayBuffer).byteLength
          : 0;
        objects.push({
          key,
          size,
          uploaded: new Date(),
          httpMetadata: {},
        });
      }

      return {
        objects: limit ? objects.slice(0, limit) : objects,
        truncated: false,
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
  });

  describe("renameProject", () => {
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
  });

  describe("deleteProject", () => {
    it("removes all project files and metadata", async () => {
      await storage.createProject(userId, projectId, "Test");
      await storage.writeFile(userId, projectId, "index.html", "hi");
      await storage.writeFile(userId, projectId, "styles.css", "body {}");

      await storage.deleteProject(userId, projectId);

      expect(await storage.projectExists(userId, projectId)).toBe(false);
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

    it("creates metadata if it doesn't exist", async () => {
      const updated = await storage.updateProjectMetadata(userId, projectId, { name: "New" });
      expect(updated.name).toBe("New");
      expect(updated.id).toBe(projectId);
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

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = await storage.createSnapshot(userId, projectId, { trigger: "agent" });

      // Skip is signalled, not silent.
      expect(isSnapshotSkipped(result)).toBe(true);
      if (isSnapshotSkipped(result)) {
        expect(result.reason).toBe("too-large");
        expect(result.totalBytes).toBeGreaterThan(MAX_SNAPSHOT_BYTES);
        expect(result.limitBytes).toBe(MAX_SNAPSHOT_BYTES);
      }
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();

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
