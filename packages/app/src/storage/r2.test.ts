import { describe, it, expect, beforeEach, vi } from "vitest";
import { R2ProjectStorage } from "./r2";
import type { ProjectMetadata } from "../types";

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
      let stored: ArrayBuffer | string;
      if (typeof data === "string") {
        stored = data;
      } else if (data instanceof ArrayBuffer) {
        stored = data;
      } else if (data instanceof Uint8Array) {
        stored = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      } else {
        stored = String(data);
      }
      store.set(key, { data: stored, httpMetadata: options?.httpMetadata });
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

        objects.push({
          key,
          size: 0,
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

      const snapshot = await storage.createSnapshot(userId, projectId, {
        trigger: "manual",
        label: "Test snapshot"
      });

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

      const snapshot = await storage.createSnapshot(userId, projectId, { trigger: "manual" });

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
