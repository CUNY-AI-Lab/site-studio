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
import { getUserProjectPath, getUserUploadsPath } from './sandbox/config.js';
import { getStorage, initializeStorage } from './storage/index.js';

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

// Apply authentication to all API routes
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
// Use memory storage for R2, disk storage for filesystem
const upload = multer({
  storage: process.env.STORAGE_TYPE === 'r2'
    ? multer.memoryStorage()
    : multer.diskStorage({
        destination: async (req, file, cb) => {
          const authReq = req as AuthenticatedRequest;
          const userId = authReq.user.id;
          const uploadsPath = getUserUploadsPath(userId);
          await fs.mkdir(uploadsPath, { recursive: true });
          cb(null, uploadsPath);
        },
        filename: (req, file, cb) => {
          // Sanitize filename
          const sanitized = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
          cb(null, `${Date.now()}-${sanitized}`);
        },
      }),
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
    const { name } = req.body;

    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'Project name is required' });
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

    // Create a starter index.html file
    const starterHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${name}</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 2rem;
        }

        .container {
            background: white;
            border-radius: 16px;
            padding: 3rem 2rem;
            max-width: 600px;
            width: 100%;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            text-align: center;
        }

        h1 {
            font-size: 2.5rem;
            color: #333;
            margin-bottom: 1rem;
        }

        .subtitle {
            font-size: 1.25rem;
            color: #666;
            margin-bottom: 2rem;
        }

        .section {
            margin-top: 2rem;
            padding-top: 2rem;
            border-top: 2px solid #f0f0f0;
        }

        .section h2 {
            font-size: 1.5rem;
            color: #667eea;
            margin-bottom: 1rem;
        }

        .prompts {
            text-align: left;
            background: #f8f9fa;
            padding: 1.5rem;
            border-radius: 8px;
            margin-top: 1rem;
        }

        .prompts li {
            margin: 0.75rem 0;
            color: #555;
            line-height: 1.6;
        }

        .icon {
            font-size: 3rem;
            margin-bottom: 1rem;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">🎨</div>
        <h1>${name}</h1>
        <p class="subtitle">Welcome to your new project!</p>

        <div class="section">
            <h2>Getting Started</h2>
            <p style="color: #666; margin-bottom: 1rem;">
                Start chatting with the AI in the sidebar to build your website.
                Try one of these examples:
            </p>
            <ul class="prompts">
                <li>"Create an academic profile page with my bio, research interests, and contact info"</li>
                <li>"Build a course site with syllabus, schedule, and weekly readings"</li>
                <li>"Make a collaborative project space for my study group or research team"</li>
                <li>"Design a digital portfolio showcasing my academic work and publications"</li>
            </ul>
        </div>
    </div>
</body>
</html>`;

    await storage.writeFile(userId, sanitized, 'index.html', starterHtml);

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
 * GET /api/projects/:id/files
 * List files in a user's project
 */
app.get('/api/projects/:id/files', async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const { id } = req.params;

    // Get flat list of files from storage
    const flatFiles = await storage.listFiles(userId, id);

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

    const files = buildTree(flatFiles);

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
    const filePath = req.query.path as string;

    if (!filePath) {
      res.status(400).json({ error: 'File path is required' });
      return;
    }

    // Security: basic path validation (prevent directory traversal)
    if (filePath.includes('..') || filePath.startsWith('/')) {
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
    const { path: filePath, content } = req.body;

    if (!filePath || typeof filePath !== 'string') {
      res.status(400).json({ error: 'File path is required' });
      return;
    }

    if (content === undefined) {
      res.status(400).json({ error: 'File content is required' });
      return;
    }

    // Security: basic path validation (prevent directory traversal)
    if (filePath.includes('..') || filePath.startsWith('/')) {
      res.status(403).json({ error: 'Invalid file path' });
      return;
    }

    // Write the file
    await storage.writeFile(userId, id, filePath, content);

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

    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    // For R2 storage, upload from memory buffer
    if (process.env.STORAGE_TYPE === 'r2' && req.file.buffer) {
      const sanitized = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      const filename = `${Date.now()}-${sanitized}`;
      await storage.uploadFile(userId, filename, req.file.buffer);

      res.json({
        success: true,
        filename: filename,
        path: filename,
        size: req.file.size,
        message: 'File uploaded successfully',
      });
    } else {
      // File is stored in user's uploads directory (filesystem)
      res.json({
        success: true,
        filename: req.file.filename,
        path: req.file.filename,
        size: req.file.size,
        message: 'File uploaded successfully',
      });
    }
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
    const filePath = req.query.path as string;

    if (!filePath) {
      res.status(400).json({ error: 'File path is required' });
      return;
    }

    // Security: basic path validation (prevent directory traversal)
    if (filePath.includes('..') || filePath.startsWith('/')) {
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

    // Handle uploaded file if present - inject content into prompt
    let enhancedPrompt = prompt;

    if (uploadedFile) {
      const uploadsPath = getUserUploadsPath(userId);
      const filePath = path.join(uploadsPath, uploadedFile);

      try {
        // Read file content
        const fileContent = await fs.readFile(filePath, 'utf-8');

        // Inject file content into prompt
        enhancedPrompt = `${prompt}\n\n<uploaded_file name="${uploadedFile}">\n${fileContent}\n</uploaded_file>`;
      } catch (error) {
        console.error('Error reading uploaded file:', error);
        // Fall back to original prompt
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
 */
app.use('/preview/:id', authenticateUser, async (req, res, next) => {
  const authReq = req as AuthenticatedRequest;
  const userId = authReq.user.id;
  const projectId = req.params.id;

  if (process.env.STORAGE_TYPE === 'r2') {
    // For R2, serve files manually
    try {
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

      const buffer = await storage.readFileBuffer(userId, projectId, filePath);

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
    const projectPath = getProjectPath(userId, projectId);
    express.static(projectPath, {
      setHeaders: (res) => {
        // Allow preview iframe to load
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      },
    })(req, res, next);
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🎨 Site Studio backend running on http://localhost:${PORT}`);
  console.log(`🔒 Sandboxed projects directory: ${SANDBOXES_DIR}`);
  console.log(`🛡️  Multi-user isolation enabled`);
});
