/**
 * Filesystem Storage Implementation
 * Stores files in local filesystem (current/default behavior)
 */

import fs from 'fs/promises';
import path from 'path';
import archiver from 'archiver';
import type { IStorage, StorageFile, ProjectMetadata } from './types.js';

/**
 * Validate and sanitize file path to prevent path traversal attacks
 * @throws Error if path is invalid
 */
function validateFilePath(filePath: string): string {
  // Reject empty paths
  if (!filePath || filePath.trim() === '') {
    throw new Error('File path cannot be empty');
  }

  // Reject absolute paths
  if (filePath.startsWith('/') || (filePath.length > 1 && filePath[1] === ':')) {
    throw new Error('Absolute paths are not allowed');
  }

  // Reject path traversal attempts
  if (filePath.includes('..')) {
    throw new Error('Path traversal is not allowed');
  }

  // Reject paths with null bytes (common attack vector)
  if (filePath.includes('\0')) {
    throw new Error('Invalid characters in path');
  }

  // Normalize and validate using path.normalize
  const normalized = path.normalize(filePath).replace(/\\/g, '/');

  // After normalization, check again for traversal (path.normalize resolves ..)
  if (normalized.startsWith('..') || normalized.includes('/..') || normalized.startsWith('/')) {
    throw new Error('Path traversal is not allowed');
  }

  return normalized;
}

export class FilesystemStorage implements IStorage {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  async initialize(): Promise<void> {
    // Ensure base directory exists
    await fs.mkdir(this.baseDir, { recursive: true });
  }

  /**
   * Get the base path for a user
   */
  private getUserPath(userId: string): string {
    return path.join(this.baseDir, userId);
  }

  /**
   * Get the full path for a project
   */
  private getProjectPath(userId: string, projectId: string): string {
    return path.join(this.baseDir, userId, projectId);
  }

  /**
   * Get the full path for a file
   * Validates filePath to prevent path traversal attacks
   */
  getFilePath(userId: string, projectId: string, filePath: string): string {
    const safePath = validateFilePath(filePath);
    return path.join(this.getProjectPath(userId, projectId), safePath);
  }

  /**
   * Get metadata file path
   */
  private getMetadataPath(userId: string, projectId: string): string {
    return path.join(this.getProjectPath(userId, projectId), '.metadata.json');
  }

  async writeFile(
    userId: string,
    projectId: string,
    filePath: string,
    content: string | Buffer
  ): Promise<void> {
    const fullPath = this.getFilePath(userId, projectId, filePath);
    const dirname = path.dirname(fullPath);

    // Ensure directory exists
    await fs.mkdir(dirname, { recursive: true });

    // Write file
    await fs.writeFile(fullPath, content, typeof content === 'string' ? 'utf-8' : undefined);

    // Update project metadata
    await this.touchProjectMetadata(userId, projectId);
  }

  async readFile(userId: string, projectId: string, filePath: string): Promise<string> {
    const fullPath = this.getFilePath(userId, projectId, filePath);
    return await fs.readFile(fullPath, 'utf-8');
  }

  async readFileBuffer(userId: string, projectId: string, filePath: string): Promise<Buffer> {
    const fullPath = this.getFilePath(userId, projectId, filePath);
    return await fs.readFile(fullPath);
  }

