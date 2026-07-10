import { unzipSync, zipSync, strToU8 } from "fflate";
import type {
  Env,
  ProjectMetadata,
  ProjectSnapshot,
  ProjectSnapshotTrigger,
  SnapshotResult,
  StorageFile
} from "../types";
import { MAX_SNAPSHOT_BYTES, PROTECTED_FILE_NAMES, SNAPSHOT_KEEP_COUNT } from "../lib/constants";
import { getContentType, isTextContentType, sanitizeFilePath } from "../lib/path";

export class FileNotFoundError extends Error {
  constructor(public readonly filePath: string) {
    super("File not found");
    this.name = "FileNotFoundError";
  }
}

export class ProjectExistsError extends Error {
  constructor(public readonly projectId: string) {
    super("Project already exists");
    this.name = "ProjectExistsError";
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

/**
 * Reservation marker for a published slug within a user's namespace. Two
 * concurrent publishes that both pick `blog` would otherwise both win; a
 * put-if-absent on this key lets exactly one claim it while the loser advances
 * to the next suffix. The record stores the owning projectId so re-publishing
 * the same project is idempotent rather than colliding with its own marker.
 */
function slugReservationKey(userId: string, slug: string): string {
  return `slugreservations/${userId}/${slug}.json`;
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

function isValidSnapshotRecord(value: unknown): value is ProjectSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ProjectSnapshot).id === "string" &&
    typeof (value as ProjectSnapshot).createdAt === "string"
  );
}

