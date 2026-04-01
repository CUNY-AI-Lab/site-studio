import { unzipSync, zipSync, strToU8 } from "fflate";
import type { Env, ProjectMetadata, ProjectSnapshot, ProjectSnapshotTrigger, StorageFile } from "../types";
import { PROTECTED_FILE_NAMES } from "../lib/constants";
import { getContentType, isTextContentType, sanitizeFilePath } from "../lib/path";

export class FileNotFoundError extends Error {
  constructor(public readonly filePath: string) {
    super("File not found");
    this.name = "FileNotFoundError";
  }
}

function metadataKey(userId: string, projectId: string): string {
  return `projects/${userId}/${projectId}/.metadata.json`;
}

function fileKey(userId: string, projectId: string, filePath = ""): string {
  const base = `projects/${userId}/${projectId}`;
  return filePath ? `${base}/${sanitizeFilePath(filePath)}` : base;
}

function uploadKey(userId: string, fileName: string): string {
  return `uploads/${userId}/${fileName}`;
}

function snapshotPrefix(userId: string, projectId: string): string {
  return `snapshots/${userId}/${projectId}/`;
}

function snapshotArchiveKey(userId: string, projectId: string, snapshotId: string): string {
  return `${snapshotPrefix(userId, projectId)}${snapshotId}.zip`;
}

function snapshotMetadataKey(userId: string, projectId: string, snapshotId: string): string {
  return `${snapshotPrefix(userId, projectId)}${snapshotId}.json`;
}

function toIsoString(date: Date | undefined): string {
  return (date || new Date()).toISOString();
}

function publishedSortKey(metadata: ProjectMetadata): string {
  return metadata.publishedAt || metadata.updatedAt || metadata.createdAt;
}

function safeParseJson<T>(value: string, label: string, key: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    console.warn(`Skipping invalid ${label}: ${key}`, error);
    return null;
  }
}

export class R2ProjectStorage {
  constructor(private readonly bucket: R2Bucket) {}

  async projectExists(userId: string, projectId: string): Promise<boolean> {
    const metadata = await this.bucket.head(metadataKey(userId, projectId));
    if (metadata) {
      return true;
    }

    const listed = await this.bucket.list({
      prefix: `${fileKey(userId, projectId)}/`,
      limit: 1
    });
    return listed.objects.length > 0;
  }

