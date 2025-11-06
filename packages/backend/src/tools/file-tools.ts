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
      const startTime = Date.now();
      try {
        if (useStorage && userId && projectId) {
          // Use storage abstraction (R2 or filesystem)
          const prefix = params.directory || '';
          const r2Start = Date.now();
          const files = await storage.listFiles(userId, projectId, prefix);
          console.log(`[Tool:list_files] R2 listFiles took ${Date.now() - r2Start}ms`);

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

          console.log(`[Tool:list_files] Total time: ${Date.now() - startTime}ms`);

          // Return clean tree view for agent and users
          return {
            content: [{
              type: 'text' as const,
              text: treeLines.length > 0
                ? `Project files:\n\n${treeLines.join('\n')}`
                : 'No files in project yet.',
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

          // Return clean tree view
          return {
            content: [{
              type: 'text' as const,
              text: tree.length > 0
                ? `Project files:\n\n${tree.join('\n')}`
                : 'No files in project yet.',
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

        // Return the actual file content (agent will see this)
        // The frontend shows this in tool execution details
        return {
          content: [{
            type: 'text' as const,
            text: content,
          }],
        };
      } catch (error: any) {
        const fileName = params.file_path.split('/').pop() || params.file_path;
        return {
          content: [{
            type: 'text' as const,
            text: `✗ Failed to read ${fileName}: ${error.message}`,
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

        // Return user-friendly message
        const fileName = params.file_path.split('/').pop() || params.file_path;
        const size = Buffer.byteLength(params.content, 'utf-8');
        return {
          content: [{
            type: 'text' as const,
            text: `✓ Created ${fileName} (${size} bytes)`,
          }],
        };
      } catch (error: any) {
        const fileName = params.file_path.split('/').pop() || params.file_path;
        return {
          content: [{
            type: 'text' as const,
            text: `✗ Failed to create ${fileName}: ${error.message}`,
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

        const fileName = params.file_path.split('/').pop() || params.file_path;
        return {
          content: [{
            type: 'text' as const,
            text: `✓ Deleted ${fileName}`,
          }],
        };
      } catch (error: any) {
        const fileName = params.file_path.split('/').pop() || params.file_path;
        return {
          content: [{
            type: 'text' as const,
            text: `✗ Failed to delete ${fileName}: ${error.message}`,
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

      const dirName = params.directory_path.split('/').pop() || params.directory_path;
      return {
        content: [{
          type: 'text' as const,
          text: `✓ Created directory ${dirName}`,
        }],
      };
    } catch (error: any) {
      const dirName = params.directory_path.split('/').pop() || params.directory_path;
      return {
        content: [{
          type: 'text' as const,
          text: `✗ Failed to create directory ${dirName}: ${error.message}`,
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
    `Download binary files (images, PDFs, audio, video, etc.) from cloud storage to local filesystem. After downloading, use the Read tool with the returned path to view the file. PDFs up to 32 MB are supported by the Read tool.`,
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

        // Detect media type for user info
        const mediaType = lookup(params.file_path) || 'application/octet-stream';
        const sizeKB = (buffer.length / 1024).toFixed(2);
        const sizeMB = (buffer.length / 1024 / 1024).toFixed(2);

        // Check PDF size limit (Claude Code Read tool supports up to 32 MB)
        if (mediaType === 'application/pdf' && buffer.length > 32 * 1024 * 1024) {
          return {
            content: [{
              type: 'text' as const,
              text: `PDF file ${params.file_path} is ${sizeMB} MB, which exceeds the 32 MB limit for PDF viewing. Please use a smaller PDF or extract specific pages.`
            }]
          };
        }

        // For all binary files (including PDFs), write to local filesystem for Claude Code Read tool
        // MCP tools cannot return document blocks - only the Read tool supports them
        const localPath = path.join(projectPath, params.file_path);
        const localDir = path.dirname(localPath);

        // Ensure directory exists
        await fs.mkdir(localDir, { recursive: true });

        // Write the buffer to local file (explicit binary mode to preserve data integrity)
        await fs.writeFile(localPath, buffer, { encoding: null });

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
            text: `✓ Edited ${params.file_path.split('/').pop() || params.file_path}`,
          }],
        };
      } catch (error: any) {
        const fileName = params.file_path.split('/').pop() || params.file_path;
        return {
          content: [{
            type: 'text' as const,
            text: `✗ Failed to edit ${fileName}: ${error.message}`,
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
            text: matches.length > 0
              ? `Found "${params.query}" in ${matches.length} file(s):\n\n${matches.map(m => `• ${m}`).join('\n')}`
              : `No matches found for "${params.query}"`,
          }],
        };
      } catch (error: any) {
        return {
          content: [{
            type: 'text' as const,
            text: `✗ Search failed: ${error.message}`,
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
            text: `✓ Renamed ${params.old_path.split('/').pop()} → ${params.new_path.split('/').pop()}`,
          }],
        };
      } catch (error: any) {
        const oldName = params.old_path.split('/').pop() || params.old_path;
        return {
          content: [{
            type: 'text' as const,
            text: `✗ Failed to rename ${oldName}: ${error.message}`,
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