function sortSnapshotsNewestFirst(snapshots: ProjectSnapshot[]): ProjectSnapshot[] {
  return snapshots.sort((left, right) => {
    const createdOrder = right.createdAt.localeCompare(left.createdAt);
    if (createdOrder !== 0) {
      return createdOrder;
    }

    return right.id.localeCompare(left.id);
  });
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
        // Dotfile entries are system objects (e.g. the migration forwarding
        // pointer .migrated.json), never projects — sanitizeProjectId cannot
        // produce ids starting with ".".
        if (projectId && !projectId.startsWith(".")) {
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

  async createProjectIfAbsent(userId: string, projectId: string, name: string): Promise<ProjectMetadata> {
    const now = new Date().toISOString();
    const metadata: ProjectMetadata = {
      id: projectId,
      name,
      createdAt: now,
      updatedAt: now,
      published: false
    };

    // SS-42: project creation claims the metadata key atomically. The route's
    // existence preflight is only advisory because two same-name requests can
    // both observe an empty namespace before either writes its template files.
    const claimed = await this.bucket.put(metadataKey(userId, projectId), JSON.stringify(metadata), {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: {
        contentType: "application/json"
      }
    });
    if (claimed === null) {
      throw new ProjectExistsError(projectId);
    }

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
      updatedAt: new Date().toISOString(),
      // SS-25: thumbnailUrl embeds the project id (/api/projects/{id}/thumbnail).
      // Re-point it at the new id so it doesn't 404 against the old (now deleted)
      // project; clear it when the old metadata had none so we never invent one.
      ...(metadata.thumbnailUrl
        ? { thumbnailUrl: `/api/projects/${newProjectId}/thumbnail` }
        : {})
    };

    // SS-31: the route preflight is advisory only. A target project can appear
    // between that check and this write, so claim the target metadata key with
    // put-if-absent before copying any files into the namespace. Losing the
    // conditional write fails loud and leaves the target project untouched.
    const claimedTarget = await this.bucket.put(metadataKey(userId, newProjectId), JSON.stringify(newMetadata), {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: {
        contentType: "application/json"
      }
    });
    if (claimedTarget === null) {
      throw new ProjectExistsError(newProjectId);
    }

    // SS-43: copy every project object before deleting any source object. If a
    // copy fails, roll back the claimed target namespace and leave the complete
    // source (including snapshots) intact so the rename can be retried safely.
    try {
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
        // Carry customMetadata across so renamed projects keep the SS-39
        // list-time snapshot records instead of degrading every entry to the
        // legacy per-object GET fallback.
        await this.bucket.put(nextKey, await object.arrayBuffer(), {
          httpMetadata: object.httpMetadata,
          ...(object.customMetadata ? { customMetadata: object.customMetadata } : {})
        });
      }
    } catch (error) {
      await this.deleteProject(userId, newProjectId).catch(() => undefined);
      throw error;
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
    const key = metadataKey(userId, projectId);
    const defaultMetadata = (): ProjectMetadata => ({
      id: projectId,
      name: projectId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      published: false
    });

    // SS-30: metadata is a shared read-modify-write record. Publish, thumbnail,
    // restore, and rename can all update different fields concurrently; a plain
    // put would let the later stale writer silently erase the earlier one. R2
    // conditional puts provide the CAS guard: re-read on mismatch and fail loud
    // if the record never settles.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const object = await this.bucket.get(key);
      const existing = object
        ? safeParseJson<ProjectMetadata>(await object.text(), "project metadata", key) || defaultMetadata()
        : defaultMetadata();

      const next: ProjectMetadata = {
        ...existing,
        ...updates,
        id: projectId,
        updatedAt: new Date().toISOString()
      };

      const result = await this.bucket.put(key, JSON.stringify(next), {
        onlyIf: object ? { etagMatches: object.etag } : { etagDoesNotMatch: "*" },
        httpMetadata: {
          contentType: "application/json"
        }
      });
      if (result !== null) {
        return next;
      }
    }

    throw new Error(`Concurrent metadata update conflict for ${key}`);
  }

  async listFiles(userId: string, projectId: string, prefix = ""): Promise<StorageFile[]> {
    // SS-7: an R2 list prefix without a trailing slash matches sibling keys —
    // listing dir "images" would also return "images2.txt" and "images-old/…".
    // Force a directory boundary by ensuring the prefix ends with "/" (without
    // double-slashing one the caller already terminated). The no-prefix branch
    // already appends "/" to scope the list to the project root.
    const filePrefix = prefix
      ? `${fileKey(userId, projectId, prefix)}`.replace(/\/?$/, "/")
      : `${fileKey(userId, projectId)}/`;
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

  async readFileWithEtag(
    userId: string,
    projectId: string,
    filePath: string
  ): Promise<{ content: string; etag: string } | null> {
    const object = await this.bucket.get(fileKey(userId, projectId, filePath));
    if (!object) {
      return null;
    }

    return {
      content: await object.text(),
      etag: object.etag
    };
  }

  async readFileBuffer(userId: string, projectId: string, filePath: string): Promise<Uint8Array> {
    const object = await this.bucket.get(fileKey(userId, projectId, filePath));
    if (!object) {
      throw new FileNotFoundError(filePath);
    }

    return new Uint8Array(await object.arrayBuffer());
  }

  /**
   * Raw R2 object for a project file (or null if absent), exposing `etag` and
   * `uploaded` so the published-site serving path can emit ETag/Last-Modified
   * validators identically to the standalone publisher worker (SS-15 parity).
   */
  async readObject(userId: string, projectId: string, filePath: string): Promise<R2ObjectBody | null> {
    return this.bucket.get(fileKey(userId, projectId, filePath));
  }

  async writeFile(userId: string, projectId: string, filePath: string, content: string | Uint8Array | ArrayBuffer): Promise<string> {
    const key = fileKey(userId, projectId, filePath);
    const result = await this.bucket.put(key, content);
    if (result === null) {
      throw new Error(`Unexpected conditional write failure for ${key}`);
    }
    return result.etag;
  }

  async writeFileIfMatch(
    userId: string,
    projectId: string,
    filePath: string,
    content: string | Uint8Array | ArrayBuffer,
    expectedEtag: string
  ): Promise<string | null> {
    const result = await this.bucket.put(fileKey(userId, projectId, filePath), content, {
      onlyIf: { etagMatches: expectedEtag }
    });
    return result?.etag ?? null;
  }

  async writeFileIfAbsent(
    userId: string,
    projectId: string,
    filePath: string,
    content: string | Uint8Array | ArrayBuffer
  ): Promise<string | null> {
    const result = await this.bucket.put(fileKey(userId, projectId, filePath), content, {
      onlyIf: { etagDoesNotMatch: "*" }
    });
    return result?.etag ?? null;
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

  /**
   * Collision-safe write: persist `content` at `fileName` ONLY if no object
   * already exists at that key. Returns `true` when this call performed the
   * write, `false` when an object was already present (so the caller can pick
   * the next candidate name). The atomicity comes from R2's conditional put
   * (`putIfAbsent`), which closes the read-check-write TOCTOU that a
   * `fileExists()` probe followed by a `put()` leaves open.
   */
  async uploadToProjectIfAbsent(
    userId: string,
    projectId: string,
    fileName: string,
    content: Uint8Array
  ): Promise<boolean> {
    return this.putIfAbsent(fileKey(userId, projectId, fileName), content);
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
    return this.listSnapshotRecords(userId, projectId);
  }

  async createSnapshot(
    userId: string,
    projectId: string,
    options?: {
      label?: string;
      trigger?: ProjectSnapshotTrigger;
      restoredFromSnapshotId?: string;
    }
  ): Promise<SnapshotResult> {
    // SS-28: a snapshot reads every project file into memory and `zipSync`
    // (synchronous, blocking) compresses them in the DO isolate. For an
    // oversized project that is a blocking spike on every mutation. Sum the file
    // sizes from R2 LISTING metadata FIRST (cheap — no bodies read) and, if the
    // project exceeds MAX_SNAPSHOT_BYTES, SKIP the snapshot for this turn instead
    // of reading + zipping everything. The caller treats the skip as non-fatal:
    // the mutation proceeds, the user just has no restore point for this turn.
    // The tradeoff (no restore point for oversized turns) is deliberate — the
    // alternative is a pathological isolate spike that can stall the agent.
    //
    // Simplification wave 2026-07-06 (researched, NOT changed): making the zip
    // non-blocking was investigated and REJECTED as unavoidably
    // semantics-changing. (1) fflate's async/streaming API needs Web Workers /
    // worker_threads, which Cloudflare Workers/DO isolates do not have — the
    // maintainer confirms the async path "won't work on Cloudflare Workers"
    // (github.com/101arrowz/fflate discussion #177), so there is no in-isolate
    // non-blocking compressor. (2) Deferring the zip via a Queue or a DO alarm
    // WOULD offload it, but the snapshot must capture PRE-mutation state and is
    // awaited before the mutation writes (ensureSnapshot, site-builder.ts); a
    // deferred snapshot races the mutation and would capture the wrong state.
    // (3) The manual + restore routes (routes/projects.ts) return the created
    // ProjectSnapshot synchronously in their HTTP response, so backgrounding it
    // also breaks that contract. Every option changes an observable
    // timing/ordering guarantee, so the size-cap skip below stays the mitigation.
    const listed = await this.listFiles(userId, projectId);
    const totalBytes = listed.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_SNAPSHOT_BYTES) {
      // Surface the skip — never silent. Callers also relay it (see
      // ensureSnapshot in site-builder.ts and the manual snapshot route).
      console.warn(
        `Skipping snapshot for ${userId}/${projectId}: project size ${totalBytes} bytes exceeds MAX_SNAPSHOT_BYTES ${MAX_SNAPSHOT_BYTES}. Mutation proceeds with no restore point for this turn.`
      );
      return { skipped: true, reason: "too-large", totalBytes, limitBytes: MAX_SNAPSHOT_BYTES };
    }

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
    await this.putJson(snapshotMetadataKey(userId, projectId, snapshotId), snapshot, {
      customMetadata: {
        snapshot: JSON.stringify(snapshot)
      }
    });

    // SS-38: retention is best-effort AFTER the new snapshot's archive and
    // metadata have both succeeded. A transient LIST/DELETE failure must not
    // fail the caller's already-complete mutation or hide the fresh restore
    // point, so pruning is the only part wrapped here. We warn with scope and
    // return the created snapshot; because pruning re-runs on every subsequent
    // create, retention converges. The list may temporarily lag over the cap,
    // but it never fabricates or serves stale snapshot records.
    try {
      await this.pruneSnapshots(userId, projectId);
    } catch (error) {
      console.warn("Snapshot retention prune failed", { userId, projectId, error });
    }

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

    // Walk candidates (normalized, then -2, -3, …) and CLAIM each atomically
    // with a put-if-absent reservation. The metadata scan above only rules out
    // already-settled slugs; the atomic claim is what makes two *concurrent*
    // publishes safe — the second to reach `blog` fails the conditional put and
    // advances to `blog-2` instead of colliding on the same slug.
    const MAX_SLUG_ATTEMPTS = 1000;
    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
      const candidate = attempt === 0 ? normalized : `${normalized}-${attempt + 1}`;
      if (usedSlugs.has(candidate)) {
        continue;
      }
      if (await this.claimSlugReservation(userId, candidate, excludeProjectId)) {
        return candidate;
      }
    }

    throw new Error("Could not resolve a free published slug");
  }

  /**
   * Atomically reserve `slug` for the given project within a user's namespace.
   * Returns `true` when the reservation now belongs to this project — because
   * the put-if-absent won the empty key, the existing reservation already names
   * this project (idempotent re-publish), or the existing reservation is STALE
   * (older than the publish-in-flight window) and we successfully re-claimed it.
   * Returns `false` when a live reservation by another project holds the slug,
   * so the caller advances to the next suffix.
   *
   * Why a timestamp and not a metadata check: `resolvePublishedSlug` runs
   * BEFORE the caller writes the slug into project metadata, so during a genuine
   * concurrent publish the winner's metadata isn't visible yet — a metadata
   * "is this still held?" probe cannot tell an in-flight concurrent claim from
   * an abandoned one, and would let both racers win. A concurrent publish
   * settles in milliseconds, so any reservation older than STALE_RESERVATION_MS
   * is provably not an in-flight competitor and is safe to reclaim. This keeps
   * the pre-CAS "freeing a slug makes it reusable" behavior (a slug freed by
   * unpublish/rename becomes reclaimable once its marker ages out) without
   * reopening the race the reservation exists to close.
   */
  private async claimSlugReservation(
    userId: string,
    slug: string,
    projectId?: string
  ): Promise<boolean> {
    const STALE_RESERVATION_MS = 60_000;
    const key = slugReservationKey(userId, slug);
    const makeRecord = () => JSON.stringify({ projectId: projectId ?? null, reservedAt: new Date().toISOString() });
    const won = await this.putIfAbsent(key, makeRecord(), {
      httpMetadata: { contentType: "application/json" }
    });
    if (won) {
      return true;
    }

    // The key was already reserved. Read who holds it and when.
    const existing = await this.bucket.get(key);
    if (!existing) {
      // Reservation vanished between the failed put and this read — try to
      // reclaim it; a concurrent winner still makes this return false.
      return this.putIfAbsent(key, makeRecord(), { httpMetadata: { contentType: "application/json" } });
    }
    const parsed = safeParseJson<{ projectId?: string | null; reservedAt?: string }>(
      await existing.text(),
      "slug reservation",
      key
    );
    const holder = parsed?.projectId ?? null;

    // Ours already (idempotent re-publish of the same project).
    if (projectId && holder === projectId) {
      return true;
    }

    // Stale (aged past the publish-in-flight window) → reclaim atomically.
    const reservedAtMs = parsed?.reservedAt ? Date.parse(parsed.reservedAt) : NaN;
    const isStale = !Number.isFinite(reservedAtMs) || Date.now() - reservedAtMs > STALE_RESERVATION_MS;
    if (isStale) {
      // Safe to swallow: clearing the stale reservation is best-effort. The
      // putIfAbsent below is the real atomic reclaim, so a failed delete just
      // means this attempt loses the race and retries via the next suffix.
      await this.bucket.delete(key).catch(() => undefined);
      return this.putIfAbsent(key, makeRecord(), { httpMetadata: { contentType: "application/json" } });
    }

    // A live, different project holds it — advance to the next suffix.
    return false;
  }

  async findPublishedProjectBySlug(userId: string, slug: string): Promise<{ projectId: string; metadata: ProjectMetadata } | null> {
    const projectIds = await this.listProjects(userId);
    const matches: Array<{ projectId: string; metadata: ProjectMetadata }> = [];

    for (const projectId of projectIds) {
      const metadata = await this.getProjectMetadata(userId, projectId);
      // SS-13: match by slug, OR by projectId when the metadata carries no slug
      // (legacy/migrated sites published before slugs existed). Kept identical to
      // the publisher worker's findPublishedProject so a slug-less site resolves
      // the same on both origins instead of 404-ing on one.
      if (metadata?.published && (metadata.slug === slug || (!metadata.slug && projectId === slug))) {
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

  private async putJson(
    key: string,
    value: unknown,
    opts?: { customMetadata?: Record<string, string> }
  ): Promise<void> {
    await this.bucket.put(key, JSON.stringify(value), {
      httpMetadata: {
        contentType: "application/json"
      },
      ...(opts?.customMetadata ? { customMetadata: opts.customMetadata } : {})
    });
  }

  /**
   * Atomic put-if-absent against R2. Writes `value` at `key` only when no
   * object currently exists there, using the conditional put
   * `onlyIf: { etagDoesNotMatch: "*" }` — the wildcard etag never matches an
   * existing object, so the write succeeds iff the key is empty. R2 signals a
   * failed condition by returning `null` from `put` (no write, no throw), so a
   * `null` result means "someone else already owns this key".
   *
   * This is the compare-and-set primitive the read-check-write collision paths
   * (uploads, generated images, handle claims, slug reservations) rely on to be
   * race-free: the check and the write are the same atomic operation.
   *
   * Returns `true` when this call wrote the object, `false` when the key was
   * already taken.
   */
  async putIfAbsent(
    key: string,
    value: string | Uint8Array | ArrayBuffer,
    opts?: { httpMetadata?: R2HTTPMetadata }
  ): Promise<boolean> {
    const result = await this.bucket.put(key, value, {
      onlyIf: { etagDoesNotMatch: "*" },
      ...(opts?.httpMetadata ? { httpMetadata: opts.httpMetadata } : {})
    });
    return result !== null;
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

  private async listSnapshotRecords(userId: string, projectId: string): Promise<ProjectSnapshot[]> {
    const prefix = snapshotPrefix(userId, projectId);
    const snapshots: ProjectSnapshot[] = [];
    let cursor: string | undefined;

    do {
      const listed = await this.bucket.list({
        prefix,
        cursor,
        include: ["customMetadata"]
      });

      for (const object of listed.objects) {
        if (!object.key.endsWith(".json")) {
          continue;
        }

        // SS-39: snapshot metadata is duplicated into R2 custom metadata on the
        // .json object, so LIST with include:["customMetadata"] can render the
        // snapshot list without one GET per record. The R2 listing remains the
        // ground truth for which keys exist, and the metadata travels atomically
        // with the object; there is no separate index that can drift. Legacy or
        // damaged entries with missing/unparseable custom metadata degrade to
        // the old single-object GET path for that key only instead of being
        // dropped or served from a stale side index.
        const listedSnapshot = this.parseListedSnapshot(object.customMetadata?.snapshot);
        if (listedSnapshot) {
          snapshots.push(listedSnapshot);
          continue;
        }

        const record = await this.bucket.get(object.key);
        if (!record) {
          continue;
        }

        const snapshot = this.parseListedSnapshot(await record.text());
        if (snapshot) {
          snapshots.push(snapshot);
        }
      }

      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    return sortSnapshotsNewestFirst(snapshots);
  }

  private parseListedSnapshot(value: string | undefined): ProjectSnapshot | null {
    if (!value) {
      return null;
    }

    try {
      const parsed = JSON.parse(value) as unknown;
      return isValidSnapshotRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private async pruneSnapshots(userId: string, projectId: string): Promise<void> {
    const snapshots = await this.listSnapshotRecords(userId, projectId);
    const expired = snapshots.slice(SNAPSHOT_KEEP_COUNT);

    for (const snapshot of expired) {
      // Metadata first: a crash between the two deletes then leaves an orphan
      // zip (invisible, reaped by deleteProject) rather than a listed snapshot
      // whose archive is gone and whose restore would fail.
      await this.bucket.delete(snapshotMetadataKey(userId, projectId, snapshot.id));
      await this.bucket.delete(snapshotArchiveKey(userId, projectId, snapshot.id));
    }
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
