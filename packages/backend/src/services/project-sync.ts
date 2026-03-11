/**
 * Project Sync Service
 *
 * Handles bidirectional sync between local filesystem and R2 storage.
 * - Hydration: Download R2 files to local projectPath before agent starts
 * - Sync: Upload local changes to R2 after file operations
 */

import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { glob } from 'glob';
import type { IStorage } from '../storage/types.js';
import { getLogger } from '../config/logger.js';

const log = getLogger('project-sync');

export interface SyncResult {
  filesUploaded: number;
  filesDeleted: number;
  errors: string[];
}

export interface HydrateResult {
  filesDownloaded: number;
  errors: string[];
}

export class ProjectSyncService {
  private lastSyncTime: Map<string, Date> = new Map();
  private lastSyncHashes: Map<string, Map<string, string>> = new Map();
  // Keep sync conservative: ignore system metadata and known local-only build/cache artifacts,
  // but do not treat ordinary dotfiles as disposable project state.
  private readonly internalStoragePaths = new Set(['.metadata.json', '.thumbnail.png']);
  private readonly ignoredDirectoryNames = new Set([
    'node_modules',
    '.git',
    '.svelte-kit',
    '.vite',
    '.next',
    '.nuxt',
    '.cache',
    '.parcel-cache',
    'coverage',
  ]);
  private readonly ignoredBaseNames = new Set([
    '.DS_Store',
    'Thumbs.db',
  ]);
  private readonly ignoredDebugLogPattern = /^(npm|pnpm|yarn)-(debug|error)\.log/i;
  private readonly globIgnorePatterns = [
    '**/node_modules/**',
    '**/.git/**',
    '**/.svelte-kit/**',
    '**/.vite/**',
    '**/.next/**',
    '**/.nuxt/**',
    '**/.cache/**',
    '**/.parcel-cache/**',
    '**/coverage/**',
    '**/.DS_Store',
    '**/Thumbs.db',
    '**/npm-debug.log*',
    '**/pnpm-debug.log*',
    '**/yarn-debug.log*',
    '**/yarn-error.log*',
  ];

  constructor(private storage: IStorage) {}

  /**
   * Get unique key for tracking sync state per project
   */
  private getProjectKey(userId: string, projectId: string): string {
    return `${userId}/${projectId}`;
  }

  private markSyncComplete(
    projectKey: string,
    errors: string[],
    snapshot?: Map<string, string>
  ): boolean {
    if (errors.length > 0) {
      return false;
    }

    this.lastSyncTime.set(projectKey, new Date());
    if (snapshot) {
      this.lastSyncHashes.set(projectKey, new Map(snapshot));
    }
    return true;
  }

  private hashBuffer(content: Buffer): string {
    return createHash('sha256').update(content).digest('hex');
  }

