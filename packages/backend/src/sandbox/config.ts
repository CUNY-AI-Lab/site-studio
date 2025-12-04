/**
 * Session Path Configuration
 * Provides paths for user project directories
 *
 * NOTE: This does NOT provide security sandboxing. Security is enforced by:
 * 1. disallowedTools in agent.ts (prevents Bash, WebSearch, etc.)
 * 2. Path validation in storage abstraction (prevents path traversal)
 * 3. Storage key prefixes (userId/projectId isolation)
 */

import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SANDBOXES_ROOT = process.env.SANDBOXES_DIR || path.join(__dirname, '../../sandboxes');

/**
 * Get the project path for a user's project
 */
export function getUserProjectPath(userId: string, projectId: string): string {
  return path.join(SANDBOXES_ROOT, userId, projectId);
}

/**
 * Get the uploads path for a user
 */
export function getUserUploadsPath(userId: string): string {
  return path.join(SANDBOXES_ROOT, userId, 'uploads');
}

/**
 * Get the sandboxes root directory
 */
export function getSandboxesRoot(): string {
  return SANDBOXES_ROOT;
}