  async listProjects(userId: string): Promise<string[]> {
    const prefix = `projects/${userId}/`;
    const ids = new Set<string>();
    let cursor: string | undefined;

    do {
      const listed = await this.bucket.list({
        prefix,
        delimiter: "/",
        cursor
      });

      for (const delimited of listed.delimitedPrefixes || []) {
        const trimmed = delimited.slice(prefix.length).replace(/\/$/, "");
        if (trimmed) {
          ids.add(trimmed);
        }
      }

      for (const object of listed.objects) {
        const relative = object.key.slice(prefix.length);
        const [projectId] = relative.split("/");
        if (projectId) {
          ids.add(projectId);
        }
      }

      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    return [...ids].sort();
  }

  async createProject(userId: string, projectId: string, name: string): Promise<ProjectMetadata> {
    const now = new Date().toISOString();
    const metadata: ProjectMetadata = {
      id: projectId,
      name,
      createdAt: now,
      updatedAt: now,
      published: false
    };

    await this.putJson(metadataKey(userId, projectId), metadata);
    return metadata;
  }

  async deleteProject(userId: string, projectId: string): Promise<void> {
    const keys = await this.listProjectKeys(userId, projectId);
    for (const key of keys) {
      await this.bucket.delete(key);
    }

    const snapshotKeys = await this.listSnapshotKeys(userId, projectId);
    for (const key of snapshotKeys) {
      await this.bucket.delete(key);
    }
  }

  async renameProject(userId: string, oldProjectId: string, newProjectId: string): Promise<void> {
    const files = await this.listFiles(userId, oldProjectId);
    const metadata = await this.getProjectMetadata(userId, oldProjectId);

    if (!metadata) {
      throw new Error("Project metadata not found");
    }

    const newMetadata: ProjectMetadata = {
      ...metadata,
      id: newProjectId,
      updatedAt: new Date().toISOString()
    };

    await this.putJson(metadataKey(userId, newProjectId), newMetadata);

    for (const file of files) {
      const content = await this.readFileBuffer(userId, oldProjectId, file.path);
      await this.writeFile(userId, newProjectId, file.path, content);
    }

    const thumbnail = await this.bucket.get(fileKey(userId, oldProjectId, ".thumbnail.png"));
    if (thumbnail) {
      await this.bucket.put(fileKey(userId, newProjectId, ".thumbnail.png"), await thumbnail.arrayBuffer(), {
        httpMetadata: thumbnail.httpMetadata
      });
    }

    const oldSnapshotKeys = await this.listSnapshotKeys(userId, oldProjectId);
    const oldPrefix = snapshotPrefix(userId, oldProjectId);
    const nextPrefix = snapshotPrefix(userId, newProjectId);

    for (const key of oldSnapshotKeys) {
      const object = await this.bucket.get(key);
      if (!object) {
        continue;
      }

      const nextKey = `${nextPrefix}${key.slice(oldPrefix.length)}`;
      await this.bucket.put(nextKey, await object.arrayBuffer(), {
        httpMetadata: object.httpMetadata
      });
      await this.bucket.delete(key);
    }

    await this.deleteProject(userId, oldProjectId);
  }

  async getProjectMetadata(userId: string, projectId: string): Promise<ProjectMetadata | null> {
    const key = metadataKey(userId, projectId);
    const object = await this.bucket.get(key);
    if (!object) {
      return null;
    }

    return safeParseJson<ProjectMetadata>(await object.text(), "project metadata", key);
  }

  async updateProjectMetadata(
    userId: string,
    projectId: string,
    updates: Partial<ProjectMetadata>
  ): Promise<ProjectMetadata> {
    const existing = (await this.getProjectMetadata(userId, projectId)) || {
      id: projectId,
      name: projectId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      published: false
    };

    const next: ProjectMetadata = {
      ...existing,
      ...updates,
      id: projectId,
      updatedAt: new Date().toISOString()
    };

    await this.putJson(metadataKey(userId, projectId), next);
    return next;
  }

  async listFiles(userId: string, projectId: string, prefix = ""): Promise<StorageFile[]> {
    const filePrefix = prefix ? `${fileKey(userId, projectId, prefix)}` : `${fileKey(userId, projectId)}/`;
    const files: StorageFile[] = [];
    let cursor: string | undefined;

    do {
      const listed = await this.bucket.list({
        prefix: filePrefix,
        cursor
      });

      for (const object of listed.objects) {
        const relative = object.key.slice(`${fileKey(userId, projectId)}/`.length);
        const name = relative.split("/").pop() || relative;

        if (PROTECTED_FILE_NAMES.has(name) || relative === ".metadata.json") {
          continue;
        }

        files.push({
          path: relative,
          name,
          size: object.size,
          lastModified: toIsoString(object.uploaded),
          isDirectory: false,
          contentType: getContentType(relative),
          isText: isTextContentType(getContentType(relative))
        });
      }

      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  async fileExists(userId: string, projectId: string, filePath: string): Promise<boolean> {
    const head = await this.bucket.head(fileKey(userId, projectId, filePath));
    return !!head;
  }

  async readFile(userId: string, projectId: string, filePath: string): Promise<string> {
    const object = await this.bucket.get(fileKey(userId, projectId, filePath));
    if (!object) {
      throw new FileNotFoundError(filePath);
    }

    return object.text();
  }

  async readFileBuffer(userId: string, projectId: string, filePath: string): Promise<Uint8Array> {
    const object = await this.bucket.get(fileKey(userId, projectId, filePath));
    if (!object) {
      throw new FileNotFoundError(filePath);
    }

    return new Uint8Array(await object.arrayBuffer());
  }

  async writeFile(userId: string, projectId: string, filePath: string, content: string | Uint8Array | ArrayBuffer): Promise<void> {
    const key = fileKey(userId, projectId, filePath);
    await this.bucket.put(key, content);
  }

  async deleteFile(userId: string, projectId: string, filePath: string): Promise<void> {
    await this.bucket.delete(fileKey(userId, projectId, filePath));
  }

  async renameFile(userId: string, projectId: string, oldPath: string, newPath: string): Promise<void> {
    const content = await this.readFileBuffer(userId, projectId, oldPath);
    await this.writeFile(userId, projectId, newPath, content);
    await this.deleteFile(userId, projectId, oldPath);
  }

  async readThumbnail(userId: string, projectId: string): Promise<Uint8Array | null> {
    const object = await this.bucket.get(fileKey(userId, projectId, ".thumbnail.png"));
    if (!object) {
      return null;
    }
    return new Uint8Array(await object.arrayBuffer());
  }

  async writeThumbnail(userId: string, projectId: string, content: Uint8Array): Promise<void> {
    await this.bucket.put(fileKey(userId, projectId, ".thumbnail.png"), content, {
      httpMetadata: {
        contentType: "image/png"
      }
    });
  }

  async uploadToProject(userId: string, projectId: string, fileName: string, content: Uint8Array): Promise<void> {
    await this.writeFile(userId, projectId, fileName, content);
  }

  async uploadToUserFolder(userId: string, fileName: string, content: Uint8Array): Promise<string> {
    const key = uploadKey(userId, fileName);
    await this.bucket.put(key, content);
    return key;
  }

  async exportProjectZip(userId: string, projectId: string): Promise<Uint8Array> {
    const files = await this.listFiles(userId, projectId);
    const archive: Record<string, Uint8Array> = {};

    for (const file of files) {
      archive[file.path] = await this.readFileBuffer(userId, projectId, file.path);
    }

    if (!archive["index.html"]) {
      archive["README.txt"] = strToU8("This project does not currently include index.html.");
    }

    return zipSync(archive, { level: 6 });
  }

  async listSnapshots(userId: string, projectId: string): Promise<ProjectSnapshot[]> {
    const prefix = snapshotPrefix(userId, projectId);
    const snapshots: ProjectSnapshot[] = [];
    let cursor: string | undefined;

    do {
      const listed = await this.bucket.list({
        prefix,
        cursor
      });

      for (const object of listed.objects) {
        if (!object.key.endsWith(".json")) {
          continue;
        }

        const record = await this.bucket.get(object.key);
        if (!record) {
          continue;
        }

        try {
          snapshots.push(JSON.parse(await record.text()) as ProjectSnapshot);
        } catch {
          // Skip corrupted snapshot metadata
        }
      }

      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    return snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async createSnapshot(
    userId: string,
    projectId: string,
    options?: {
      label?: string;
      trigger?: ProjectSnapshotTrigger;
      restoredFromSnapshotId?: string;
    }
  ): Promise<ProjectSnapshot> {
    const snapshotId = crypto.randomUUID();
    const files = await this.listProjectEntries(userId, projectId);
    const archive: Record<string, Uint8Array> = {};

    for (const file of files) {
      archive[file.path] = await this.readFileBuffer(userId, projectId, file.path);
    }

    const snapshot: ProjectSnapshot = {
      id: snapshotId,
      createdAt: new Date().toISOString(),
      projectId,
      trigger: options?.trigger || "manual",
      ...(options?.label ? { label: options.label } : {}),
      fileCount: files.length,
      ...(options?.restoredFromSnapshotId ? { restoredFromSnapshotId: options.restoredFromSnapshotId } : {})
    };

    await this.bucket.put(snapshotArchiveKey(userId, projectId, snapshotId), zipSync(archive, { level: 6 }), {
      httpMetadata: {
        contentType: "application/zip"
      }
    });
    await this.putJson(snapshotMetadataKey(userId, projectId, snapshotId), snapshot);

    return snapshot;
  }

  async restoreSnapshot(userId: string, projectId: string, snapshotId: string): Promise<ProjectSnapshot> {
    const snapshot = await this.getSnapshot(userId, projectId, snapshotId);
    if (!snapshot) {
      throw new Error("Snapshot not found");
    }

    const archiveObject = await this.bucket.get(snapshotArchiveKey(userId, projectId, snapshotId));
    if (!archiveObject) {
      throw new Error("Snapshot archive not found");
    }

    // Extract archive first before deleting anything
    const extracted = unzipSync(new Uint8Array(await archiveObject.arrayBuffer()));
    const restoredPaths = new Set(Object.keys(extracted));

    // Write all restored files first (overwrites existing)
    for (const [path, content] of Object.entries(extracted)) {
      await this.bucket.put(fileKey(userId, projectId, path), content, {
        httpMetadata: {
          contentType: getContentType(path)
        }
      });
    }

    // Only then delete files that aren't in the snapshot
    const currentFiles = await this.listProjectEntries(userId, projectId);
    for (const file of currentFiles) {
      if (!restoredPaths.has(file.path)) {
        await this.bucket.delete(fileKey(userId, projectId, file.path));
      }
    }

    await this.updateProjectMetadata(userId, projectId, {});
    return snapshot;
  }

  async getSnapshot(userId: string, projectId: string, snapshotId: string): Promise<ProjectSnapshot | null> {
    const key = snapshotMetadataKey(userId, projectId, snapshotId);
    const object = await this.bucket.get(key);
    if (!object) {
      return null;
    }

    return safeParseJson<ProjectSnapshot>(await object.text(), "snapshot metadata", key);
  }

  async resolvePublishedSlug(userId: string, desiredSlug: string, excludeProjectId?: string): Promise<string> {
    const normalized = desiredSlug
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");

    if (!normalized) {
      throw new Error("Published slug is required");
    }

    const projectIds = await this.listProjects(userId);
    const usedSlugs = new Set<string>();

    for (const projectId of projectIds) {
      if (projectId === excludeProjectId) {
        continue;
      }

      const metadata = await this.getProjectMetadata(userId, projectId);
      if (metadata?.published && metadata.slug) {
        usedSlugs.add(metadata.slug);
      }
    }

    if (!usedSlugs.has(normalized)) {
      return normalized;
    }

    let suffix = 2;
    let candidate = `${normalized}-${suffix}`;
    while (usedSlugs.has(candidate)) {
      suffix += 1;
      candidate = `${normalized}-${suffix}`;
    }

    return candidate;
  }

  async findPublishedProjectBySlug(userId: string, slug: string): Promise<{ projectId: string; metadata: ProjectMetadata } | null> {
    const projectIds = await this.listProjects(userId);
    const matches: Array<{ projectId: string; metadata: ProjectMetadata }> = [];

    for (const projectId of projectIds) {
      const metadata = await this.getProjectMetadata(userId, projectId);
      if (metadata?.published && metadata.slug === slug) {
        matches.push({ projectId, metadata });
      }
    }

    if (matches.length === 0) {
      return null;
    }

    matches.sort((left, right) => {
      const publishedOrder = publishedSortKey(right.metadata).localeCompare(publishedSortKey(left.metadata));
      if (publishedOrder !== 0) {
        return publishedOrder;
      }

      return right.projectId.localeCompare(left.projectId);
    });

    return matches[0];
  }

  private async putJson(key: string, value: unknown): Promise<void> {
    await this.bucket.put(key, JSON.stringify(value), {
      httpMetadata: {
        contentType: "application/json"
      }
    });
  }

  private async listProjectKeys(userId: string, projectId: string): Promise<string[]> {
    const prefix = `${fileKey(userId, projectId)}/`;
    const keys: string[] = [metadataKey(userId, projectId)];
    let cursor: string | undefined;

    do {
      const listed = await this.bucket.list({
        prefix,
        cursor
      });

      for (const object of listed.objects) {
        keys.push(object.key);
      }

      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    return [...new Set(keys)];
  }

  private async listSnapshotKeys(userId: string, projectId: string): Promise<string[]> {
    const prefix = snapshotPrefix(userId, projectId);
    const keys: string[] = [];
    let cursor: string | undefined;

    do {
      const listed = await this.bucket.list({
        prefix,
        cursor
      });

      for (const object of listed.objects) {
        keys.push(object.key);
      }

      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    return [...new Set(keys)];
  }

  private async listProjectEntries(
    userId: string,
    projectId: string
  ): Promise<Array<{ path: string; key: string }>> {
    const prefix = `${fileKey(userId, projectId)}/`;
    const files: Array<{ path: string; key: string }> = [];
    let cursor: string | undefined;

    do {
      const listed = await this.bucket.list({
        prefix,
        cursor
      });

      for (const object of listed.objects) {
        const relative = object.key.slice(prefix.length);
        if (!relative || relative === ".metadata.json") {
          continue;
        }

        files.push({
          path: relative,
          key: object.key
        });
      }

      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    return files.sort((a, b) => a.path.localeCompare(b.path));
  }
}
