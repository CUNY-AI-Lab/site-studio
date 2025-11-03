import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { lookup } from 'mime-types';
import type { SandboxSession } from '../sandbox/manager.js';
import { getStorage } from '../storage/index.js';
import type { IStorage } from '../storage/types.js';

/**
 * Create file tools with projectPath and optional sandbox context
 * @param projectPath - Path to the project directory (for filesystem storage)
 * @param sandboxSession - Optional sandbox session for enhanced security validation
 * @param userId - User ID (for cloud storage)
 * @param projectId - Project ID (for cloud storage)
 */
export function createFileTools(
  projectPath: string,
  sandboxSession?: SandboxSession,
  userId?: string,
  projectId?: string
) {
  const storage: IStorage = getStorage();
  const useStorage = userId && projectId;
  /**
   * Tool: list_files
   * List all files in the current project
   */
  const listFiles = tool(
    'list_files',
    `List all files and directories in the current project.
Returns a tree structure showing the project's file organization.`,
    z.object({
      directory: z.string().optional().describe('Subdirectory to list (defaults to project root)'),
    }).shape,
    async (params) => {
      try {
        if (useStorage && userId && projectId) {
          // Use storage abstraction (R2 or filesystem)
          const prefix = params.directory || '';
          const files = await storage.listFiles(userId, projectId, prefix);

          // Build tree representation
          const lines: string[] = [];
          const tree: any = {};

          files.forEach(file => {
            const parts = file.path.split('/');
            let current = tree;

            parts.forEach((part: string, index: number) => {
              if (index === parts.length - 1) {
                if (!current._files) current._files = [];
                current._files.push(part);
              } else {
                if (!current[part]) current[part] = {};
                current = current[part];
              }
            });
          });

          function treeToLines(obj: any, prefix: string = '', path: string = ''): string[] {
            const result: string[] = [];

            Object.keys(obj).forEach(key => {
              if (key !== '_files') {
                result.push(`${prefix}📁 ${key}/`);
                result.push(...treeToLines(obj[key], prefix + '  ', path ? `${path}/${key}` : key));
              }
            });

            if (obj._files) {
              obj._files.forEach((file: string) => {
                result.push(`${prefix}📄 ${file}`);
              });
            }

            return result;
          }

          const treeLines = treeToLines(tree);

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                tree: treeLines.join('\n'),
                projectPath: `${userId}/${projectId}`,
              }, null, 2),
            }],
          };
        } else {
          // Legacy filesystem mode
          const targetDir = params.directory
            ? path.join(projectPath, params.directory)
            : projectPath;

          async function listDir(dir: string, prefix: string = ''): Promise<string[]> {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            const lines: string[] = [];

            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);

              if (entry.isDirectory()) {
                lines.push(`${prefix}📁 ${entry.name}/`);
                const subLines = await listDir(fullPath, prefix + '  ');
                lines.push(...subLines);
              } else {
                lines.push(`${prefix}📄 ${entry.name}`);
              }
            }

            return lines;
          }

          const tree = await listDir(targetDir);

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                tree: tree.join('\n'),
                projectPath: projectPath,
              }, null, 2),
            }],
          };
        }
      } catch (error: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error listing files: ${error.message}`,
          }],
        };
      }
    }
  );

  /**
   * Tool: read_file
   * Read the contents of a file
   */
  const readFile = tool(
    'read_file',
    `Read the contents of a file in the project.
Returns the file content as text.`,
    z.object({
      file_path: z.string().describe('Path to the file relative to project root'),
    }).shape,
    async (params) => {
      try {
        let content: string;

        if (useStorage && userId && projectId) {
          // Use storage abstraction
          content = await storage.readFile(userId, projectId, params.file_path);
        } else {
          // Legacy filesystem mode
          const fullPath = path.join(projectPath, params.file_path);
          const realPath = await fs.realpath(fullPath);
          const realProjectPath = await fs.realpath(projectPath);

          if (!realPath.startsWith(realProjectPath)) {
            throw new Error('Access denied: path outside project directory');
          }

          content = await fs.readFile(fullPath, 'utf-8');
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              file_path: params.file_path,
              content: content,
            }, null, 2),
          }],
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error reading file: ${error.message}`,
          }],
        };
      }
    }
  );

  /**
   * Tool: write_file
   * Write or update a file in the project
   */
  const writeFile = tool(
    'write_file',
    `Write content to a file in the project. Creates the file if it doesn't exist,
or updates it if it does. Parent directories are created automatically.`,
    z.object({
      file_path: z.string().describe('Path to the file relative to project root'),
      content: z.string().describe('Content to write to the file'),
    }).shape,
    async (params) => {
      try {
        if (useStorage && userId && projectId) {
          // Use storage abstraction
          await storage.writeFile(userId, projectId, params.file_path, params.content);
        } else {
          // Legacy filesystem mode
          const fullPath = path.join(projectPath, params.file_path);
          const dirname = path.dirname(fullPath);
          await fs.mkdir(dirname, { recursive: true });
          await fs.writeFile(fullPath, params.content, 'utf-8');
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              file_path: params.file_path,
              message: 'File written successfully',
            }, null, 2),
          }],
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error writing file: ${error.message}`,
          }],
        };
      }
    }
  );

  /**
   * Tool: delete_file
   * Delete a file from the project
   */
  const deleteFile = tool(
    'delete_file',
    `Delete a file from the project.`,
    z.object({
      file_path: z.string().describe('Path to the file relative to project root'),
    }).shape,
    async (params) => {
      try {
        if (useStorage && userId && projectId) {
          // Use storage abstraction
          await storage.deleteFile(userId, projectId, params.file_path);
        } else {
          // Legacy filesystem mode
          const fullPath = path.join(projectPath, params.file_path);
          const realPath = await fs.realpath(fullPath);
          const realProjectPath = await fs.realpath(projectPath);

          if (!realPath.startsWith(realProjectPath)) {
            throw new Error('Access denied: path outside project directory');
          }

          await fs.unlink(fullPath);
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              file_path: params.file_path,
              message: 'File deleted successfully',
            }, null, 2),
          }],
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error deleting file: ${error.message}`,
          }],
        };
      }
    }
  );

  /**
   * Tool: create_directory
   * Create a new directory
   */
  const createDirectory = tool(
    'create_directory',
    `Create a new directory in the project.`,
    z.object({
      directory_path: z.string().describe('Path to the directory relative to project root'),
    }).shape,
    async (params) => {
      try {
      const fullPath = path.join(projectPath, params.directory_path);

      await fs.mkdir(fullPath, { recursive: true });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            directory_path: params.directory_path,
            message: 'Directory created successfully',
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error creating directory: ${error.message}`,
        }],
      };
    }
  }
);

  /**
   * Tool: view_file
   * Download binary files from cloud storage to local filesystem so they can be viewed
   */
  const viewFile = tool(
    'view_file',
    `Download a binary file (image, PDF, audio, video, etc.) from cloud storage to local filesystem so it can be viewed using the Read tool. Use this for any non-text file that needs to be viewed.`,
    z.object({
      file_path: z.string().describe('Path to the file relative to project root'),
    }).shape,
    async (params) => {
      try {
        let buffer: Buffer;

        if (useStorage && userId && projectId) {
          // Download from R2 storage
          buffer = await storage.readFileBuffer(userId, projectId, params.file_path);
        } else {
          // Already on local filesystem - no download needed
          const fullPath = path.join(projectPath, params.file_path);
          try {
            await fs.access(fullPath);
            const mediaType = lookup(params.file_path) || 'application/octet-stream';
            return {
              content: [{
                type: 'text' as const,
                text: `File is already on local filesystem at ${fullPath}. Use the Read tool to view it.`
              }]
            };
          } catch {
            return {
              content: [{
                type: 'text' as const,
                text: `File not found: ${params.file_path}`
              }]
            };
          }
        }

        // Write to local filesystem in project directory
        const localPath = path.join(projectPath, params.file_path);
        const localDir = path.dirname(localPath);

        // Ensure directory exists
        await fs.mkdir(localDir, { recursive: true });

        // Write the buffer to local file
        await fs.writeFile(localPath, buffer);

        // Detect media type for user info
        const mediaType = lookup(params.file_path) || 'application/octet-stream';
        const sizeKB = (buffer.length / 1024).toFixed(2);

        return {
          content: [{
            type: 'text' as const,
            text: `Downloaded ${params.file_path} (${mediaType}, ${sizeKB} KB) to ${localPath}. Use the Read tool with this exact path: ${localPath}`
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error downloading file: ${error.message}`,
          }],
        };
      }
    }
  );

  /**
   * Tool: edit_file
   * Edit a file by replacing specific text
   */
  const editFile = tool(
    'edit_file',
    `Edit a file by replacing specific text. More efficient than rewriting the entire file when making small changes.`,
    z.object({
      file_path: z.string().describe('Path to the file relative to project root'),
      old_text: z.string().describe('Exact text to find and replace'),
      new_text: z.string().describe('Replacement text'),
    }).shape,
    async (params) => {
      try {
        let content: string;

        if (useStorage && userId && projectId) {
          // Read from R2
          content = await storage.readFile(userId, projectId, params.file_path);
        } else {
          // Read from filesystem
          const fullPath = path.join(projectPath, params.file_path);
          content = await fs.readFile(fullPath, 'utf-8');
        }

        // Check if text exists
        if (!content.includes(params.old_text)) {
          return {
            content: [{
              type: 'text' as const,
              text: `Error: The text to replace was not found in ${params.file_path}`,
            }],
          };
        }

        // Replace text
        const updated = content.replace(params.old_text, params.new_text);

        // Write back
        if (useStorage && userId && projectId) {
          await storage.writeFile(userId, projectId, params.file_path, updated);
        } else {
          const fullPath = path.join(projectPath, params.file_path);
          await fs.writeFile(fullPath, updated, 'utf-8');
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              file_path: params.file_path,
              message: 'File edited successfully',
            }, null, 2),
          }],
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error editing file: ${error.message}`,
          }],
        };
      }
    }
  );

  /**
   * Tool: search_files
   * Search for text across all project files
   */
  const searchFiles = tool(
    'search_files',
    `Search for text across all files in the project. Returns a list of files containing the search query.`,
    z.object({
      query: z.string().describe('Text to search for'),
      file_pattern: z.string().optional().describe('Optional glob pattern to filter files (e.g., "*.html", "*.css")'),
    }).shape,
    async (params) => {
      try {
        const matches: Array<{ path: string; line_numbers: number[] }> = [];

        if (useStorage && userId && projectId) {
          // Search in R2 - parallel file reads for better performance
          const files = await storage.listFiles(userId, projectId);

          // Filter files by pattern if provided
          const filesToSearch = files.filter(file => {
            if (params.file_pattern) {
              const regex = new RegExp(params.file_pattern.replace(/\*/g, '.*'));
              return regex.test(file.path);
            }
            return true;
          });

          // Read all files in parallel
          const searchResults = await Promise.allSettled(
            filesToSearch.map(async (file) => {
              const content = await storage.readFile(userId, projectId, file.path);
              if (content.includes(params.query)) {
                // Find line numbers
                const lines = content.split('\n');
                const lineNumbers = lines
                  .map((line, idx) => line.includes(params.query) ? idx + 1 : -1)
                  .filter(num => num > 0);

                return {
                  path: file.path,
                  line_numbers: lineNumbers,
                };
              }
              return null;
            })
          );

          // Collect successful matches
          for (const result of searchResults) {
            if (result.status === 'fulfilled' && result.value) {
              matches.push(result.value);
            }
          }
        } else {
          // Search in filesystem (legacy mode)
          const walkDir = async (dir: string, baseDir: string): Promise<void> => {
            const entries = await fs.readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);
              const relativePath = path.relative(baseDir, fullPath);

              if (entry.isDirectory()) {
                await walkDir(fullPath, baseDir);
              } else {
                // Skip if pattern provided and doesn't match
                if (params.file_pattern) {
                  const regex = new RegExp(params.file_pattern.replace(/\*/g, '.*'));
                  if (!regex.test(relativePath)) {
                    continue;
                  }
                }

                try {
                  const content = await fs.readFile(fullPath, 'utf-8');
                  if (content.includes(params.query)) {
                    const lines = content.split('\n');
                    const lineNumbers = lines
                      .map((line, idx) => line.includes(params.query) ? idx + 1 : -1)
                      .filter(num => num > 0);

                    matches.push({
                      path: relativePath,
                      line_numbers: lineNumbers,
                    });
                  }
                } catch (err) {
                  continue;
                }
              }
            }
          };

          await walkDir(projectPath, projectPath);
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              query: params.query,
              matches: matches,
              total_matches: matches.length,
            }, null, 2),
          }],
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error searching files: ${error.message}`,
          }],
        };
      }
    }
  );

  /**
   * Tool: rename_file
   * Rename or move a file
   */
  const renameFile = tool(
    'rename_file',
    `Rename or move a file to a different path within the project.`,
    z.object({
      old_path: z.string().describe('Current path to the file relative to project root'),
      new_path: z.string().describe('New path for the file relative to project root'),
    }).shape,
    async (params) => {
      try {
        if (useStorage && userId && projectId) {
          // Use optimized copyFile (CopyObject for R2) + delete
          await storage.copyFile(userId, projectId, params.old_path, params.new_path);
          await storage.deleteFile(userId, projectId, params.old_path);
        } else {
          // Filesystem: Use rename
          const oldFullPath = path.join(projectPath, params.old_path);
          const newFullPath = path.join(projectPath, params.new_path);

          // Create parent directory if needed
          await fs.mkdir(path.dirname(newFullPath), { recursive: true });
          await fs.rename(oldFullPath, newFullPath);
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              old_path: params.old_path,
              new_path: params.new_path,
              message: 'File renamed successfully',
            }, null, 2),
          }],
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error renaming file: ${error.message}`,
          }],
        };
      }
    }
  );

  return [
    listFiles,
    readFile,
    writeFile,
    deleteFile,
    createDirectory,
    viewFile,
    editFile,
    searchFiles,
    renameFile,
  ];
}
