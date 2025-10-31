/**
 * Storage factory and exports
 * Creates the appropriate storage implementation based on configuration
 */

import path from 'path';
import { fileURLToPath } from 'url';
import type { IStorage } from './types.js';
import { FilesystemStorage } from './filesystem-storage.js';
import { R2Storage } from './r2-storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type { IStorage, StorageFile, ProjectMetadata } from './types.js';
export { FilesystemStorage } from './filesystem-storage.js';
export { R2Storage } from './r2-storage.js';

/**
 * Create storage instance based on environment configuration
 */
export function createStorage(): IStorage {
  const storageType = process.env.STORAGE_TYPE || 'filesystem';

  if (storageType === 'r2') {
    // Cloudflare R2 storage
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const bucketName = process.env.R2_BUCKET_NAME || 'site-studio';

    if (!accountId || !accessKeyId || !secretAccessKey) {
      throw new Error(
        'R2 storage requires R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY environment variables'
      );
    }

    console.log(`Using R2 storage with bucket: ${bucketName}`);
    return new R2Storage(accountId, accessKeyId, secretAccessKey, bucketName);
  } else {
    // Filesystem storage (default)
    const sandboxesDir = process.env.SANDBOXES_DIR || path.join(__dirname, '../../sandboxes');
    console.log(`Using filesystem storage at: ${sandboxesDir}`);
    return new FilesystemStorage(sandboxesDir);
  }
}

// Global storage instance
let storage: IStorage | null = null;

/**
 * Get the global storage instance
 */
export function getStorage(): IStorage {
  if (!storage) {
    storage = createStorage();
  }
  return storage;
}

/**
 * Initialize storage (call once at startup)
 */
export async function initializeStorage(): Promise<void> {
  const storageInstance = getStorage();
  await storageInstance.initialize();
  console.log('Storage initialized successfully');
}
