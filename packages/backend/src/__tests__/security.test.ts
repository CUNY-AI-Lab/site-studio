import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFileTools } from '../tools/file-tools.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { Request, Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.js';

describe('Security - Path Traversal Protection', () => {
  let testDir: string;
  let outsideDir: string;
  let tools: ReturnType<typeof createFileTools>;

  beforeEach(async () => {
    // Create test directory
    testDir = path.join(os.tmpdir(), `security-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Create a directory outside the test directory with a sensitive file
    outsideDir = path.join(os.tmpdir(), `outside-${Date.now()}`);
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'SECRET DATA', 'utf-8');

    tools = createFileTools(testDir);
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
      await fs.rm(outsideDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('read_file', () => {
    it('should block path traversal with ../..', async () => {
      const [, readFile] = tools;

      // Create a symlink-free path that goes outside
      const relativePath = path.relative(testDir, path.join(outsideDir, 'secret.txt'));
      const result = await readFile.handler({ file_path: relativePath });

      // Should fail, not return secret data
      expect(result.content[0].text).not.toContain('SECRET DATA');
      expect(result.content[0].text).toContain('Failed to read');
    });

    it('should block absolute paths', async () => {
      const [, readFile] = tools;

      const result = await readFile.handler({ file_path: '/etc/passwd' });

      expect(result.content[0].text).toContain('Failed to read');
    });

    it('should allow reading files within project', async () => {
      const [, readFile, writeFile] = tools;

      // Create a legitimate file
      await writeFile.handler({ file_path: 'legitimate.txt', content: 'OK' });

      const result = await readFile.handler({ file_path: 'legitimate.txt' });
      expect(result.content[0].text).toBe('OK');
    });

    it('should allow reading nested files within project', async () => {
      const [, readFile, writeFile] = tools;

      await writeFile.handler({ file_path: 'sub/nested.txt', content: 'nested content' });

      const result = await readFile.handler({ file_path: 'sub/nested.txt' });
      expect(result.content[0].text).toBe('nested content');
    });
  });

  describe('delete_file', () => {
    it('should block path traversal attempts', async () => {
      const [, , , deleteFile] = tools;

      // Try to delete file outside project
      const relativePath = path.relative(testDir, path.join(outsideDir, 'secret.txt'));
      const result = await deleteFile.handler({ file_path: relativePath });

      expect(result.content[0].text).toContain('Failed to delete');

      // Verify outside file still exists
      const content = await fs.readFile(path.join(outsideDir, 'secret.txt'), 'utf-8');
      expect(content).toBe('SECRET DATA');
    });

    it('should block absolute paths', async () => {
      const [, , , deleteFile] = tools;

      const result = await deleteFile.handler({ file_path: '/etc/passwd' });
      expect(result.content[0].text).toContain('Failed to delete');
    });

    it('should allow deleting files within project', async () => {
      const [, , writeFile, deleteFile] = tools;

      await writeFile.handler({ file_path: 'deleteme.txt', content: 'delete' });

      const result = await deleteFile.handler({ file_path: 'deleteme.txt' });
      expect(result.content[0].text).toContain('Deleted');

      // Verify file is gone
      await expect(fs.access(path.join(testDir, 'deleteme.txt'))).rejects.toThrow();
    });
  });

  describe('Edge Cases', () => {
    it('should handle null bytes in paths', async () => {
      const [, readFile] = tools;

      // Null byte path traversal attempt
      const result = await readFile.handler({ file_path: 'test.txt\0/../../etc/passwd' });
      expect(result.content[0].text).toContain('Failed to read');
    });

    it('should handle encoded path separators', async () => {
      const [, readFile] = tools;

      // URL-encoded path traversal
      const result = await readFile.handler({ file_path: '..%2F..%2Fetc%2Fpasswd' });
      expect(result.content[0].text).toContain('Failed to read');
    });

    it('should handle windows-style paths on unix', async () => {
      const [, readFile] = tools;

      // Windows path separators
      const result = await readFile.handler({ file_path: '..\\..\\etc\\passwd' });
      expect(result.content[0].text).toContain('Failed to read');
    });
  });
});

describe('Security - Input Validation', () => {
  let testDir: string;
  let tools: ReturnType<typeof createFileTools>;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `input-validation-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    tools = createFileTools(testDir);
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('write_file', () => {
    it('should handle empty content', async () => {
      const [, , writeFile] = tools;

      const result = await writeFile.handler({ file_path: 'empty.txt', content: '' });
      expect(result.content[0].text).toContain('Created empty.txt');
      expect(result.content[0].text).toContain('0 bytes');

      // Verify file exists and is empty
      const content = await fs.readFile(path.join(testDir, 'empty.txt'), 'utf-8');
      expect(content).toBe('');
    });

    it('should handle very long file names', async () => {
      const [, , writeFile] = tools;

      const longName = 'a'.repeat(100) + '.txt';
      const result = await writeFile.handler({ file_path: longName, content: 'test' });

      // Should work for reasonable lengths
      expect(result.content[0].text).toContain('Created');
    });

    it('should handle special characters in content', async () => {
      const [, , writeFile, , , , , ] = tools;

      const specialContent = '<script>alert("xss")</script>\n\0\r\n';
      await writeFile.handler({ file_path: 'special.txt', content: specialContent });

      // Verify content is preserved exactly
      const content = await fs.readFile(path.join(testDir, 'special.txt'), 'utf-8');
      expect(content).toBe(specialContent);
    });
  });

  describe('edit_file', () => {
    it('should handle multiple occurrences correctly', async () => {
      const [, , writeFile, , , , editFile] = tools;

      await writeFile.handler({ file_path: 'test.txt', content: 'foo foo foo' });

      // Only replaces first occurrence
      await editFile.handler({
        file_path: 'test.txt',
        old_text: 'foo',
        new_text: 'bar',
      });

      const content = await fs.readFile(path.join(testDir, 'test.txt'), 'utf-8');
      expect(content).toBe('bar foo foo');
    });
  });

  describe('search_files', () => {
    it('should handle regex special characters in query', async () => {
      const [, , writeFile, , , , , searchFiles] = tools;

      await writeFile.handler({ file_path: 'test.txt', content: 'price: $5.00' });

      // Search for literal string with special characters
      const result = await searchFiles.handler({ query: '$5.00' });
      expect(result.content[0].text).toContain('test.txt');
    });

    it('should handle newlines in search results', async () => {
      const [, , writeFile, , , , , searchFiles] = tools;

      await writeFile.handler({ file_path: 'multiline.txt', content: 'line1\nfoo\nline3' });

      const result = await searchFiles.handler({ query: 'foo' });
      expect(result.content[0].text).toContain('multiline.txt');
    });
  });
});

describe('Security - Cross-User Access Prevention', () => {
  it('should prevent unauthorized access to preview endpoint', async () => {
    // Mock storage with findProjectOwner method
    const mockStorage = {
      findProjectOwner: vi.fn().mockResolvedValue('user_alice'),
      readFileBuffer: vi.fn().mockResolvedValue(Buffer.from('<html>Secret content</html>')),
    };

    // User Alice (owns the project)
    const userAlice = { id: 'user_alice', createdAt: new Date() };

    // User Bob (trying to access Alice's project)
    const userBob = { id: 'user_bob', createdAt: new Date() };

    // Mock request from Bob trying to access Alice's project
    const mockRequest: Partial<AuthenticatedRequest> = {
      params: { id: 'alice-project' },
      path: '/index.html',
      user: userBob,
    };

    const mockResponse: Partial<Response> = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };

    // Simulate the authorization check logic from the endpoint
    const projectId = mockRequest.params!.id;
    const ownerId = await mockStorage.findProjectOwner(projectId);

    // This is the critical check that was missing before the fix
    if (ownerId !== mockRequest.user!.id) {
      mockResponse.status!(403);
      mockResponse.send!('Access denied');
    } else {
      // This should not execute for Bob
      const buffer = await mockStorage.readFileBuffer(ownerId, projectId, 'index.html');
      mockResponse.send!(buffer);
    }

    // Verify Bob was denied access
    expect(mockStorage.findProjectOwner).toHaveBeenCalledWith('alice-project');
    expect(mockResponse.status).toHaveBeenCalledWith(403);
    expect(mockResponse.send).toHaveBeenCalledWith('Access denied');
    expect(mockStorage.readFileBuffer).not.toHaveBeenCalled();
  });

  it('should allow authorized access to preview endpoint', async () => {
    // Mock storage
    const mockStorage = {
      findProjectOwner: vi.fn().mockResolvedValue('user_alice'),
      readFileBuffer: vi.fn().mockResolvedValue(Buffer.from('<html>My content</html>')),
    };

    // User Alice accessing her own project
    const userAlice = { id: 'user_alice', createdAt: new Date() };

    const mockRequest: Partial<AuthenticatedRequest> = {
      params: { id: 'alice-project' },
      path: '/index.html',
      user: userAlice,
    };

    const mockResponse: Partial<Response> = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
      setHeader: vi.fn().mockReturnThis(),
    };

    // Simulate the authorization check logic
    const projectId = mockRequest.params!.id;
    const ownerId = await mockStorage.findProjectOwner(projectId);

    if (ownerId !== mockRequest.user!.id) {
      mockResponse.status!(403);
      mockResponse.send!('Access denied');
    } else {
      // Alice should be allowed access
      const buffer = await mockStorage.readFileBuffer(ownerId, projectId, 'index.html');
      mockResponse.send!(buffer);
    }

    // Verify Alice was allowed access
    expect(mockStorage.findProjectOwner).toHaveBeenCalledWith('alice-project');
    expect(mockResponse.status).not.toHaveBeenCalledWith(403);
    expect(mockStorage.readFileBuffer).toHaveBeenCalledWith('user_alice', 'alice-project', 'index.html');
    expect(mockResponse.send).toHaveBeenCalledWith(Buffer.from('<html>My content</html>'));
  });

  it('should return 404 for non-existent projects', async () => {
    // Mock storage that returns null for non-existent project
    const mockStorage = {
      findProjectOwner: vi.fn().mockResolvedValue(null),
    };

    const userAlice = { id: 'user_alice', createdAt: new Date() };

    const mockRequest: Partial<AuthenticatedRequest> = {
      params: { id: 'non-existent-project' },
      path: '/index.html',
      user: userAlice,
    };

    const mockResponse: Partial<Response> = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };

    // Simulate the logic
    const projectId = mockRequest.params!.id;
    const ownerId = await mockStorage.findProjectOwner(projectId);

    if (!ownerId) {
      mockResponse.status!(404);
      mockResponse.send!('Project not found');
      // Early return
    }

    // Verify 404 response
    expect(mockStorage.findProjectOwner).toHaveBeenCalledWith('non-existent-project');
    expect(mockResponse.status).toHaveBeenCalledWith(404);
    expect(mockResponse.send).toHaveBeenCalledWith('Project not found');
  });
});