  async fileExists(userId: string, projectId: string, filePath: string): Promise<boolean> {
    const fullPath = this.getFilePath(userId, projectId, filePath);

    try {
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  async deleteFile(userId: string, projectId: string, filePath: string): Promise<void> {
    const fullPath = this.getFilePath(userId, projectId, filePath);
    await fs.unlink(fullPath);

    // Update project metadata
    await this.touchProjectMetadata(userId, projectId);
  }

  async copyFile(userId: string, projectId: string, sourcePath: string, destPath: string): Promise<void> {
    const sourceFullPath = this.getFilePath(userId, projectId, sourcePath);
    const destFullPath = this.getFilePath(userId, projectId, destPath);
    const destDir = path.dirname(destFullPath);

    // Ensure destination directory exists
    await fs.mkdir(destDir, { recursive: true });

    // Copy file
    await fs.copyFile(sourceFullPath, destFullPath);
  }

  async listFiles(userId: string, projectId: string, prefix: string = ''): Promise<StorageFile[]> {
    const basePath = prefix
      ? this.getFilePath(userId, projectId, prefix)
      : this.getProjectPath(userId, projectId);
    const files: StorageFile[] = [];

    async function walk(dir: string, baseDir: string): Promise<void> {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          // Skip metadata file
          if (entry.name === '.metadata.json') {
            continue;
          }

          const fullPath = path.join(dir, entry.name);
          const relativePath = path.relative(baseDir, fullPath);

          if (entry.isDirectory()) {
            // Recursively walk subdirectories
            await walk(fullPath, baseDir);
          } else {
            const stats = await fs.stat(fullPath);
            files.push({
              path: relativePath,
              name: entry.name,
              size: stats.size,
              lastModified: stats.mtime,
              isDirectory: false,
            });
          }
        }
      } catch (error: any) {
        // Directory doesn't exist or not accessible
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
    }

    const projectPath = this.getProjectPath(userId, projectId);
    await walk(basePath, projectPath);
    return files;
  }

  async createProject(userId: string, projectId: string): Promise<void> {
    const projectPath = this.getProjectPath(userId, projectId);
    await fs.mkdir(projectPath, { recursive: true });

    // Create project metadata
    const metadata: ProjectMetadata = {
      id: projectId,
      name: projectId,
      createdAt: new Date(),
      updatedAt: new Date(),
      published: false,
    };

    await this.updateProjectMetadata(userId, projectId, metadata);
  }

  async deleteProject(userId: string, projectId: string): Promise<void> {
    const projectPath = this.getProjectPath(userId, projectId);
    await fs.rm(projectPath, { recursive: true, force: true });
  }

  async projectExists(userId: string, projectId: string): Promise<boolean> {
    const projectPath = this.getProjectPath(userId, projectId);

    try {
      await fs.access(projectPath);
      return true;
    } catch {
      return false;
    }
  }

  async listProjects(userId: string): Promise<string[]> {
    const userPath = this.getUserPath(userId);

    try {
      await fs.mkdir(userPath, { recursive: true });
      const entries = await fs.readdir(userPath, { withFileTypes: true });

      return entries
        .filter((entry) => entry.isDirectory() && entry.name !== 'uploads')
        .map((entry) => entry.name);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async renameProject(
    userId: string,
    oldProjectId: string,
    newProjectId: string
  ): Promise<void> {
    const oldPath = this.getProjectPath(userId, oldProjectId);
    const newPath = this.getProjectPath(userId, newProjectId);

    await fs.rename(oldPath, newPath);

    // Update metadata
    const metadata = await this.getProjectMetadata(userId, newProjectId);
    if (metadata) {
      metadata.id = newProjectId;
      await this.updateProjectMetadata(userId, newProjectId, metadata);
    }
  }

  async getProjectMetadata(
    userId: string,
    projectId: string
  ): Promise<ProjectMetadata | null> {
    const metadataPath = this.getMetadataPath(userId, projectId);

    try {
      const content = await fs.readFile(metadataPath, 'utf-8');
      const metadata = JSON.parse(content);

      // Parse dates
      metadata.createdAt = new Date(metadata.createdAt);
      metadata.updatedAt = new Date(metadata.updatedAt);

      return metadata;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // Metadata file doesn't exist, create default
        const defaultMetadata: ProjectMetadata = {
          id: projectId,
          name: projectId,
          createdAt: new Date(),
          updatedAt: new Date(),
          published: false,
        };
        return defaultMetadata;
      }
      throw error;
    }
  }

  async updateProjectMetadata(
    userId: string,
    projectId: string,
    metadata: Partial<ProjectMetadata>
  ): Promise<void> {
    const metadataPath = this.getMetadataPath(userId, projectId);

    // Get existing metadata or create new
    let existing = await this.getProjectMetadata(userId, projectId);
    if (!existing) {
      existing = {
        id: projectId,
        name: projectId,
        createdAt: new Date(),
        updatedAt: new Date(),
        published: false,
      };
    }

    // Merge with new metadata
    const updated = {
      ...existing,
      ...metadata,
      updatedAt: new Date(),
    };

    // Ensure project directory exists
    const projectPath = this.getProjectPath(userId, projectId);
    await fs.mkdir(projectPath, { recursive: true });

    // Write metadata
    await fs.writeFile(metadataPath, JSON.stringify(updated, null, 2), 'utf-8');
  }

  /**
   * Touch project metadata (update updatedAt timestamp)
   */
  private async touchProjectMetadata(userId: string, projectId: string): Promise<void> {
    try {
      await this.updateProjectMetadata(userId, projectId, {});
    } catch (error) {
      // Ignore errors when touching metadata
    }
  }

  async uploadFile(userId: string, fileName: string, content: Buffer): Promise<string> {
    const uploadsPath = path.join(this.baseDir, userId, 'uploads');
    await fs.mkdir(uploadsPath, { recursive: true });

    const filePath = path.join(uploadsPath, fileName);
    await fs.writeFile(filePath, content);

    return filePath;
  }

  getUploadsPath(userId: string): string {
    return path.join(this.baseDir, userId, 'uploads');
  }

  async findProjectOwner(projectId: string): Promise<string | null> {
    try {
      // List all user directories
      const entries = await fs.readdir(this.baseDir, { withFileTypes: true });
      // Consider all user directories except 'uploads'
      const userDirs = entries.filter(e => e.isDirectory() && e.name !== 'uploads');

      // Check each user to see if they own this project
      for (const userDir of userDirs) {
        const userId = userDir.name;
        const exists = await this.projectExists(userId, projectId);
        if (exists) {
          return userId;
        }
      }

      return null;
    } catch (error: any) {
      console.error('Error finding project owner:', error);
      return null;
    }
  }

  async exportProject(userId: string, projectId: string): Promise<Buffer> {
    const projectPath = this.getProjectPath(userId, projectId);

    // Check if project exists
    if (!await this.projectExists(userId, projectId)) {
      throw new Error(`Project ${projectId} not found`);
    }

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const archive = archiver('zip', {
        zlib: { level: 9 } // Maximum compression
      });

      // Collect data chunks
      archive.on('data', (chunk: Buffer) => chunks.push(chunk));

      // Handle completion
      archive.on('end', () => {
        resolve(Buffer.concat(chunks));
      });

      // Handle errors
      archive.on('error', (err: Error) => {
        reject(err);
      });

      // Add all files from project directory
      // Exclude metadata file from export
      archive.glob('**/*', {
        cwd: projectPath,
        ignore: ['.metadata.json'],
        dot: false
      });

      // Finalize the archive
      archive.finalize();
    });
  }
}
