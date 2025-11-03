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
import type { IStorage, StorageFile, ProjectMetadata } from './types.js';

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
   */
  private getKey(userId: string, projectId: string, filePath: string = ''): string {
    const parts = ['projects', userId, projectId];
    if (filePath) {
      // Remove leading slash if present
      parts.push(filePath.startsWith('/') ? filePath.slice(1) : filePath);
    }
    return parts.join('/');
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

  async writeFile(
    userId: string,
    projectId: string,
    filePath: string,
    content: string | Buffer
  ): Promise<void> {
    const key = this.getKey(userId, projectId, filePath);
    const contentType = lookup(filePath) || 'application/octet-stream';

    const body = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    console.log(`[R2] Writing ${key}, content type: ${typeof content}, isBuffer: ${Buffer.isBuffer(content)}, body isBuffer: ${Buffer.isBuffer(body)}`);
    if (Buffer.isBuffer(body)) {
      console.log(`[R2] First 4 bytes: ${body.slice(0, 4).toString('hex')}`);
    }

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

    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucketName,
        CopySource: `${this.bucketName}/${sourceKey}`,
        Key: destKey,
      })
    );

    // Cache the destination file by copying from source cache if available
    const cached = this.getCachedBuffer(sourceKey);
    if (cached) {
      this.cacheBuffer(destKey, cached);
    }
  }

  async listFiles(userId: string, projectId: string, prefix: string = ''): Promise<StorageFile[]> {
    const baseKey = this.getKey(userId, projectId, prefix);

    const response = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: baseKey,
      })
    );

    if (!response.Contents) {
      return [];
    }

    const projectKeyPrefix = this.getKey(userId, projectId, '');
    const files: StorageFile[] = response.Contents.filter(
      (obj) => obj.Key && obj.Key !== this.getMetadataKey(userId, projectId)
    ).map((obj) => {
      // Remove the project prefix to get relative path
      const relativePath = obj.Key!.slice(projectKeyPrefix.length);
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
    // List all files in the project
    const files = await this.listFiles(userId, projectId);

    // Delete all files
    for (const file of files) {
      await this.deleteFile(userId, projectId, file.path);
    }

    // Delete metadata
    const metadataKey = this.getMetadataKey(userId, projectId);
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: metadataKey,
      })
    );
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

    const response = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: prefix,
        Delimiter: '/',
      })
    );

    if (!response.CommonPrefixes) {
      return [];
    }

    // Extract project IDs from common prefixes
    const projects = response.CommonPrefixes.map((prefix) => {
      const parts = prefix.Prefix!.split('/');
      return parts[parts.length - 2]; // Get project ID
    });

    return projects;
  }

  async renameProject(
    userId: string,
    oldProjectId: string,
    newProjectId: string
  ): Promise<void> {
    // List all files in old project
    const files = await this.listFiles(userId, oldProjectId);

    // Copy each file to new location
    for (const file of files) {
      const oldKey = this.getKey(userId, oldProjectId, file.path);
      const newKey = this.getKey(userId, newProjectId, file.path);

      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucketName,
          CopySource: `${this.bucketName}/${oldKey}`,
          Key: newKey,
        })
      );
    }

    // Copy and update metadata
    const oldMetadata = await this.getProjectMetadata(userId, oldProjectId);
    if (oldMetadata) {
      await this.updateProjectMetadata(userId, newProjectId, {
        ...oldMetadata,
        id: newProjectId,
        name: newProjectId,
      });
    }

    // Delete old project
    await this.deleteProject(userId, oldProjectId);
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
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucketName,
          Prefix: 'projects/',
          Delimiter: '/',
        })
      );

      if (!response.CommonPrefixes) {
        return null;
      }

      // Check each user to see if they own this project
      for (const prefix of response.CommonPrefixes) {
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
}
