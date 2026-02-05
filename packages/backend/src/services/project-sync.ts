/**
 * Project Sync Service
 *
 * Handles bidirectional sync between local filesystem and R2 storage.
 * - Hydration: Download R2 files to local projectPath before agent starts
 * - Sync: Upload local changes to R2 after file operations
 */

import fs from 'fs/promises';
import path from 'path';
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

  constructor(private storage: IStorage) {}

  /**
   * Get unique key for tracking sync state per project
   */
  private getProjectKey(userId: string, projectId: string): string {
    return `${userId}/${projectId}`;
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

    log.info({ userId, projectId, projectPath }, 'Starting project hydration');

    try {
      // Ensure project directory exists
      await fs.mkdir(projectPath, { recursive: true });

      // Get list of all files in R2
      const r2FileList = await this.storage.listFiles(userId, projectId);
      const r2Files = r2FileList.map(f => f.path);

      log.info({ userId, projectId, fileCount: r2Files.length }, 'Found files in R2');

      // Download each file
      for (const filePath of r2Files) {
        // Skip metadata files
        if (filePath.startsWith('.metadata') || filePath === '.thumbnail.png') {
          continue;
        }

        try {
          const content = await this.storage.readFileBuffer(userId, projectId, filePath);
          const localPath = path.join(projectPath, filePath);

          // Ensure parent directory exists
          await fs.mkdir(path.dirname(localPath), { recursive: true });

          // Write file to local filesystem
          await fs.writeFile(localPath, content);
          result.filesDownloaded++;

          log.debug({ userId, projectId, filePath }, 'Downloaded file');
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const errorMsg = `Failed to download ${filePath}: ${errorMessage}`;
          result.errors.push(errorMsg);
          log.error({ userId, projectId, filePath, errorMessage }, 'Failed to download file');
        }
      }

      // Record sync time
      this.lastSyncTime.set(projectKey, new Date());

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

    log.info({ userId, projectId, projectPath, lastSync }, 'Starting sync to R2');

    try {
      // Find all local files
      const localFiles = await this.getLocalFiles(projectPath);

      // Find changed files (by mtime)
      const changedFiles = await this.detectChanges(projectPath, localFiles, lastSync);

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

      // Update sync time
      this.lastSyncTime.set(projectKey, new Date());

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
        dot: false, // Exclude dotfiles
        ignore: ['.metadata.json', '.thumbnail.png'],
      });
      return files;
    } catch (error) {
      log.error({ projectPath, error }, 'Failed to list local files');
      return [];
    }
  }

  /**
   * Detect which files have changed since last sync
   */
  private async detectChanges(
    projectPath: string,
    localFiles: string[],
    since: Date
  ): Promise<string[]> {
    const changed: string[] = [];

    for (const filePath of localFiles) {
      try {
        const fullPath = path.join(projectPath, filePath);
        const stat = await fs.stat(fullPath);

        if (stat.mtime > since) {
          changed.push(filePath);
        }
      } catch (error) {
        // File might have been deleted, skip
        log.debug({ filePath, error }, 'Could not stat file');
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
      const r2Files = r2FileList.map(f => f.path);

      // Filter out metadata files
      const r2ContentFiles = r2Files.filter(
        f => !f.startsWith('.metadata') && f !== '.thumbnail.png'
      );

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

    // Reset last sync time to epoch to force all files to be considered changed
    this.lastSyncTime.set(projectKey, new Date(0));

    return this.sync(userId, projectId, projectPath);
  }

  /**
   * Clear sync state for a project (call on session end)
   */
  clearSyncState(userId: string, projectId: string): void {
    const projectKey = this.getProjectKey(userId, projectId);
    this.lastSyncTime.delete(projectKey);
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
