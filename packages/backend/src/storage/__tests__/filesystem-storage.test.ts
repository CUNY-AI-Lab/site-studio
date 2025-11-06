import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FilesystemStorage } from '../filesystem-storage.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('FilesystemStorage', () => {
  let storage: FilesystemStorage;
  const testDir = path.join(__dirname, '../../../../test-storage');
  const testUserId = 'test-user';
  const testProjectId = 'test-project';

  beforeEach(async () => {
    // Create test directory
    await fs.mkdir(testDir, { recursive: true });
    storage = new FilesystemStorage(testDir);
  });

  afterEach(async () => {
    // Cleanup test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore errors during cleanup
    }
  });

  describe('Project Operations', () => {
    it('should create a new project', async () => {
      await storage.createProject(testUserId, testProjectId);

      const exists = await storage.projectExists(testUserId, testProjectId);
      expect(exists).toBe(true);
    });

    it('should list projects for a user', async () => {
      await storage.createProject(testUserId, 'project1');
      await storage.createProject(testUserId, 'project2');

      const projects = await storage.listProjects(testUserId);
      expect(projects).toHaveLength(2);
      expect(projects).toContain('project1');
      expect(projects).toContain('project2');
    });

    it('should delete a project', async () => {
      await storage.createProject(testUserId, testProjectId);
      await storage.deleteProject(testUserId, testProjectId);

      const exists = await storage.projectExists(testUserId, testProjectId);
      expect(exists).toBe(false);
    });

    it('should rename a project', async () => {
      await storage.createProject(testUserId, 'old-name');
      await storage.renameProject(testUserId, 'old-name', 'new-name');

      const oldExists = await storage.projectExists(testUserId, 'old-name');
      const newExists = await storage.projectExists(testUserId, 'new-name');

      expect(oldExists).toBe(false);
      expect(newExists).toBe(true);
    });
  });

  describe('File Operations', () => {
    beforeEach(async () => {
      await storage.createProject(testUserId, testProjectId);
    });

    it('should write and read a text file', async () => {
      const content = 'Hello, World!';
      await storage.writeFile(testUserId, testProjectId, 'test.txt', content);

      const readContent = await storage.readFile(testUserId, testProjectId, 'test.txt');
      expect(readContent).toBe(content);
    });

    it('should write and read a binary file', async () => {
      const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header
      await storage.writeFile(testUserId, testProjectId, 'test.png', buffer);

      const readBuffer = await storage.readFileBuffer(testUserId, testProjectId, 'test.png');
      expect(Buffer.compare(readBuffer, buffer)).toBe(0);
    });

    it('should check if file exists', async () => {
      await storage.writeFile(testUserId, testProjectId, 'exists.txt', 'content');

      const exists = await storage.fileExists(testUserId, testProjectId, 'exists.txt');
      const notExists = await storage.fileExists(testUserId, testProjectId, 'not-exists.txt');

      expect(exists).toBe(true);
      expect(notExists).toBe(false);
    });

    it('should delete a file', async () => {
      await storage.writeFile(testUserId, testProjectId, 'delete-me.txt', 'content');
      await storage.deleteFile(testUserId, testProjectId, 'delete-me.txt');

      const exists = await storage.fileExists(testUserId, testProjectId, 'delete-me.txt');
      expect(exists).toBe(false);
    });

    it('should list files in a project', async () => {
      await storage.writeFile(testUserId, testProjectId, 'file1.txt', 'content1');
      await storage.writeFile(testUserId, testProjectId, 'file2.txt', 'content2');
      await storage.writeFile(testUserId, testProjectId, 'subdir/file3.txt', 'content3');

      const files = await storage.listFiles(testUserId, testProjectId);
      expect(files.length).toBeGreaterThanOrEqual(3);

      const filePaths = files.map(f => f.path);
      expect(filePaths).toContain('file1.txt');
      expect(filePaths).toContain('file2.txt');
      expect(filePaths).toContain('subdir/file3.txt');
    });
  });

  describe('Metadata Operations', () => {
    beforeEach(async () => {
      await storage.createProject(testUserId, testProjectId);
    });

    it('should set and get project metadata', async () => {
      const metadata = {
        name: 'Test Project',
        published: true,
        publishedUrl: 'https://example.com',
      };

      await storage.updateProjectMetadata(testUserId, testProjectId, metadata);
      const retrieved = await storage.getProjectMetadata(testUserId, testProjectId);

      expect(retrieved).toMatchObject(metadata);
    });

    it('should update existing metadata', async () => {
      await storage.updateProjectMetadata(testUserId, testProjectId, { name: 'First Name' });
      await storage.updateProjectMetadata(testUserId, testProjectId, { published: true });

      const metadata = await storage.getProjectMetadata(testUserId, testProjectId);
      expect(metadata?.name).toBe('First Name');
      expect(metadata?.published).toBe(true);
    });
  });
});