  private normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/^\.\/+/, '');
  }

  private isInternalStoragePath(filePath: string): boolean {
    return this.internalStoragePaths.has(this.normalizePath(filePath));
  }

  private shouldIgnoreSyncPath(filePath: string): boolean {
    const normalizedPath = this.normalizePath(filePath);

    if (!normalizedPath) {
      return false;
    }

    if (this.isInternalStoragePath(normalizedPath)) {
      return true;
    }

    const segments = normalizedPath.split('/').filter(Boolean);
    const baseName = segments[segments.length - 1];

    if (!baseName) {
      return false;
    }

    if (this.ignoredBaseNames.has(baseName) || this.ignoredDebugLogPattern.test(baseName)) {
      return true;
    }

    return segments.some(segment => this.ignoredDirectoryNames.has(segment));
  }

  /**
   * Download all R2 files to local projectPath (hydration)
   * Called before agent starts to populate local working directory
   */
  async hydrate(
    userId: string,
    projectId: string,
    projectPath: string
  ): Promise<HydrateResult> {
    const result: HydrateResult = { filesDownloaded: 0, errors: [] };
    const projectKey = this.getProjectKey(userId, projectId);
    const hydratedHashes = new Map<string, string>();

    log.info({ userId, projectId, projectPath }, 'Starting project hydration');

    try {
      // Ensure project directory exists
      await fs.mkdir(projectPath, { recursive: true });

      // Get list of all files in R2
      const r2FileList = await this.storage.listFiles(userId, projectId);
      const r2Files = r2FileList
        .map(f => f.path)
        .filter(filePath => !this.shouldIgnoreSyncPath(filePath));

      log.info({ userId, projectId, fileCount: r2Files.length }, 'Found files in R2');

      const staleFilesRemoved = await this.removeStaleLocalFiles(projectPath, new Set(r2Files), result.errors);
      if (staleFilesRemoved > 0) {
        log.info({ userId, projectId, staleFilesRemoved }, 'Removed stale local files before hydration');
      }

      // Download each file
      for (const filePath of r2Files) {
        try {
          const content = await this.storage.readFileBuffer(userId, projectId, filePath);
          const localPath = path.join(projectPath, filePath);

          // Ensure parent directory exists
          await fs.mkdir(path.dirname(localPath), { recursive: true });

          // Write file to local filesystem
          await fs.writeFile(localPath, content);
          hydratedHashes.set(filePath, this.hashBuffer(content));
          result.filesDownloaded++;

          log.debug({ userId, projectId, filePath }, 'Downloaded file');
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const errorMsg = `Failed to download ${filePath}: ${errorMessage}`;
          result.errors.push(errorMsg);
          log.error({ userId, projectId, filePath, errorMessage }, 'Failed to download file');
        }
      }

      // Only treat hydration as a valid baseline if it completed without gaps.
      if (!this.markSyncComplete(projectKey, result.errors, hydratedHashes)) {
        this.clearSyncState(userId, projectId);
      }

      log.info({
        userId,
        projectId,
        filesDownloaded: result.filesDownloaded,
        errors: result.errors.length,
      }, 'Project hydration complete');

    } catch (error) {
      const errorMsg = `Hydration failed: ${error}`;
      result.errors.push(errorMsg);
      log.error({ userId, projectId, error }, 'Project hydration failed');
    }

    return result;
  }

  /**
   * Sync local changes to R2
   * Called after file-modifying operations (Edit, Write, Bash)
   */
  async sync(
    userId: string,
    projectId: string,
    projectPath: string
  ): Promise<SyncResult> {
    const result: SyncResult = { filesUploaded: 0, filesDeleted: 0, errors: [] };
    const projectKey = this.getProjectKey(userId, projectId);
    const lastSync = this.lastSyncTime.get(projectKey) || new Date(0);
    const previousSnapshot = this.lastSyncHashes.get(projectKey);

    log.info({ userId, projectId, projectPath, lastSync }, 'Starting sync to R2');

    try {
      // Find all local files
      const localFiles = await this.getLocalFiles(projectPath);

      // Build a content-based snapshot so we do not miss edits when mtimes are preserved.
      const localSnapshot = await this.buildLocalSnapshot(projectPath, localFiles);
      result.errors.push(...localSnapshot.errors);

      // Find changed files by comparing content hashes against the last successful sync.
      const changedFiles = this.detectChanges(localSnapshot.hashes, previousSnapshot);

      log.info({
        userId,
        projectId,
        totalFiles: localFiles.length,
        changedFiles: changedFiles.length,
      }, 'Detected changes');

      // Upload changed files
      for (const filePath of changedFiles) {
        try {
          const localPath = path.join(projectPath, filePath);
          const content = await fs.readFile(localPath);

          await this.storage.writeFile(userId, projectId, filePath, content);
          result.filesUploaded++;

          log.debug({ userId, projectId, filePath }, 'Uploaded file to R2');
        } catch (error) {
          const errorMsg = `Failed to upload ${filePath}: ${error}`;
          result.errors.push(errorMsg);
          log.error({ userId, projectId, filePath, error }, 'Failed to upload file');
        }
      }

      // Handle deletions
      const deletionResult = await this.syncDeletions(userId, projectId, projectPath, localFiles);
      result.filesDeleted = deletionResult.filesDeleted;
      result.errors.push(...deletionResult.errors);

      // Keep the previous successful baseline if any upload/delete step failed.
      this.markSyncComplete(projectKey, result.errors, localSnapshot.hashes);

      log.info({
        userId,
        projectId,
        filesUploaded: result.filesUploaded,
        filesDeleted: result.filesDeleted,
        errors: result.errors.length,
      }, 'Sync to R2 complete');

    } catch (error) {
      const errorMsg = `Sync failed: ${error}`;
      result.errors.push(errorMsg);
      log.error({ userId, projectId, error }, 'Sync to R2 failed');
    }

    return result;
  }

  /**
   * Get all files in local project directory
   */
  private async getLocalFiles(projectPath: string): Promise<string[]> {
    try {
      const files = await glob('**/*', {
        cwd: projectPath,
        nodir: true,
        dot: true,
        ignore: this.globIgnorePatterns,
      });
      return files.filter(filePath => !this.shouldIgnoreSyncPath(filePath));
    } catch (error) {
      log.error({ projectPath, error }, 'Failed to list local files');
      return [];
    }
  }

  /**
   * Remove local files that no longer exist in storage so hydration starts from a clean cache.
   */
  private async removeStaleLocalFiles(
    projectPath: string,
    validFiles: Set<string>,
    errors: string[]
  ): Promise<number> {
    let filesRemoved = 0;
    const localFiles = await this.getLocalFiles(projectPath);

    for (const filePath of localFiles) {
      if (validFiles.has(filePath)) {
        continue;
      }

      try {
        await fs.rm(path.join(projectPath, filePath), { force: true });
        filesRemoved++;
      } catch (error) {
        const errorMsg = `Failed to remove stale local file ${filePath}: ${error}`;
        errors.push(errorMsg);
        log.error({ projectPath, filePath, error }, 'Failed to remove stale local file');
      }
    }

    return filesRemoved;
  }

  /**
   * Detect which files have changed since last sync
   */
  private async buildLocalSnapshot(
    projectPath: string,
    localFiles: string[]
  ): Promise<{ hashes: Map<string, string>; errors: string[] }> {
    const hashes = new Map<string, string>();
    const errors: string[] = [];

    for (const filePath of localFiles) {
      try {
        const fullPath = path.join(projectPath, filePath);
        const content = await fs.readFile(fullPath);
        hashes.set(filePath, this.hashBuffer(content));
      } catch (error) {
        const errorMsg = `Failed to read ${filePath} for sync: ${error}`;
        errors.push(errorMsg);
        log.error({ filePath, error }, 'Could not read file for sync');
      }
    }

    return { hashes, errors };
  }

  private detectChanges(
    currentSnapshot: Map<string, string>,
    previousSnapshot?: Map<string, string>
  ): string[] {
    if (!previousSnapshot) {
      return Array.from(currentSnapshot.keys());
    }

    const changed: string[] = [];

    for (const [filePath, hash] of currentSnapshot.entries()) {
      if (previousSnapshot.get(filePath) !== hash) {
        changed.push(filePath);
      }
    }

    return changed;
  }

  /**
   * Sync file deletions to R2
   */
  private async syncDeletions(
    userId: string,
    projectId: string,
    projectPath: string,
    localFiles: string[]
  ): Promise<{ filesDeleted: number; errors: string[] }> {
    const result = { filesDeleted: 0, errors: [] as string[] };

    try {
      // Get files in R2
      const r2FileList = await this.storage.listFiles(userId, projectId);
      const r2ContentFiles = r2FileList
        .map(f => f.path)
        .filter(filePath => !this.isInternalStoragePath(filePath));

      // Find files that exist in R2 but not locally (deleted)
      const localFileSet = new Set(localFiles);
      const deletedFiles = r2ContentFiles.filter(f => !localFileSet.has(f));

      log.debug({
        userId,
        projectId,
        deletedCount: deletedFiles.length,
      }, 'Detected deleted files');

      // Delete from R2
      for (const filePath of deletedFiles) {
        try {
          await this.storage.deleteFile(userId, projectId, filePath);
          result.filesDeleted++;
          log.debug({ userId, projectId, filePath }, 'Deleted file from R2');
        } catch (error) {
          const errorMsg = `Failed to delete ${filePath}: ${error}`;
          result.errors.push(errorMsg);
          log.error({ userId, projectId, filePath, error }, 'Failed to delete file from R2');
        }
      }
    } catch (error) {
      const errorMsg = `Deletion sync failed: ${error}`;
      result.errors.push(errorMsg);
      log.error({ userId, projectId, error }, 'Deletion sync failed');
    }

    return result;
  }

  /**
   * Force full sync (upload all local files regardless of mtime)
   */
  async fullSync(
    userId: string,
    projectId: string,
    projectPath: string
  ): Promise<SyncResult> {
    const projectKey = this.getProjectKey(userId, projectId);

    // Clear the hash baseline so every current file is treated as changed.
    this.lastSyncTime.set(projectKey, new Date(0));
    this.lastSyncHashes.delete(projectKey);

    return this.sync(userId, projectId, projectPath);
  }

  /**
   * Clear sync state for a project (call on session end)
   */
  clearSyncState(userId: string, projectId: string): void {
    const projectKey = this.getProjectKey(userId, projectId);
    this.lastSyncTime.delete(projectKey);
    this.lastSyncHashes.delete(projectKey);
    log.debug({ userId, projectId }, 'Cleared sync state');
  }
}

// Singleton instance
let syncServiceInstance: ProjectSyncService | null = null;

export function createSyncService(storage: IStorage): ProjectSyncService {
  if (!syncServiceInstance) {
    syncServiceInstance = new ProjectSyncService(storage);
  }
  return syncServiceInstance;
}

export function getSyncService(): ProjectSyncService {
  if (!syncServiceInstance) {
    throw new Error('Sync service not initialized. Call createSyncService first.');
  }
  return syncServiceInstance;
}
