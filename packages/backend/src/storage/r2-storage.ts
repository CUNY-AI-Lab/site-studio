/**
 * Cloudflare R2 Storage Implementation
 * Uses AWS S3-compatible API to store files in Cloudflare R2
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { lookup } from 'mime-types';
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
  if (filePath.startsWith('/')) {
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

  // Normalize path separators and remove leading/trailing slashes
  const normalized = filePath
    .replace(/\\/g, '/')  // Convert backslashes to forward slashes
    .replace(/\/+/g, '/') // Collapse multiple slashes
    .replace(/^\/+/, '')  // Remove leading slashes
    .replace(/\/+$/, ''); // Remove trailing slashes

  // Final check: ensure normalized path doesn't start with ..
  if (normalized.startsWith('..') || normalized.includes('/..')) {
    throw new Error('Path traversal is not allowed');
  }

  return normalized;
}

export class R2Storage implements IStorage {
  private client: S3Client;
  private bucketName: string;
  private accountId: string;
  private cache: Map<string, { buffer: Buffer; timestamp: number }>;
  private readonly CACHE_TTL_MS = 60_000; // 1 minute cache
  private readonly MAX_CACHE_SIZE = 100; // Max 100 files cached

  constructor(
    accountId: string,
    accessKeyId: string,
    secretAccessKey: string,
    bucketName: string
  ) {
    this.accountId = accountId;
    this.bucketName = bucketName;
    this.cache = new Map();

    // Initialize S3 client with R2 endpoint
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
  }

  async initialize(): Promise<void> {
    // R2 bucket should already exist
    // No initialization needed for R2
  }

  /**
   * Generate R2 object key from user/project/file path
   * Validates filePath to prevent path traversal attacks
   */
  private getKey(userId: string, projectId: string, filePath: string = ''): string {
    const parts = ['projects', userId, projectId];
    if (filePath) {
      // Validate and sanitize the file path
      const safePath = validateFilePath(filePath);
      parts.push(safePath);
    }
    return parts.join('/');
  }

  /**
   * Generate the object-prefix for all non-metadata files in a project.
   * The trailing slash ensures we don't match sibling project IDs with the same prefix.
   */
  private getProjectPrefix(userId: string, projectId: string): string {
    return `${this.getKey(userId, projectId)}/`;
  }

  /**
   * Collect all paginated results for a ListObjectsV2 query.
   */
  private async listAllObjects(params: {
    Prefix: string;
    Delimiter?: string;
  }): Promise<{
    contents: Array<{ Key?: string; Size?: number; LastModified?: Date }>;
    commonPrefixes: Array<{ Prefix?: string }>;
  }> {
    const contents: Array<{ Key?: string; Size?: number; LastModified?: Date }> = [];
    const commonPrefixes: Array<{ Prefix?: string }> = [];
    let continuationToken: string | undefined;

    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucketName,
          ...params,
          ContinuationToken: continuationToken,
        })
      );

      if (response.Contents) {
        contents.push(...response.Contents);
      }

      if (response.CommonPrefixes) {
        commonPrefixes.push(...response.CommonPrefixes);
      }

      continuationToken = response.IsTruncated
        ? response.NextContinuationToken
        : undefined;
    } while (continuationToken);

    return { contents, commonPrefixes };
  }

  /**
   * Generate key for uploads
   */
  private getUploadKey(userId: string, fileName: string): string {
    return `uploads/${userId}/${fileName}`;
  }

  /**
   * Generate key for project metadata
   */
  private getMetadataKey(userId: string, projectId: string): string {
    return this.getKey(userId, projectId, '.metadata.json');
  }

  /**
   * Get cached file buffer if available and not expired
   */
  private getCachedBuffer(key: string): Buffer | null {
    const cached = this.cache.get(key);
    if (!cached) return null;

    const age = Date.now() - cached.timestamp;
    if (age > this.CACHE_TTL_MS) {
      this.cache.delete(key);
      return null;
    }

    return cached.buffer;
  }

  /**
   * Cache a file buffer (with LRU eviction)
   */
  private cacheBuffer(key: string, buffer: Buffer): void {
    // LRU eviction: remove oldest entry if cache is full
    if (this.cache.size >= this.MAX_CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, {
      buffer,
      timestamp: Date.now(),
    });
  }

  /**
   * Invalidate cache for a specific key
   */
  private invalidateCache(key: string): void {
    this.cache.delete(key);
  }

  private summarizeObjectErrors(action: string, projectId: string, errors: string[]): Error {
    const preview = errors.slice(0, 3).join('; ');
    const suffix = errors.length > 3 ? `; and ${errors.length - 3} more` : '';
    return new Error(`Failed to ${action} project ${projectId}: ${preview}${suffix}`);
  }

  private async copyObject(sourceKey: string, destKey: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucketName,
        CopySource: `${this.bucketName}/${sourceKey}`,
        Key: destKey,
      })
    );

    const cached = this.getCachedBuffer(sourceKey);
    if (cached) {
      this.cacheBuffer(destKey, cached);
    }
  }

  private async deleteKeys(keys: string[]): Promise<string[]> {
    const errors: string[] = [];

    for (const key of keys) {
      try {
        await this.client.send(
          new DeleteObjectCommand({
            Bucket: this.bucketName,
            Key: key,
          })
        );
        this.invalidateCache(key);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push(`${key}: ${errorMessage}`);
      }
    }

    return errors;
  }

  private async getProjectObjectKeys(userId: string, projectId: string): Promise<string[]> {
    const files = await this.listFiles(userId, projectId);
    return [
      ...files.map((file) => this.getKey(userId, projectId, file.path)),
      this.getMetadataKey(userId, projectId),
    ];
  }

  async writeFile(
    userId: string,
    projectId: string,
    filePath: string,
    content: string | Buffer
  ): Promise<void> {
    const key = this.getKey(userId, projectId, filePath);
    const contentType = lookup(filePath) || 'application/octet-stream';

    const body = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: 'public, max-age=3600',
      })
    );

    // Invalidate cache for this file
    this.invalidateCache(key);
  }

  async readFile(userId: string, projectId: string, filePath: string): Promise<string> {
    const buffer = await this.readFileBuffer(userId, projectId, filePath);
    return buffer.toString('utf-8');
  }

  async readFileBuffer(userId: string, projectId: string, filePath: string): Promise<Buffer> {
    const key = this.getKey(userId, projectId, filePath);

    // Check cache first
    const cached = this.getCachedBuffer(key);
    if (cached) {
      return cached;
    }

    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: key,
        })
      );

      if (!response.Body) {
        throw new Error('No content in response');
      }

      // Convert stream to buffer
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.Body as any) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      // Cache the result
      this.cacheBuffer(key, buffer);

      return buffer;
    } catch (error: any) {
      if (error.name === 'NoSuchKey') {
        throw new Error(`File not found: ${filePath}`);
      }
      throw error;
    }
  }

  async fileExists(userId: string, projectId: string, filePath: string): Promise<boolean> {
    const key = this.getKey(userId, projectId, filePath);

    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucketName,
          Key: key,
        })
      );
      return true;
    } catch (error: any) {
      if (error.name === 'NotFound') {
        return false;
      }
      throw error;
    }
  }

  async deleteFile(userId: string, projectId: string, filePath: string): Promise<void> {
    const key = this.getKey(userId, projectId, filePath);

    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      })
    );

    // Invalidate cache for this file
    this.invalidateCache(key);
  }

  async copyFile(userId: string, projectId: string, sourcePath: string, destPath: string): Promise<void> {
    const sourceKey = this.getKey(userId, projectId, sourcePath);
    const destKey = this.getKey(userId, projectId, destPath);

    await this.copyObject(sourceKey, destKey);
  }

  async listFiles(userId: string, projectId: string, prefix: string = ''): Promise<StorageFile[]> {
    const projectKeyPrefix = this.getProjectPrefix(userId, projectId);
    const normalizedPrefix = prefix ? validateFilePath(prefix) : '';
    const baseKey = normalizedPrefix
      ? `${projectKeyPrefix}${normalizedPrefix}/`
      : projectKeyPrefix;

    const response = await this.listAllObjects({
      Prefix: baseKey,
    });

    if (response.contents.length === 0) {
      return [];
    }

    const files: StorageFile[] = response.contents.filter(
      (obj) => obj.Key && obj.Key !== this.getMetadataKey(userId, projectId)
    ).map((obj) => {
      // Remove the project prefix to get relative path
      let relativePath = obj.Key!.slice(projectKeyPrefix.length);
      const pathParts = relativePath.split('/');

      return {
        path: relativePath,
        name: pathParts[pathParts.length - 1],
        size: obj.Size || 0,
        lastModified: obj.LastModified || new Date(),
        isDirectory: false,
      };
    });

    return files;
  }

  async createProject(userId: string, projectId: string): Promise<void> {
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
    const keys = await this.getProjectObjectKeys(userId, projectId);
    const errors = await this.deleteKeys(keys);

    if (errors.length > 0) {
      throw this.summarizeObjectErrors('delete', projectId, errors);
    }
  }

  async projectExists(userId: string, projectId: string): Promise<boolean> {
    const metadataKey = this.getMetadataKey(userId, projectId);

    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucketName,
          Key: metadataKey,
        })
      );
      return true;
    } catch (error: any) {
      if (error.name === 'NotFound') {
        return false;
      }
      throw error;
    }
  }

  async listProjects(userId: string): Promise<string[]> {
    const prefix = `projects/${userId}/`;

    const response = await this.listAllObjects({
      Prefix: prefix,
      Delimiter: '/',
    });

    if (response.commonPrefixes.length === 0) {
      return [];
    }

    // Extract project IDs from common prefixes
    const projects = response.commonPrefixes.map((prefix) => {
      const parts = prefix.Prefix!.split('/');
      return parts[parts.length - 2]; // Get project ID
    });

    return [...new Set(projects)];
  }

  async renameProject(
    userId: string,
    oldProjectId: string,
    newProjectId: string
  ): Promise<void> {
    if (oldProjectId === newProjectId) {
      return;
    }

    // List all files in old project
    const files = await this.listFiles(userId, oldProjectId);
    const copiedKeys: string[] = [];
    let startedDeletingOldProject = false;

    try {
      // Copy each file to new location
      for (const file of files) {
        const oldKey = this.getKey(userId, oldProjectId, file.path);
        const newKey = this.getKey(userId, newProjectId, file.path);

        await this.copyObject(oldKey, newKey);
        copiedKeys.push(newKey);
      }

      // Copy and update metadata
      const oldMetadata = await this.getProjectMetadata(userId, oldProjectId);
      if (oldMetadata) {
        await this.updateProjectMetadata(userId, newProjectId, {
          ...oldMetadata,
          id: newProjectId,
        });
        copiedKeys.push(this.getMetadataKey(userId, newProjectId));
      }

      startedDeletingOldProject = true;
      const deleteErrors = await this.deleteKeys(await this.getProjectObjectKeys(userId, oldProjectId));
      if (deleteErrors.length > 0) {
        throw new Error(
          `Project files were copied to ${newProjectId}, but cleanup of ${oldProjectId} failed: ${deleteErrors.slice(0, 3).join('; ')}${deleteErrors.length > 3 ? `; and ${deleteErrors.length - 3} more` : ''}`
        );
      }
    } catch (error) {
      if (!startedDeletingOldProject && copiedKeys.length > 0) {
        const rollbackErrors = await this.deleteKeys(copiedKeys);
        if (rollbackErrors.length > 0) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Failed to rename project ${oldProjectId} to ${newProjectId}: ${errorMessage}. Rollback also failed: ${rollbackErrors.slice(0, 3).join('; ')}${rollbackErrors.length > 3 ? `; and ${rollbackErrors.length - 3} more` : ''}`
          );
        }
      }

      throw error;
    }
  }

  async getProjectMetadata(
    userId: string,
    projectId: string
  ): Promise<ProjectMetadata | null> {
    const key = this.getMetadataKey(userId, projectId);

    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: key,
        })
      );

      if (!response.Body) {
        return null;
      }

      const chunks: Uint8Array[] = [];
      for await (const chunk of response.Body as any) {
        chunks.push(chunk);
      }
      const content = Buffer.concat(chunks).toString('utf-8');
      const metadata = JSON.parse(content);

      // Parse dates
      metadata.createdAt = new Date(metadata.createdAt);
      metadata.updatedAt = new Date(metadata.updatedAt);

      return metadata;
    } catch (error: any) {
      if (error.name === 'NoSuchKey') {
        return null;
      }
      throw error;
    }
  }

  async updateProjectMetadata(
    userId: string,
    projectId: string,
    metadata: Partial<ProjectMetadata>
  ): Promise<void> {
    const key = this.getMetadataKey(userId, projectId);

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

    // Write back to R2
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: JSON.stringify(updated, null, 2),
        ContentType: 'application/json',
      })
    );
  }

  /**
   * Touch project metadata (update updatedAt timestamp)
   */
  private async touchProjectMetadata(userId: string, projectId: string): Promise<void> {
    await this.updateProjectMetadata(userId, projectId, {});
  }

  getFilePath(userId: string, projectId: string, filePath: string): string | null {
    // R2 doesn't have filesystem paths
    return null;
  }

  async uploadFile(userId: string, fileName: string, content: Buffer): Promise<string> {
    const key = this.getUploadKey(userId, fileName);
    const contentType = lookup(fileName) || 'application/octet-stream';

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: content,
        ContentType: contentType,
      })
    );

    // Return the key as the path
    return key;
  }

  getUploadsPath(userId: string): string | null {
    // R2 doesn't have filesystem paths
    return null;
  }

  async findProjectOwner(projectId: string): Promise<string | null> {
    try {
      // List all user prefixes in projects/
      const response = await this.listAllObjects({
        Prefix: 'projects/',
        Delimiter: '/',
      });

      if (response.commonPrefixes.length === 0) {
        return null;
      }

      // Check each user to see if they own this project
      for (const prefix of response.commonPrefixes) {
        // Extract userId from prefix: projects/user_xxx/
        const userId = prefix.Prefix!.split('/')[1];

        // Check if this user has the project
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
    // Check if project exists
    if (!await this.projectExists(userId, projectId)) {
      throw new Error(`Project ${projectId} not found`);
    }

    // Get all files in the project
    const files = await this.listFiles(userId, projectId);

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

      // Download and add each file to the archive
      const addFilesToArchive = async () => {
        try {
          for (const file of files) {
            if (!file.isDirectory) {
              const buffer = await this.readFileBuffer(userId, projectId, file.path);
              archive.append(buffer, { name: file.path });
            }
          }
          // Finalize the archive
          archive.finalize();
        } catch (error) {
          reject(error);
        }
      };

      addFilesToArchive();
    });
  }
}
