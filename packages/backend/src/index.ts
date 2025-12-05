#!/usr/bin/env node

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { runSiteAgent, type ToolApprovalRequest } from './agent.js';
import { authenticateUser, type AuthenticatedRequest } from './middleware/auth.js';
import { errorHandler, ApiError, asyncHandler } from './middleware/error-handler.js';
import { getSandboxManager } from './sandbox/manager.js';
import { getUserProjectPath } from './sandbox/config.js';
import { getStorage, initializeStorage } from './storage/index.js';
import { applyTemplate, isValidTemplate, type TemplateId, getTemplateCategories } from './templates.js';
import { generateFilePrompt, isSupportedFileType, getFileTypeDescription } from './services/file-converter.js';
import { validateEnvironment } from './config/env-validation.js';
import { apiLimiter, agentLimiter, uploadLimiter } from './middleware/rate-limit.js';
import { healthCheck, readinessCheck } from './routes/health.js';
import {
  validateBody,
  createProjectSchema,
  renameProjectSchema,
  saveFileSchema,
  renameFileSchema,
  revertFileSchema,
  querySchema
} from './middleware/validation.js';
import { logger, getLogger, requestLogger } from './config/logger.js';
import { fileUploadValidator } from './middleware/file-validation.js';

const log = getLogger('app');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

// Validate environment configuration at startup
validateEnvironment();

const app = express();
const PORT = process.env.PORT || 3001;

// Sandboxes directory (where user projects are stored in isolation)
// NOTE: This is only used for filesystem storage mode
const SANDBOXES_DIR = process.env.SANDBOXES_DIR || path.join(__dirname, '../sandboxes');

// Store pending tool approval requests
// Key: requestId, Value: resolve function to call when approved/denied
const pendingToolApprovals = new Map<string, ToolApprovalRequest>();
// Store timeouts for pending approvals (auto-deny after timeout)
const approvalTimeouts = new Map<string, NodeJS.Timeout>();
// Approval timeout: 5 minutes
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Convert a string to a URL-friendly slug
 * Examples: "My Portfolio" → "my-portfolio", "Research 2025!" → "research-2025"
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '') // Remove special characters
    .replace(/[\s_-]+/g, '-') // Replace spaces, underscores with single hyphen
    .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
}

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true, // Allow cookies
}));
app.use(express.json({ limit: '50mb' })); // Increased for PDF attachments in chat
app.use(cookieParser());

// Health check endpoints (no auth or rate limiting required)
app.get('/health', healthCheck);
app.get('/health/ready', readinessCheck);

/**
 * GET /api/templates
 * Get all template categories with metadata
 * Public endpoint (no auth required)
 */
app.get('/api/templates', (req, res, next) => {
  try {
    const categories = getTemplateCategories();
    res.json({ categories });
  } catch (error) {
    next(error);
  }
});

// Public auth endpoints (defined before authentication middleware)
// (Optional) Auth endpoints were removed in favor of Cloudflare Access gating

