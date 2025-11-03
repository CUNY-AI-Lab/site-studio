/**
 * Storage abstraction types for Site Studio
 * Allows switching between filesystem and cloud storage (R2)
 */

export interface StorageFile {
  path: string;
  name: string;
  size: number;
  lastModified: Date;
  isDirectory: boolean;
}

export interface ProjectMetadata {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  published: boolean;
  publishedUrl?: string;
  publishedAt?: string;
  unpublishedAt?: string;
  thumbnailUrl?: string;
}

/**
 * Storage interface that abstracts file operations
 * Implementations: FilesystemStorage, R2Storage
 */
export interface IStorage {
  /**
   * Initialize the storage (create directories, buckets, etc.)
   */
  initialize(): Promise<void>;

  /**
   * Write a file to storage
   */
  writeFile(userId: string, projectId: string, filePath: string, content: string | Buffer): Promise<void>;

  /**
   * Read a file from storage
   */
  readFile(userId: string, projectId: string, filePath: string): Promise<string>;

  /**
   * Read a file as a buffer (for binary files)
   */
  readFileBuffer(userId: string, projectId: string, filePath: string): Promise<Buffer>;

  /**
   * Check if a file exists
   */
  fileExists(userId: string, projectId: string, filePath: string): Promise<boolean>;

  /**
   * Delete a file from storage
   */
  deleteFile(userId: string, projectId: string, filePath: string): Promise<void>;

  /**
   * Copy a file within storage (optimized for R2 using CopyObject)
   */
  copyFile(userId: string, projectId: string, sourcePath: string, destPath: string): Promise<void>;

  /**
   * List all files in a project directory
   */
  listFiles(userId: string, projectId: string, prefix?: string): Promise<StorageFile[]>;

  /**
   * Create a project directory
   */
  createProject(userId: string, projectId: string): Promise<void>;

  /**
   * Delete an entire project
   */
  deleteProject(userId: string, projectId: string): Promise<void>;

  /**
   * Check if a project exists
   */
  projectExists(userId: string, projectId: string): Promise<boolean>;

  /**
   * List all projects for a user
   */
  listProjects(userId: string): Promise<string[]>;

  /**
   * Rename/move a project
   */
  renameProject(userId: string, oldProjectId: string, newProjectId: string): Promise<void>;

  /**
   * Get project metadata
   */
  getProjectMetadata(userId: string, projectId: string): Promise<ProjectMetadata | null>;

  /**
   * Update project metadata
   */
  updateProjectMetadata(userId: string, projectId: string, metadata: Partial<ProjectMetadata>): Promise<void>;

  /**
   * Get the full path for a file (for filesystem access, if applicable)
   * Returns null for cloud storage implementations
   */
  getFilePath(userId: string, projectId: string, filePath: string): string | null;

  /**
   * Upload a file (for multer compatibility)
   */
  uploadFile(userId: string, fileName: string, content: Buffer): Promise<string>;

  /**
   * Get uploads path for a user
   */
  getUploadsPath(userId: string): string | null;

  /**
   * Find the owner (userId) of a project by projectId
   * Searches across all users to find who owns the given project
   * Returns null if project not found
   */
  findProjectOwner(projectId: string): Promise<string | null>;
}
