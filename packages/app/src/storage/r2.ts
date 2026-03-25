import { unzipSync, zipSync, strToU8 } from "fflate";
import type { Env, ProjectMetadata, ProjectSnapshot, ProjectSnapshotTrigger, StorageFile } from "../types";
import { PROTECTED_FILE_NAMES } from "../lib/constants";
import { getContentType, sanitizeFilePath } from "../lib/path";

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
    const object = await this.bucket.get(metadataKey(userId, projectId));
    if (!object) {
      return null;
    }

    return JSON.parse(await object.text()) as ProjectMetadata;
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
          isDirectory: false
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
      throw new Error("File not found");
    }

    return object.text();
  }

  async readFileBuffer(userId: string, projectId: string, filePath: string): Promise<Uint8Array> {
    const object = await this.bucket.get(fileKey(userId, projectId, filePath));
    if (!object) {
      throw new Error("File not found");
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

        snapshots.push(JSON.parse(await record.text()) as ProjectSnapshot);
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

    const currentFiles = await this.listProjectEntries(userId, projectId);
    for (const file of currentFiles) {
      await this.bucket.delete(fileKey(userId, projectId, file.path));
    }

    const extracted = unzipSync(new Uint8Array(await archiveObject.arrayBuffer()));

    for (const [path, content] of Object.entries(extracted)) {
      await this.bucket.put(fileKey(userId, projectId, path), content, {
        httpMetadata: {
          contentType: getContentType(path)
        }
      });
    }

    await this.updateProjectMetadata(userId, projectId, {});
    return snapshot;
  }

  async getSnapshot(userId: string, projectId: string, snapshotId: string): Promise<ProjectSnapshot | null> {
    const object = await this.bucket.get(snapshotMetadataKey(userId, projectId, snapshotId));
    if (!object) {
      return null;
    }

    return JSON.parse(await object.text()) as ProjectSnapshot;
  }

  async findPublishedProjectBySlug(userId: string, slug: string): Promise<{ projectId: string; metadata: ProjectMetadata } | null> {
    const projectIds = await this.listProjects(userId);

    for (const projectId of projectIds) {
      const metadata = await this.getProjectMetadata(userId, projectId);
      if (metadata?.published && metadata.slug === slug) {
        return { projectId, metadata };
      }
    }

    return null;
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
