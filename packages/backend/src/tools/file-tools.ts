import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
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

  return [
    listFiles,
    readFile,
    writeFile,
    deleteFile,
    createDirectory,
  ];
}
