import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createFileTools } from '../tools/file-tools.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('File Tools', () => {
  let testDir: string;
  let tools: ReturnType<typeof createFileTools>;

  beforeEach(async () => {
    // Create a real temp directory for each test
    testDir = path.join(os.tmpdir(), `file-tools-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Create tools with the test directory
    tools = createFileTools(testDir);
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('write_file', () => {
    it('should write a file', async () => {
      const [, , writeFile] = tools;
      const result = await writeFile.handler({ file_path: 'test.txt', content: 'Hello World' });

      // Verify tool returned success
      expect(result.content[0].text).toContain('Created test.txt');

      // Verify file actually exists on disk
      const fileContent = await fs.readFile(path.join(testDir, 'test.txt'), 'utf-8');
      expect(fileContent).toBe('Hello World');
    });

    it('should create nested directories automatically', async () => {
      const [, , writeFile] = tools;
      await writeFile.handler({ file_path: 'foo/bar/baz.txt', content: 'nested' });

      // Verify file exists in nested path
      const fileContent = await fs.readFile(path.join(testDir, 'foo/bar/baz.txt'), 'utf-8');
      expect(fileContent).toBe('nested');
    });

    it('should overwrite existing files', async () => {
      const [, , writeFile] = tools;
      await writeFile.handler({ file_path: 'test.txt', content: 'first' });
      await writeFile.handler({ file_path: 'test.txt', content: 'second' });

      const fileContent = await fs.readFile(path.join(testDir, 'test.txt'), 'utf-8');
      expect(fileContent).toBe('second');
    });

    it('should report byte size correctly', async () => {
      const [, , writeFile] = tools;
      const content = 'test';
      const result = await writeFile.handler({ file_path: 'test.txt', content });

      const expectedSize = Buffer.byteLength(content, 'utf-8');
      expect(result.content[0].text).toContain(`${expectedSize} bytes`);
    });
  });

  describe('read_file', () => {
    it('should read a file', async () => {
      const [, readFile] = tools;

      // Create a file first
      await fs.writeFile(path.join(testDir, 'test.txt'), 'Hello World', 'utf-8');

      const result = await readFile.handler({ file_path: 'test.txt' });
      expect(result.content[0].text).toBe('Hello World');
    });

    it('should handle non-existent files gracefully', async () => {
      const [, readFile] = tools;
      const result = await readFile.handler({ file_path: 'missing.txt' });

      expect(result.content[0].text).toContain('Failed to read');
    });

    it('should prevent path traversal attacks', async () => {
      const [, readFile] = tools;

      // Try to read outside project directory
      const result = await readFile.handler({ file_path: '../../../etc/passwd' });

      // Should fail with access denied
      expect(result.content[0].text).toContain('Failed to read');
    });
  });

  describe('edit_file', () => {
    it('should edit a file by replacing text', async () => {
      const [, , writeFile, , , , editFile] = tools;

      // Create file with initial content
      await writeFile.handler({ file_path: 'test.txt', content: 'Hello World' });

      // Edit the file
      await editFile.handler({
        file_path: 'test.txt',
        old_text: 'World',
        new_text: 'Universe',
      });

      // Verify edit worked
      const fileContent = await fs.readFile(path.join(testDir, 'test.txt'), 'utf-8');
      expect(fileContent).toBe('Hello Universe');
    });

    it('should fail if old_text is not found', async () => {
      const [, , writeFile, , , , editFile] = tools;

      await writeFile.handler({ file_path: 'test.txt', content: 'Hello World' });

      const result = await editFile.handler({
        file_path: 'test.txt',
        old_text: 'nonexistent',
        new_text: 'replacement',
      });

      expect(result.content[0].text).toContain('not found');
    });
  });

  describe('delete_file', () => {
    it('should delete a file', async () => {
      const [, , writeFile, deleteFile] = tools;

      // Create a file
      await writeFile.handler({ file_path: 'test.txt', content: 'delete me' });

      // Delete it
      const result = await deleteFile.handler({ file_path: 'test.txt' });
      expect(result.content[0].text).toContain('Deleted test.txt');

      // Verify file is gone
      await expect(fs.access(path.join(testDir, 'test.txt'))).rejects.toThrow();
    });

    it('should prevent path traversal attacks', async () => {
      const [, , , deleteFile] = tools;

      // Try to delete outside project directory
      const result = await deleteFile.handler({ file_path: '../../../etc/passwd' });

      // Should fail with access denied or file not found
      expect(result.content[0].text).toContain('Failed to delete');
    });
  });

  describe('list_files', () => {
    it('should list all files in project', async () => {
      const [listFiles, , writeFile] = tools;

      // Create some files
      await writeFile.handler({ file_path: 'file1.txt', content: 'a' });
      await writeFile.handler({ file_path: 'file2.txt', content: 'b' });
      await writeFile.handler({ file_path: 'subdir/file3.txt', content: 'c' });

      const result = await listFiles.handler({});
      const text = result.content[0].text;

      expect(text).toContain('file1.txt');
      expect(text).toContain('file2.txt');
      expect(text).toContain('file3.txt');
      expect(text).toContain('subdir');
    });

    it('should handle empty directory', async () => {
      const [listFiles] = tools;
      const result = await listFiles.handler({});

      expect(result.content[0].text).toContain('No files');
    });
  });

  describe('search_files', () => {
    it('should find text across multiple files', async () => {
      const [, , writeFile, , , , , searchFiles] = tools;

      // Create files with searchable content
      await writeFile.handler({ file_path: 'file1.txt', content: 'foo bar baz' });
      await writeFile.handler({ file_path: 'file2.txt', content: 'hello foo world' });
      await writeFile.handler({ file_path: 'file3.txt', content: 'no match here' });

      const result = await searchFiles.handler({ query: 'foo' });
      const text = result.content[0].text;

      expect(text).toContain('file1.txt');
      expect(text).toContain('file2.txt');
      expect(text).not.toContain('file3.txt');
    });

    it('should return no matches when query not found', async () => {
      const [, , writeFile, , , , , searchFiles] = tools;

      await writeFile.handler({ file_path: 'file.txt', content: 'hello' });

      const result = await searchFiles.handler({ query: 'notfound' });

      expect(result.content[0].text).toContain('No matches found');
    });

    it('should filter by file pattern', async () => {
      const [, , writeFile, , , , , searchFiles] = tools;

      await writeFile.handler({ file_path: 'test.html', content: 'foo' });
      await writeFile.handler({ file_path: 'test.css', content: 'foo' });
      await writeFile.handler({ file_path: 'test.js', content: 'foo' });

      const result = await searchFiles.handler({ query: 'foo', file_pattern: '*.html' });
      const text = result.content[0].text;

      expect(text).toContain('test.html');
      expect(text).not.toContain('test.css');
      expect(text).not.toContain('test.js');
    });
  });

  describe('rename_file', () => {
    it('should rename a file', async () => {
      const [, , writeFile, , , , , , renameFile] = tools;

      await writeFile.handler({ file_path: 'old.txt', content: 'content' });

      const result = await renameFile.handler({ old_path: 'old.txt', new_path: 'new.txt' });
      expect(result.content[0].text).toContain('Renamed');

      // Verify old file is gone
      await expect(fs.access(path.join(testDir, 'old.txt'))).rejects.toThrow();

      // Verify new file exists with same content
      const content = await fs.readFile(path.join(testDir, 'new.txt'), 'utf-8');
      expect(content).toBe('content');
    });

    it('should move file to subdirectory', async () => {
      const [, , writeFile, , , , , , renameFile] = tools;

      await writeFile.handler({ file_path: 'file.txt', content: 'move me' });

      await renameFile.handler({ old_path: 'file.txt', new_path: 'subdir/file.txt' });

      // Verify file was moved
      const content = await fs.readFile(path.join(testDir, 'subdir/file.txt'), 'utf-8');
      expect(content).toBe('move me');
    });
  });

  describe('create_directory', () => {
    it('should create a directory', async () => {
      const [, , , , createDirectory] = tools;

      const result = await createDirectory.handler({ directory_path: 'new-dir' });
      expect(result.content[0].text).toContain('Created directory');

      // Verify directory exists
      const stats = await fs.stat(path.join(testDir, 'new-dir'));
      expect(stats.isDirectory()).toBe(true);
    });

    it('should create nested directories', async () => {
      const [, , , , createDirectory] = tools;

      await createDirectory.handler({ directory_path: 'foo/bar/baz' });

      // Verify all directories exist
      const stats = await fs.stat(path.join(testDir, 'foo/bar/baz'));
      expect(stats.isDirectory()).toBe(true);
    });
  });
});
