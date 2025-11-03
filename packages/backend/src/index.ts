#!/usr/bin/env node

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { runSiteAgent } from './agent.js';
import { authenticateUser, type AuthenticatedRequest } from './middleware/auth.js';
import { getSandboxManager } from './sandbox/manager.js';
import { getUserProjectPath } from './sandbox/config.js';
import { getStorage, initializeStorage } from './storage/index.js';
import { applyTemplate, isValidTemplate, type TemplateId, getTemplateCategories } from './templates.js';
import { generateFilePrompt, isSupportedFileType } from './services/file-converter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

const app = express();
const PORT = process.env.PORT || 3001;

// Sandboxes directory (where user projects are stored in isolation)
// NOTE: This is only used for filesystem storage mode
const SANDBOXES_DIR = process.env.SANDBOXES_DIR || path.join(__dirname, '../sandboxes');

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true, // Allow cookies
}));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

/**
 * GET /api/templates
 * Get all template categories with metadata
 * Public endpoint (no auth required)
 */
app.get('/api/templates', (req, res) => {
  try {
    const categories = getTemplateCategories();
    res.json({ categories });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Public auth endpoints (defined before authentication middleware)
// (Optional) Auth endpoints were removed in favor of Cloudflare Access gating

// Apply authentication to all other API routes
app.use('/api', authenticateUser);

// Initialize storage (filesystem or R2)
await initializeStorage();

// Get storage instance
const storage = getStorage();

// Ensure sandboxes directory exists (for filesystem mode only)
if (process.env.STORAGE_TYPE !== 'r2') {
  await fs.mkdir(SANDBOXES_DIR, { recursive: true });
}

// Get sandbox manager instance
const sandboxManager = getSandboxManager();

// Configure multer for file uploads
// Use memory storage - files will be written to project via storage abstraction
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
});

/**
 * Helper function to get user-specific project path
 */
function getProjectPath(userId: string, projectId: string): string {
  return getUserProjectPath(userId, projectId);
}

/**
 * GET /api/projects
 * List all projects for the authenticated user
 */
app.get('/api/projects', async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user.id;

    const projectIds = await storage.listProjects(userId);

    // Get metadata for each project
    const projects = await Promise.all(
      projectIds.map(async (id) => {
        const metadata = await storage.getProjectMetadata(userId, id);
        return {
          id,
          name: metadata?.name || id,
          published: metadata?.published || false,
          publishedUrl: metadata?.publishedUrl,
          thumbnailUrl: metadata?.thumbnailUrl,
        };
      })
    );

    res.json({ projects });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/projects
 * Create a new project for the authenticated user
 */
app.post('/api/projects', async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user.id;
    const { name, template } = req.body;

    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'Project name is required' });
      return;
    }

    // Validate template if provided
    if (template && !isValidTemplate(template)) {
      res.status(400).json({ error: 'Invalid template ID' });
      return;
    }

    // Sanitize project name
    const sanitized = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    // Check if already exists
    if (await storage.projectExists(userId, sanitized)) {
      res.status(409).json({ error: 'Project already exists' });
      return;
    }

    // Create project
    await storage.createProject(userId, sanitized);

    // Apply template if provided
    if (template) {
      await applyTemplate(storage, userId, sanitized, template as TemplateId);
    } else {
      // No template - create default starter file
      const starterHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${name}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: system-ui, sans-serif;
            padding: 2rem;
            max-width: 800px;
            margin: 0 auto;
        }
        h1 { color: #2563eb; margin-bottom: 1rem; }
    </style>
</head>
<body>
    <h1>${name}</h1>
    <p>Welcome to your new project! Use the AI chat to build your site.</p>
</body>
</html>`;
      await storage.writeFile(userId, sanitized, 'index.html', starterHtml);
    }

    // Initial thumbnail will be generated client-side after first preview render

    res.json({
      id: sanitized,
      name: name,
      path: sanitized, // Return only project ID, not full path
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * PATCH /api/projects/:id
 * Rename a project for the authenticated user
 */
app.patch('/api/projects/:id', async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const { id } = req.params;
    const { name } = req.body;

    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'New project name is required' });
      return;
    }

    // Sanitize new project name
    const newId = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    // Check if old project exists
    if (!(await storage.projectExists(userId, id))) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    // Check if new name conflicts with existing project
    if (newId !== id) {
      if (await storage.projectExists(userId, newId)) {
        res.status(409).json({ error: 'A project with that name already exists' });
        return;
      }
    }

    // Rename the project
    if (newId !== id) {
      await storage.renameProject(userId, id, newId);
    }

    res.json({
      id: newId,
      name: name,
      message: 'Project renamed successfully',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/projects/:id
 * Delete a project for the authenticated user
 */
app.delete('/api/projects/:id', async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const { id } = req.params;

    // Check if project exists
    if (!(await storage.projectExists(userId, id))) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    // Delete the project
    await storage.deleteProject(userId, id);

    res.json({
      success: true,
      message: 'Project deleted successfully',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/projects/:id/publish
 * Publish a project to make it publicly accessible
 */
app.post('/api/projects/:id/publish', async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const { id } = req.params;

    // Check if project exists
    const exists = await storage.projectExists(userId, id);
    if (!exists) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Get current metadata
    const metadata = await storage.getProjectMetadata(userId, id);

    // Generate public URL
    // Format: https://site-studio-publisher.{subdomain}.workers.dev/{userId}/{projectId}/
    const workerSubdomain = process.env.WORKER_SUBDOMAIN || 'your-subdomain';
    const publicUrl = `https://site-studio-publisher.${workerSubdomain}.workers.dev/${userId}/${id}/`;

    // Update metadata
    await storage.updateProjectMetadata(userId, id, {
      published: true,
      publishedUrl: publicUrl,
      publishedAt: new Date().toISOString(),
    });

    res.json({
      success: true,
      message: 'Project published successfully',
      url: publicUrl,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/projects/:id/unpublish
 * Unpublish a project to make it private again
 */
app.post('/api/projects/:id/unpublish', async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const { id } = req.params;

    // Check if project exists
    const exists = await storage.projectExists(userId, id);
    if (!exists) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Update metadata
    await storage.updateProjectMetadata(userId, id, {
      published: false,
      publishedUrl: undefined,
      unpublishedAt: new Date().toISOString(),
    });

    res.json({
      success: true,
      message: 'Project unpublished successfully',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/projects/:id/thumbnail
 * Generate a thumbnail for the project
 */
// Accept a client-generated thumbnail image and store it
app.post('/api/projects/:id/thumbnail', upload.single('image'), async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const { id } = req.params;

    // Check if project exists
    const exists = await storage.projectExists(userId, id);
    if (!exists) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Expect a PNG image uploaded as field name "image"
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }
    const mime = req.file.mimetype || '';
    if (mime !== 'image/png') {
      return res.status(400).json({ error: 'Only image/png is supported' });
    }

    // Write thumbnail to project storage
    await storage.writeFile(userId, id, '.thumbnail.png', req.file.buffer);

    // Update metadata with thumbnail URL
    await storage.updateProjectMetadata(userId, id, {
      thumbnailUrl: `/api/projects/${id}/thumbnail`,
    });

    res.json({
      success: true,
      thumbnailUrl: `/api/projects/${id}/thumbnail`,
    });
  } catch (error: any) {
    console.error('Thumbnail upload error:', error);
    res.status(500).json({ error: 'Failed to save thumbnail' });
  }
});

/**
 * GET /api/projects/:id/thumbnail
 * Retrieve the thumbnail for a project
 */
app.get('/api/projects/:id/thumbnail', async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const { id } = req.params;

    // Check if project exists
    const exists = await storage.projectExists(userId, id);
    if (!exists) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Check if thumbnail exists
    const thumbnailExists = await storage.fileExists(userId, id, '.thumbnail.png');
    if (!thumbnailExists) {
      return res.status(404).json({ error: 'Thumbnail not found' });
    }

    // Read thumbnail
    const thumbnailBuffer = await storage.readFileBuffer(userId, id, '.thumbnail.png');

    // Send with appropriate headers
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(thumbnailBuffer);
  } catch (error: any) {
    console.error('Thumbnail retrieval error:', error);
    res.status(500).json({ error: 'Failed to retrieve thumbnail' });
  }
});

/**
 * GET /api/projects/:id/files
 * List files in a user's project
 */
app.get('/api/projects/:id/files', async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const { id } = req.params;

    // Get flat list of files from storage
    const flatFiles = await storage.listFiles(userId, id);

    // Filter out internal files (.thumbnail.png)
    const visibleFiles = flatFiles.filter(file => {
      const fileName = file.name || file.path.split('/').pop();
      return fileName !== '.thumbnail.png';
    });

    // Convert flat list to tree structure
    function buildTree(files: any[]): any[] {
      const tree: any = {};

      files.forEach(file => {
        const parts = file.path.split('/');
        let current = tree;

        parts.forEach((part: string, index: number) => {
          if (index === parts.length - 1) {
            // Leaf node (file)
            if (!current._files) current._files = [];
            current._files.push({
              name: file.name,
              path: file.path,
              type: 'file',
            });
          } else {
            // Directory node
            if (!current[part]) {
              current[part] = {};
            }
            current = current[part];
          }
        });
      });

      // Convert tree object to array format
      function treeToArray(obj: any, parentPath: string = ''): any[] {
        const result: any[] = [];

        // Add directories
        Object.keys(obj).forEach(key => {
          if (key !== '_files') {
            const dirPath = parentPath ? `${parentPath}/${key}` : key;
            result.push({
              name: key,
              path: dirPath,
              type: 'directory',
              children: treeToArray(obj[key], dirPath),
            });
          }
        });

        // Add files
        if (obj._files) {
          result.push(...obj._files);
        }

        return result;
      }

      return treeToArray(tree);
    }

    const files = buildTree(visibleFiles);

    res.json({ files });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/projects/:id/file?path=...
 * Read a file from a user's project
 */
app.get('/api/projects/:id/file', async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const { id } = req.params;
    let filePath = req.query.path as string;

    if (!filePath) {
      res.status(400).json({ error: 'File path is required' });
      return;
    }

    // Strip leading slashes
    filePath = filePath.replace(/^\/+/, '');

    // Security: basic path validation (prevent directory traversal)
    if (filePath.includes('..')) {
      res.status(403).json({ error: 'Invalid file path' });
      return;
    }

    const content = await storage.readFile(userId, id, filePath);

    res.json({
      path: filePath,
      content: content,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/projects/:id/file
 * Write/update a file in a user's project
 */
app.post('/api/projects/:id/file', async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const { id } = req.params;
    let { path: filePath, content } = req.body;

    if (!filePath || typeof filePath !== 'string') {
      res.status(400).json({ error: 'File path is required' });
      return;
    }

    if (content === undefined) {
      res.status(400).json({ error: 'File content is required' });
      return;
    }

    // Strip leading slashes
    filePath = filePath.replace(/^\/+/, '');

    // Security: basic path validation (prevent directory traversal)
    if (filePath.includes('..')) {
      res.status(403).json({ error: 'Invalid file path' });
      return;
    }

    // Write the file
    await storage.writeFile(userId, id, filePath, content);

    // Client will capture and upload a thumbnail after preview refresh

    res.json({
      success: true,
      path: filePath,
      message: 'File saved successfully',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/projects/:id/upload
 * Upload file(s) to a user's project
 */
app.post('/api/projects/:id/upload', upload.single('file'), async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user.id;
    const { id: projectId } = req.params;

    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    // Sanitize filename (preserve dots for extensions)
    const sanitized = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');

    // Find available filename (add (1), (2), etc. on conflict)
    let filename = sanitized;
    let counter = 1;

    // Check if file exists, if so try with (1), (2), etc.
    while (await storage.fileExists(userId, projectId, filename)) {
      const ext = path.extname(sanitized);
      const base = path.basename(sanitized, ext);
      filename = `${base} (${counter})${ext}`;
      counter++;
    }

    // Write file directly to project using storage abstraction
    // This works for both filesystem and R2 storage
    console.log(`[Upload] Uploading ${filename}, buffer type: ${typeof req.file.buffer}, isBuffer: ${Buffer.isBuffer(req.file.buffer)}, first bytes: ${req.file.buffer.slice(0, 4).toString('hex')}`);
    await storage.writeFile(userId, projectId, filename, req.file.buffer);

    res.json({
      success: true,
      filename: filename,
      path: filename,
      size: req.file.size,
      message: 'File uploaded successfully',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/projects/:id/download?path=...
 * Download a specific file from a user's project
 */
app.get('/api/projects/:id/download', async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const { id } = req.params;
    let filePath = req.query.path as string;

    if (!filePath) {
      res.status(400).json({ error: 'File path is required' });
      return;
    }

    // Strip leading slashes
    filePath = filePath.replace(/^\/+/, '');

    // Security: basic path validation (prevent directory traversal)
    if (filePath.includes('..')) {
      res.status(403).json({ error: 'Invalid file path' });
      return;
    }

    // Read file as buffer
    const buffer = await storage.readFileBuffer(userId, id, filePath);

    // Set headers for download
    const filename = path.basename(filePath);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', buffer.length.toString());

    // Send file
    res.send(buffer);
  } catch (error: any) {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * DELETE /api/projects/:id/files?path=...
 * Delete a specific file from a user's project
 */
app.delete('/api/projects/:id/files', async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const { id } = req.params;
    let filePath = req.query.path as string;

    if (!filePath) {
      res.status(400).json({ error: 'File path is required' });
      return;
    }

    // Strip leading slashes
    filePath = filePath.replace(/^\/+/, '');

    // Security: basic path validation (prevent directory traversal)
    if (filePath.includes('..')) {
      res.status(403).json({ error: 'Invalid file path' });
      return;
    }

    // Prevent deleting certain protected files
    if (filePath === '.thumbnail.png' || filePath === '.metadata.json') {
      res.status(403).json({ error: 'Cannot delete protected files' });
      return;
    }

    // Delete the file
    await storage.deleteFile(userId, id, filePath);

    res.json({
      success: true,
      message: 'File deleted successfully',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/projects/:id/files/rename
 * Rename a file in a user's project
 */
app.put('/api/projects/:id/files/rename', async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const { id } = req.params;
    let { oldPath, newPath } = req.body;

    if (!oldPath || !newPath) {
      res.status(400).json({ error: 'oldPath and newPath are required' });
      return;
    }

    // Strip leading slashes
    oldPath = oldPath.replace(/^\/+/, '');
    newPath = newPath.replace(/^\/+/, '');

    // Security: basic path validation (prevent directory traversal)
    if (oldPath.includes('..') || newPath.includes('..')) {
      res.status(403).json({ error: 'Invalid file path' });
      return;
    }

    // Prevent renaming certain protected files
    if (oldPath === '.thumbnail.png' || oldPath === '.metadata.json') {
      res.status(403).json({ error: 'Cannot rename protected files' });
      return;
    }

    // Check if old file exists
    if (!(await storage.fileExists(userId, id, oldPath))) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    // Check if new file path already exists
    if (await storage.fileExists(userId, id, newPath)) {
      res.status(409).json({ error: 'A file with that name already exists' });
      return;
    }

    // Read the old file
    const buffer = await storage.readFileBuffer(userId, id, oldPath);

    // Write to new location
    await storage.writeFile(userId, id, newPath, buffer);

    // Delete old file
    await storage.deleteFile(userId, id, oldPath);

    res.json({
      success: true,
      oldPath,
      newPath,
      message: 'File renamed successfully',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/query
 * Stream agent responses via SSE
 * Supports 'plan' mode (shows proposed actions) or 'execute' mode (runs without asking)
 */
app.post('/api/query', async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user.id;
    const { prompt, projectId, sessionId, mode, uploadedFile } = req.body;

    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({ error: 'Prompt is required' });
      return;
    }

    if (!projectId || typeof projectId !== 'string') {
      res.status(400).json({ error: 'Project ID is required' });
      return;
    }

    // Get or create sandboxed session
    const session = await sandboxManager.getOrCreateSession(userId, projectId, sessionId);
    const projectPath = session.projectPath;

    // Ensure project directory exists
    await fs.mkdir(projectPath, { recursive: true });

    // Handle uploaded file if present - pass path to agent
    let enhancedPrompt = prompt;

    if (uploadedFile) {
      // File is now stored directly in the project directory
      try {
        // Check if file type is supported
        if (!isSupportedFileType(uploadedFile)) {
          throw new Error('Unsupported file type');
        }

        // Generate prompt with filename (agent needs relative path, not absolute)
        enhancedPrompt = generateFilePrompt(prompt, uploadedFile, uploadedFile);
      } catch (error: any) {
        console.error('Error processing uploaded file:', error);
        // Return error to user
        res.status(400).json({ error: error.message });
        return;
      }
    }

    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    // Run agent with sandboxed session (mode: 'plan' or 'execute')
    // Only pass sessionId for resume if client explicitly provided one
    const stream = await runSiteAgent(
      enhancedPrompt,
      projectPath,
      sessionId, // Use the sessionId from request body, not the generated one
      mode || 'plan',
      session, // Pass sandbox session context
      userId, // Pass userId for storage abstraction
      projectId // Pass projectId for storage abstraction
    );

    // Stream events to client
    for await (const event of stream) {
      const data = JSON.stringify(event);
      res.write(`data: ${data}\n\n`);

      if (typeof (res as any).flush === 'function') {
        (res as any).flush();
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error: any) {
    console.error('Query error:', error);

    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.end();
    }
  }
});

/**
 * POST /api/query/approve
 * Approve and execute a proposed plan
 */
app.post('/api/query/approve', async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user.id;
    const { projectId, sessionId, approved } = req.body;

    if (!projectId || typeof projectId !== 'string') {
      res.status(400).json({ error: 'Project ID is required' });
      return;
    }

    if (!sessionId || typeof sessionId !== 'string') {
      res.status(400).json({ error: 'Session ID is required' });
      return;
    }

    // Get existing sandboxed session
    const session = await sandboxManager.getOrCreateSession(userId, projectId, sessionId);
    const projectPath = session.projectPath;

    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    // Resume session with approval/rejection
    const resumePrompt = approved ? 'Yes, proceed with the plan.' : 'No, please don\'t proceed.';
    const stream = await runSiteAgent(
      resumePrompt,
      projectPath,
      sessionId,
      'execute',
      session, // Pass sandbox session context
      userId, // Pass userId for storage abstraction
      projectId // Pass projectId for storage abstraction
    );

    // Stream execution results
    for await (const event of stream) {
      const data = JSON.stringify(event);
      res.write(`data: ${data}\n\n`);

      if (typeof (res as any).flush === 'function') {
        (res as any).flush();
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error: any) {
    console.error('Approval error:', error);

    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.end();
    }
  }
});

/**
 * Serve project files for preview
 * Only serves files from the authenticated user's project
 * Supports internal auth for thumbnail generation
 */
app.use('/preview/:id', (req, res, next) => {
  // Check for internal auth header (for thumbnail generation)
  const internalAuthToken = req.headers['x-internal-auth'] as string;
  const internalUserId = req.headers['x-user-id'] as string;
  const expectedToken = process.env.INTERNAL_AUTH_TOKEN || 'internal-secret-token';

  if (internalAuthToken === expectedToken && internalUserId) {
    // Internal request from thumbnail service
    (req as any).user = { id: internalUserId };
    next();
  } else {
    // Regular user request - require authentication
    authenticateUser(req, res, next);
  }
}, async (req, res, next) => {
  const authReq = req as unknown as AuthenticatedRequest;
  const projectId = req.params.id;

  if (process.env.STORAGE_TYPE === 'r2') {
    // For R2, serve files manually
    try {
      // Find the project owner
      const ownerId = await storage.findProjectOwner(projectId);
      if (!ownerId) {
        res.status(404).send('Project not found');
        return;
      }

      let filePath = req.path.slice(1); // Remove leading slash

      // Default to index.html for directory requests
      if (!filePath || filePath.endsWith('/')) {
        filePath = filePath + 'index.html';
      }

      // Security: prevent directory traversal
      if (filePath.includes('..')) {
        res.status(403).send('Forbidden');
        return;
      }

      const buffer = await storage.readFileBuffer(ownerId, projectId, filePath);

      // Set content type based on file extension
      const ext = path.extname(filePath).toLowerCase();
      const contentTypes: Record<string, string> = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
      };

      const contentType = contentTypes[ext] || 'application/octet-stream';

      res.setHeader('Content-Type', contentType);
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.send(buffer);
    } catch (error: any) {
      if (error.message.includes('not found')) {
        res.status(404).send('Not Found');
      } else {
        res.status(500).send('Internal Server Error');
      }
    }
  } else {
    // For filesystem, use express.static
    // Find the project owner
    const ownerId = await storage.findProjectOwner(projectId);
    if (!ownerId) {
      res.status(404).send('Project not found');
      return;
    }

    const projectPath = getProjectPath(ownerId, projectId);
    express.static(projectPath, {
      setHeaders: (res) => {
        // Allow preview iframe to load
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      },
    })(req, res, next);
  }
});

// Start server
// Serve frontend build (static) if present
try {
  // Path works for both dev and production since directory structure is the same
  // __dirname = /app/packages/backend/dist (prod) or <repo>/packages/backend/dist (dev)
  // ../../frontend/build resolves to /app/packages/frontend/build (prod) or <repo>/packages/frontend/build (dev)
  const FRONTEND_BUILD_DIR = path.join(__dirname, '../../frontend/build');
  await fs.access(FRONTEND_BUILD_DIR);

  // Static assets
  app.use(express.static(FRONTEND_BUILD_DIR, {
    setHeaders: (res, filePath) => {
      // Cache assets more aggressively; HTML gets default
      if (/\.(css|js|png|jpg|jpeg|gif|svg|woff2?|ttf|eot)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=600');
      }
    },
  }));

  // SPA fallback (avoid capturing API and preview routes)
  // Express 5 requires named wildcards, so we use /*splat
  app.get('/*splat', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/preview')) return next();
    res.sendFile(path.join(FRONTEND_BUILD_DIR, 'index.html'));
  });
  console.log('🪄 Serving frontend from', FRONTEND_BUILD_DIR);
} catch (e) {
  console.log('ℹ️ Frontend build not found; API-only mode');
}

app.listen(PORT as number, '0.0.0.0', () => {
  console.log(`🎨 Site Studio backend running on http://localhost:${PORT}`);
  console.log(`🔒 Sandboxed projects directory: ${SANDBOXES_DIR}`);
  console.log(`🛡️  Multi-user isolation enabled`);
});