// Apply rate limiting to API routes
app.use('/api', apiLimiter);

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
    fileSize: 32 * 1024 * 1024, // 32MB limit (matches PDF viewing limit)
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
app.get('/api/projects', async (req, res, next) => {
  try {
    const authReq = req as unknown as AuthenticatedRequest;
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
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/projects
 * Create a new project for the authenticated user
 */
app.post('/api/projects', validateBody(createProjectSchema), async (req, res, next) => {
  try {
    const authReq = req as unknown as AuthenticatedRequest;
    const userId = authReq.user.id;
    const { name, template } = req.body;

    // Validate template if provided (Zod already validated name)
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
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/projects/:id
 * Rename a project for the authenticated user
 */
app.patch('/api/projects/:id', validateBody(renameProjectSchema), async (req, res, next) => {
  try {
    const authReq = req as unknown as AuthenticatedRequest;
    const userId = authReq.user.id;
    const { id } = req.params;
    const { name } = req.body;

    // Sanitize new project name (Zod already validated name)
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
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/projects/:id/export
 * Export a project as a ZIP file
 */
app.get('/api/projects/:id/export', async (req, res, next) => {
  try {
    const authReq = req as unknown as AuthenticatedRequest;
    const userId = authReq.user.id;
    const { id } = req.params;

    // Check if project exists
    if (!(await storage.projectExists(userId, id))) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    log.info({ userId, projectId: id }, 'Exporting project as ZIP');

    // Generate ZIP buffer
    const zipBuffer = await storage.exportProject(userId, id);

    // Send ZIP file
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${id}.zip"`);
    res.setHeader('Content-Length', zipBuffer.length.toString());
    res.send(zipBuffer);
  } catch (error) {
    log.error({ error }, 'Failed to export project');
    next(error);
  }
});

/**
 * DELETE /api/projects/:id
 * Delete a project for the authenticated user
 */
app.delete('/api/projects/:id', async (req, res, next) => {
  try {
    const authReq = req as unknown as AuthenticatedRequest;
    const userId = authReq.user.id;
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
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/projects/:id/publish
 * Publish a project to make it publicly accessible
 */
app.post('/api/projects/:id/publish', async (req, res, next) => {
  try {
    const authReq = req as unknown as AuthenticatedRequest;
    const userId = authReq.user.id;
    const { id } = req.params;

    // Check if project exists
    const exists = await storage.projectExists(userId, id);
    if (!exists) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Get current metadata
    const metadata = await storage.getProjectMetadata(userId, id);
    if (!metadata) {
      return res.status(404).json({ error: 'Project metadata not found' });
    }

    // Generate or reuse slug
    const slug = metadata.slug || slugify(metadata.name || id);

    // Get public domain from env or construct from request
    const publicDomain = process.env.R2_PUBLIC_DOMAIN ||
      `${req.protocol}://${req.get('host')}`;

    // Generate public URL
    // Format: https://tools.cuny.qzz.io/sites/{userId}/{slug}/
    const publicUrl = `${publicDomain}/sites/${userId}/${slug}/`;

    // Update metadata
    await storage.updateProjectMetadata(userId, id, {
      published: true,
      publishedUrl: publicUrl,
      publishedAt: new Date().toISOString(),
      slug, // Store slug for future use
    });

    res.json({
      success: true,
      message: 'Project published successfully',
      url: publicUrl,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/projects/:id/unpublish
 * Unpublish a project to make it private again
 */
app.post('/api/projects/:id/unpublish', async (req, res, next) => {
  try {
    const authReq = req as unknown as AuthenticatedRequest;
    const userId = authReq.user.id;
    const { id } = req.params;

    // Check if project exists
    const exists = await storage.projectExists(userId, id);
    if (!exists) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Get current metadata to check if already published
    const metadata = await storage.getProjectMetadata(userId, id);
    if (!metadata?.published) {
      return res.status(400).json({ error: 'Project is not currently published' });
    }

    // Update metadata to unpublish
    // Note: Files remain in storage; access is prevented by checking published flag in /sites/ route
    await storage.updateProjectMetadata(userId, id, {
      published: false,
      publishedUrl: undefined,
      unpublishedAt: new Date().toISOString(),
    });

    log.info({ projectId: id, userId }, 'Project unpublished');

    res.json({
      success: true,
      message: 'Project unpublished successfully',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/projects/:id/thumbnail
 * Generate a thumbnail for the project
 */
// Accept a client-generated thumbnail image and store it
app.post('/api/projects/:id/thumbnail', upload.single('image'), async (req, res, next) => {
  try {
    const authReq = req as unknown as AuthenticatedRequest;
    const userId = authReq.user.id;
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
  } catch (error) {
    log.error({ error }, 'Thumbnail upload failed');
    res.status(500).json({ error: 'Failed to save thumbnail' });
  }
});

/**
 * GET /api/projects/:id/thumbnail
 * Retrieve the thumbnail for a project
 */
app.get('/api/projects/:id/thumbnail', async (req, res, next) => {
  try {
    const authReq = req as unknown as AuthenticatedRequest;
    const userId = authReq.user.id;
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
  } catch (error) {
    log.error({ error }, 'Thumbnail retrieval failed');
    res.status(500).json({ error: 'Failed to retrieve thumbnail' });
  }
});

/**
 * GET /api/projects/:id/files
 * List files in a user's project
 */
app.get('/api/projects/:id/files', async (req, res, next) => {
  try {
    const authReq = req as unknown as AuthenticatedRequest;
    const userId = authReq.user.id;
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
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/projects/:id/file?path=...
 * Read a file from a user's project
 */
app.get('/api/projects/:id/file', async (req, res, next) => {
  try {
    const authReq = req as unknown as AuthenticatedRequest;
    const userId = authReq.user.id;
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
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/projects/:id/file
 * Write/update a file in a user's project
 */
app.post('/api/projects/:id/file', validateBody(saveFileSchema), async (req, res, next) => {
  try {
    const authReq = req as unknown as AuthenticatedRequest;
    const userId = authReq.user.id;
    const { id } = req.params;
    let { path: filePath, content } = req.body;

    // Strip leading slashes (Zod already validated path and content)
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
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/projects/:id/revert
 * Revert a file to its previous state
 */
app.post('/api/projects/:id/revert', validateBody(revertFileSchema), async (req, res, next) => {
  try {
    const authReq = req as unknown as AuthenticatedRequest;
    const userId = authReq.user.id;
    const { id } = req.params;
    let { file_path, content } = req.body;

    // Strip leading slashes
    file_path = file_path.replace(/^\/+/, '');

    // Security: basic path validation (prevent directory traversal)
    if (file_path.includes('..')) {
      res.status(403).json({ error: 'Invalid file path' });
      return;
    }

    // If content is null or undefined, delete the file (reverting a create)
    if (content == null) {
      await storage.deleteFile(userId, id, file_path);
      res.json({
        success: true,
        path: file_path,
        message: 'File deleted (reverted creation)',
      });
      return;
    }

    // Otherwise, restore the file content
    await storage.writeFile(userId, id, file_path, content);

    res.json({
      success: true,
      path: file_path,
      message: 'File reverted successfully',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/projects/:id/upload
 * Upload file(s) to a user's project
 */
app.post('/api/projects/:id/upload', uploadLimiter, upload.single('file'), fileUploadValidator(), async (req, res, next) => {
  try {
    const authReq = req as unknown as AuthenticatedRequest;
    const userId = authReq.user.id;
    const { id: projectId } = req.params;

    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    // Sanitize filename (preserve dots for extensions)
    const sanitized = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');

    // Find available filename (add _1, _2, etc. on conflict)
    let filename = sanitized;
    let counter = 1;

    // Check if file exists, if so try with _1, _2, etc.
    while (await storage.fileExists(userId, projectId, filename)) {
      const ext = path.extname(sanitized);
      const base = path.basename(sanitized, ext);
      filename = `${base}_${counter}${ext}`;
      counter++;
    }

    // Write file directly to project using storage abstraction
    // This works for both filesystem and R2 storage
    await storage.writeFile(userId, projectId, filename, req.file.buffer);

    res.json({
      success: true,
      filename: filename,
      path: filename,
      size: req.file.size,
      message: 'File uploaded successfully',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/projects/:id/download?path=...
 * Download a specific file from a user's project
 */
app.get('/api/projects/:id/download', async (req, res, next) => {
  try {
    const authReq = req as unknown as AuthenticatedRequest;
    const userId = authReq.user.id;
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
  } catch (error) {
    if (!res.headersSent) {
      next(error);
    }
  }
});

/**
 * DELETE /api/projects/:id/files?path=...
 * Delete a specific file from a user's project
 */
app.delete('/api/projects/:id/files', async (req, res, next) => {
  try {
    const authReq = req as unknown as AuthenticatedRequest;
    const userId = authReq.user.id;
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
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/projects/:id/files/rename
 * Rename a file in a user's project
 */
app.put('/api/projects/:id/files/rename', validateBody(renameFileSchema), async (req, res, next) => {
  try {
    const authReq = req as unknown as AuthenticatedRequest;
    const userId = authReq.user.id;
    const { id } = req.params;
    let { oldPath, newPath } = req.body;

    // Strip leading slashes (Zod already validated oldPath and newPath)
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
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/query
 * Stream agent responses via SSE
 * Supports 'plan' mode (shows proposed actions) or 'execute' mode (runs without asking)
 */
app.post('/api/query', agentLimiter, validateBody(querySchema), async (req, res, next) => {
  const startTime = Date.now();
  let agentSessionId: string | undefined;
  let eventCount = 0;

  try {
    const authReq = req as unknown as AuthenticatedRequest;
    const userId = authReq.user.id;
    const { prompt, projectId, sessionId, mode, uploadedFile } = req.body;

    // Log query start with full context
    log.info({
      userId,
      projectId,
      sessionId: sessionId || 'NEW',
      mode: mode || 'plan',
      hasUploadedFile: !!uploadedFile,
      promptLength: prompt.length,
      promptPreview: prompt.substring(0, 100),
    }, 'Agent query started');

    // Get or create sandboxed session (Zod already validated prompt and projectId)
    const session = await sandboxManager.getOrCreateSession(userId, projectId, sessionId);
    const projectPath = session.projectPath;

    log.info({
      sessionId: session.sessionId,
      projectPath,
      isNewSession: !sessionId,
    }, 'Sandbox session ready');

    // Ensure project directory exists
    await fs.mkdir(projectPath, { recursive: true });

    // Handle uploaded file if present - tell agent to use view_file tool
    let enhancedPrompt = prompt;

    if (uploadedFile) {
      try {
        // Check if file type is supported
        if (!isSupportedFileType(uploadedFile)) {
          throw new Error('Unsupported file type');
        }

        // Don't pre-write the file - let the agent use view_file tool to download it
        // This matches the working flow when files have been in R2 for a while
        const fileType = getFileTypeDescription(uploadedFile);

        log.info({
          fileType,
          fileName: uploadedFile,
          userId,
          projectId
        }, 'File upload ready for agent');

        enhancedPrompt = `${prompt}\n\n[SYSTEM: User uploaded a ${fileType}: ${uploadedFile}]

The file is stored in R2 cloud storage. Please use the view_file tool with filename "${uploadedFile}" to download and analyze it.`;

      } catch (error) {
        log.error({
          error,
          uploadedFile,
          userId,
          projectId
        }, 'Failed to prepare uploaded file');
        next(error);
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

    log.info({ userId, projectId, sessionId }, 'SSE connection established');

    // Track pending approval IDs for this request (for cleanup on disconnect)
    const sessionApprovalIds: string[] = [];

    // Create tool approval callback for plan mode
    // When the agent wants to use a write/edit tool, this sends an event to the frontend
    const toolApprovalCallback = (request: ToolApprovalRequest) => {
      // Store the pending approval
      pendingToolApprovals.set(request.id, request);
      sessionApprovalIds.push(request.id);

      // Set timeout to auto-deny after 5 minutes (prevents memory leaks)
      const timeout = setTimeout(() => {
        const pendingRequest = pendingToolApprovals.get(request.id);
        if (pendingRequest) {
          log.warn({
            userId,
            projectId,
            requestId: request.id,
            toolName: request.toolName,
          }, 'Tool approval timed out, auto-denying');
          pendingToolApprovals.delete(request.id);
          approvalTimeouts.delete(request.id);
          pendingRequest.resolve(false);
        }
      }, APPROVAL_TIMEOUT_MS);
      approvalTimeouts.set(request.id, timeout);

      log.info({
        userId,
        projectId,
        requestId: request.id,
        toolName: request.toolName,
      }, 'Tool approval request created');

      // Send event to frontend
      const approvalEvent = {
        type: 'tool_approval_request',
        request_id: request.id,
        tool_name: request.toolName,
        input: request.input,
      };
      res.write(`data: ${JSON.stringify(approvalEvent)}\n\n`);
      if (typeof (res as any).flush === 'function') {
        (res as any).flush();
      }
    };

    // Run agent with sandboxed session (mode: 'plan' or 'execute')
    // Only pass sessionId for resume if client explicitly provided one
    const stream = await runSiteAgent(
      enhancedPrompt,
      projectPath,
      sessionId, // Use the sessionId from request body, not the generated one
      mode || 'plan',
      session, // Pass sandbox session context
      userId, // Pass userId for storage abstraction
      projectId, // Pass projectId for storage abstraction
      mode === 'plan' ? toolApprovalCallback : undefined // Pass callback for plan mode
    );

    log.info({
      userId,
      projectId,
      sessionId,
      mode: mode || 'plan'
    }, 'Agent stream started');

    // Track connection state
    let connectionClosed = false;
    req.on('close', () => {
      connectionClosed = true;

      // Clean up any pending approvals for this session
      for (const requestId of sessionApprovalIds) {
        const pendingRequest = pendingToolApprovals.get(requestId);
        if (pendingRequest) {
          log.info({ requestId, toolName: pendingRequest.toolName }, 'Cleaning up pending approval on disconnect');
          pendingToolApprovals.delete(requestId);
          const timeout = approvalTimeouts.get(requestId);
          if (timeout) {
            clearTimeout(timeout);
            approvalTimeouts.delete(requestId);
          }
          pendingRequest.resolve(false); // Deny on disconnect
        }
      }

      log.warn({
        userId,
        projectId,
        sessionId: agentSessionId || sessionId,
        eventCount,
        duration: Date.now() - startTime,
      }, 'Client disconnected before stream completed');
    });

    // Stream events to client
    for await (const event of stream) {
      if (connectionClosed) {
        log.warn({
          userId,
          projectId,
          sessionId: agentSessionId || sessionId,
          eventCount,
        }, 'Breaking stream loop - connection closed');
        break;
      }

      eventCount++;

      // Capture session ID from init event
      if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
        agentSessionId = event.session_id;
        log.info({
          userId,
          projectId,
          agentSessionId,
          isResume: !!sessionId,
        }, 'Agent session initialized');
      }

      // Log important events
      if (event.type === 'permission_request') {
        log.info({
          userId,
          projectId,
          sessionId: agentSessionId || sessionId,
          toolCallCount: event.tool_calls?.length || 0,
        }, 'Agent requesting permission for tool calls');
      } else if (event.type === 'error') {
        log.error({
          userId,
          projectId,
          sessionId: agentSessionId || sessionId,
          error: event.error,
        }, 'Agent returned error event');
      } else if (event.type === 'tool_progress') {
        log.debug({
          toolName: (event as any).tool_name,
          elapsedSeconds: (event as any).elapsed_time_seconds,
        }, 'Tool progress');
      }

      const data = JSON.stringify(event);
      res.write(`data: ${data}\n\n`);

      if (typeof (res as any).flush === 'function') {
        (res as any).flush();
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();

    log.info({
      userId,
      projectId,
      sessionId: agentSessionId || sessionId,
      eventCount,
      duration: Date.now() - startTime,
    }, 'Agent query completed successfully');
  } catch (error) {
    log.error({
      error,
      userId: (req as any).user?.id,
      projectId: req.body?.projectId,
      sessionId: agentSessionId || req.body?.sessionId,
      eventCount,
      duration: Date.now() - startTime,
      stack: error instanceof Error ? error.stack : undefined,
    }, 'Agent query failed');

    const errorMessage = error instanceof Error ? error.message : 'An error occurred';

    if (!res.headersSent) {
      next(error);
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', error: errorMessage })}\n\n`);
      res.end();
    }
  }
});

/**
 * POST /api/query/tool-approve
 * Approve or deny a specific tool operation in plan mode
 */
app.post('/api/query/tool-approve', authenticateUser, async (req, res, next) => {
  try {
    const authReq = req as unknown as AuthenticatedRequest;
    const userId = authReq.user.id;
    const { requestId, approved } = req.body;

    if (!requestId || typeof requestId !== 'string') {
      res.status(400).json({ error: 'Request ID is required' });
      return;
    }

    if (typeof approved !== 'boolean') {
      res.status(400).json({ error: 'Approved must be a boolean' });
      return;
    }

    // Find and resolve the pending approval
    const pendingRequest = pendingToolApprovals.get(requestId);
    if (!pendingRequest) {
      log.warn({
        userId,
        requestId,
      }, 'Tool approval request not found');
      res.status(404).json({ error: 'Approval request not found or expired' });
      return;
    }

    // Remove from pending, clear timeout, and resolve
    pendingToolApprovals.delete(requestId);
    const timeout = approvalTimeouts.get(requestId);
    if (timeout) {
      clearTimeout(timeout);
      approvalTimeouts.delete(requestId);
    }
    pendingRequest.resolve(approved);

    log.info({
      userId,
      requestId,
      toolName: pendingRequest.toolName,
      approved,
    }, 'Tool approval resolved');

    res.json({ success: true, approved });
  } catch (error) {
    log.error({ error }, 'Tool approval failed');
    next(error);
  }
});

/**
 * Add cache-busting version parameters to local asset references in HTML
 */
function addCacheBusterToHTML(html: string, version?: string): string {
  const v = version || Date.now().toString();

  // Replace local CSS references: href="styles.css" -> href="styles.css?v=123"
  html = html.replace(
    /(<link[^>]*href=["'])(?!https?:\/\/)([^"'?]+)(["'][^>]*>)/gi,
    `$1$2?v=${v}$3`
  );

  // Replace local JS references: src="script.js" -> src="script.js?v=123"
  html = html.replace(
    /(<script[^>]*src=["'])(?!https?:\/\/)([^"'?]+)(["'][^>]*>)/gi,
    `$1$2?v=${v}$3`
  );

  // Replace local image references: src="image.png" -> src="image.png?v=123"
  html = html.replace(
    /(<img[^>]*src=["'])(?!https?:\/\/)([^"'?]+)(["'][^>]*>)/gi,
    `$1$2?v=${v}$3`
  );

  return html;
}

/**
 * Serve project files for preview
 * Only serves files from the authenticated user's project
 * Supports internal auth for thumbnail generation
 */
app.use('/preview/:id', (req, res, next) => {
  // Check for internal auth header (for thumbnail generation)
  const internalAuthToken = req.headers['x-internal-auth'] as string;
  const internalUserId = req.headers['x-user-id'] as string;
  const expectedToken = process.env.INTERNAL_AUTH_TOKEN;

  if (expectedToken && internalAuthToken === expectedToken && internalUserId) {
    // Internal request from thumbnail service
    (req as unknown as AuthenticatedRequest).user = {
      id: internalUserId,
      createdAt: new Date()
    };
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
    let filePath = ''; // Declare outside try block for error logging
    try {
      // Check if the authenticated user owns this project
      const userId = authReq.user.id;
      if (!(await storage.projectExists(userId, projectId))) {
        res.status(404).send('Project not found');
        return;
      }

      filePath = req.path.slice(1); // Remove leading slash

      // Default to index.html for directory requests
      if (!filePath || filePath.endsWith('/')) {
        filePath = filePath + 'index.html';
      }

      // Security: prevent directory traversal
      if (filePath.includes('..')) {
        res.status(403).send('Forbidden');
        return;
      }

      let buffer = await storage.readFileBuffer(userId, projectId, filePath);

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
        '.webp': 'image/webp',
        '.avif': 'image/avif',
        '.ico': 'image/x-icon',
        '.pdf': 'application/pdf',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.ttf': 'font/ttf',
        '.eot': 'application/vnd.ms-fontobject',
        '.otf': 'font/otf',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
      };

      const contentType = contentTypes[ext] || 'application/octet-stream';

      // Add charset=utf-8 for text-based content types
      const isTextType = contentType.startsWith('text/') || contentType.includes('javascript') || contentType.includes('json');
      res.setHeader('Content-Type', isTextType ? `${contentType}; charset=utf-8` : contentType);
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      // Allow caching but revalidate to ensure preview shows latest changes
      // This enables browser caching of external CDN libraries while keeping local content fresh
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Pragma', 'no-cache');
      // Keep ETag for efficient revalidation (304 Not Modified responses)

      // If HTML file, add cache-busting to asset references
      if (ext === '.html') {
        const version = req.query.v as string;
        const htmlContent = buffer.toString('utf-8');
        const rewrittenHTML = addCacheBusterToHTML(htmlContent, version);
        buffer = Buffer.from(rewrittenHTML, 'utf-8');
      }

      res.send(buffer);
    } catch (error) {
      log.error({ projectId, filePath, error }, 'Preview error');
      if (error instanceof Error && error.message.includes('not found')) {
        res.status(404).send('Not Found');
      } else {
        res.status(500).send('Internal Server Error');
      }
    }
  } else {
    // For filesystem, manually serve files with HTML rewriting
    const userId = authReq.user.id;
    if (!(await storage.projectExists(userId, projectId))) {
      res.status(404).send('Project not found');
      return;
    }

    const projectPath = getProjectPath(userId, projectId);
    let filePath = req.path.slice(1); // Remove leading slash

    // Default to index.html for directory requests
    if (!filePath || filePath.endsWith('/')) {
      filePath = path.join(filePath, 'index.html');
    }

    // Security: prevent directory traversal
    if (filePath.includes('..')) {
      res.status(403).send('Forbidden');
      return;
    }

    const fullPath = path.join(projectPath, filePath);

    try {
      const buffer = await fs.readFile(fullPath);
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
      const isTextType = contentType.startsWith('text/') || contentType.includes('javascript') || contentType.includes('json');

      res.setHeader('Content-Type', isTextType ? `${contentType}; charset=utf-8` : contentType);
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      // Allow caching but revalidate to ensure preview shows latest changes
      // This enables browser caching of external CDN libraries while keeping local content fresh
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Pragma', 'no-cache');
      // Keep ETag for efficient revalidation (304 Not Modified responses)

      let responseBuffer = buffer;

      // If HTML file, add cache-busting to asset references
      if (ext === '.html') {
        const version = req.query.v as string;
        const htmlContent = buffer.toString('utf-8');
        const rewrittenHTML = addCacheBusterToHTML(htmlContent, version);
        responseBuffer = Buffer.from(rewrittenHTML, 'utf-8');
      }

      res.send(responseBuffer);
    } catch (error) {
      log.error({ projectId, filePath, error }, 'Preview error');
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        res.status(404).send('Not Found');
      } else {
        res.status(500).send('Internal Server Error');
      }
    }
  }
});

/**
 * GET /sites/:userId/:slug{/*splat}
 * Serve published project sites
 */
app.get('/sites/:userId/:slug{/*splat}', async (req, res, next) => {
  try {
    const { userId, slug } = req.params;
    // Express may return splat as an array or string, ensure it's a string
    const splatParam = (req.params as any)['splat'];
    const filePath = Array.isArray(splatParam)
      ? splatParam.join('/')
      : (splatParam || 'index.html');

    // Find all projects for this user
    const projects = await storage.listProjects(userId);

    // Find the project with matching slug
    let projectId: string | null = null;
    for (const pid of projects) {
      const metadata = await storage.getProjectMetadata(userId, pid);
      if (metadata?.slug === slug && metadata?.published) {
        projectId = pid;
        break;
      }
    }

    if (!projectId) {
      return res.status(404).send('Published site not found');
    }

    // Serve the file from storage
    const fileExists = await storage.fileExists(userId, projectId, filePath);
    if (!fileExists) {
      // Try index.html for directory requests
      if (!filePath.endsWith('.html')) {
        const indexPath = filePath === 'index.html' ? 'index.html' : `${filePath}/index.html`;
        const indexExists = await storage.fileExists(userId, projectId, indexPath);
        if (indexExists) {
          const content = await storage.readFile(userId, projectId, indexPath);
          res.setHeader('Content-Type', 'text/html');
          return res.send(content);
        }
      }
      return res.status(404).send('Not found');
    }

    // Read and serve the file
    const content = await storage.readFileBuffer(userId, projectId, filePath);

    // Set appropriate content type
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
      '.webp': 'image/webp',
      '.avif': 'image/avif',
      '.ico': 'image/x-icon',
      '.pdf': 'application/pdf',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
      '.eot': 'application/vnd.ms-fontobject',
      '.otf': 'font/otf',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
    };

    const contentType = contentTypes[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);

    // Cache static assets
    if (ext !== '.html') {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }

    res.send(content);
  } catch (error) {
    log.error({ error }, 'Failed to serve published site');
    res.status(500).send('Internal server error');
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

  // SPA fallback (avoid capturing API, preview, and published sites routes)
  // Express 5 requires named wildcards, so we use /*splat
  app.get('/*splat', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/preview') || req.path.startsWith('/sites')) {
      return next();
    }
    res.sendFile(path.join(FRONTEND_BUILD_DIR, 'index.html'));
  });
  log.info({ path: FRONTEND_BUILD_DIR }, '🪄 Serving frontend');
} catch (e) {
  log.info('ℹ️ Frontend build not found; API-only mode');
}

// HTTP request logging middleware
app.use(requestLogger());

// Global error handling middleware (must be registered last)
app.use(errorHandler);

// Store server reference for graceful shutdown
const server = app.listen(PORT as number, '0.0.0.0', () => {
  log.info({ port: PORT, host: '0.0.0.0' }, '🎨 Site Studio backend running');
  log.info({ sandboxesDir: SANDBOXES_DIR }, '🔒 Sandboxed projects directory');
  log.info('🛡️  Multi-user isolation enabled');
});

// Graceful shutdown handler
function gracefulShutdown(signal: string) {
  log.info({ signal }, '🛑 Received shutdown signal, closing server...');

  // Close HTTP server (stops accepting new connections)
  server.close(async () => {
    log.info('✓ HTTP server closed');

    try {
      // Cleanup sandbox manager (cleanup inactive sessions)
      log.info('Cleaning up sandbox sessions...');
      await sandboxManager.cleanupInactiveSessions();

      log.info('✓ All resources cleaned up successfully');
      process.exit(0);
    } catch (error) {
      log.error({ error }, '✗ Error during cleanup');
      process.exit(1);
    }
  });

  // Force exit after 10 seconds if graceful shutdown hangs
  setTimeout(() => {
    log.error('✗ Forceful shutdown after timeout');
    process.exit(1);
  }, 10000).unref();
}

// Register signal handlers for graceful shutdown
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
