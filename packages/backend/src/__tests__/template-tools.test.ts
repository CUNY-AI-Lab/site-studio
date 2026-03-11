import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTemplateTools } from '../tools/template-tools.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('Template Tools', () => {
  let testDir: string;
  let tools: ReturnType<typeof createTemplateTools>;

  beforeEach(async () => {
    // Create a real temp directory for each test
    testDir = path.join(os.tmpdir(), `template-tools-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Create tools with the test directory
    tools = createTemplateTools(testDir);
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('scaffold_template', () => {
    it('should create blank template', async () => {
      const [scaffoldTemplate] = tools;

      const result = await scaffoldTemplate.handler({ template: 'blank' });
      expect(result.content[0].text).toContain('Created blank template');
      expect(result.content[0].text).toContain('2 file');

      // Verify files were actually created
      const indexHtml = await fs.readFile(path.join(testDir, 'index.html'), 'utf-8');
      const stylesCss = await fs.readFile(path.join(testDir, 'styles.css'), 'utf-8');

      expect(indexHtml).toContain('<!DOCTYPE html>');
      expect(indexHtml).toContain('My Site');
      expect(stylesCss).toContain('box-sizing: border-box');
    });

    it('should create portfolio template', async () => {
      const [scaffoldTemplate] = tools;

      const result = await scaffoldTemplate.handler({ template: 'portfolio' });
      expect(result.content[0].text).toContain('Created portfolio template');

      // Verify portfolio-specific content
      const indexHtml = await fs.readFile(path.join(testDir, 'index.html'), 'utf-8');
      expect(indexHtml).toContain('Your Name');
      expect(indexHtml).toContain('Projects');
      expect(indexHtml).toContain('project-grid');
    });

    it('should create research-portfolio template', async () => {
      const [scaffoldTemplate] = tools;

      const result = await scaffoldTemplate.handler({ template: 'research-portfolio' });
      expect(result.content[0].text).toContain('Created research-portfolio template');

      // Verify research-specific content
      const indexHtml = await fs.readFile(path.join(testDir, 'index.html'), 'utf-8');
      expect(indexHtml).toContain('Research');
      expect(indexHtml).toContain('Publications');
      expect(indexHtml).toContain('Ph.D.');
    });

    it('should create blog template', async () => {
      const [scaffoldTemplate] = tools;

      const result = await scaffoldTemplate.handler({ template: 'blog' });
      expect(result.content[0].text).toContain('Created blog template');

      // Verify blog-specific content
      const indexHtml = await fs.readFile(path.join(testDir, 'index.html'), 'utf-8');
      expect(indexHtml).toContain('My Blog');
      expect(indexHtml).toContain('article');
      expect(indexHtml).toContain('post');
    });

    it('should create both HTML and CSS files', async () => {
      const [scaffoldTemplate] = tools;

      await scaffoldTemplate.handler({ template: 'blank' });

      // Verify both files exist
      await expect(fs.access(path.join(testDir, 'index.html'))).resolves.toBeUndefined();
      await expect(fs.access(path.join(testDir, 'styles.css'))).resolves.toBeUndefined();
    });
  });

  describe('add_page', () => {
    it('should create a new page with .html extension', async () => {
      const [, addPage] = tools;

      const result = await addPage.handler({ page_name: 'about', title: 'About Us' });
      expect(result.content[0].text).toContain('Created about.html');

      // Verify file was created
      const pageContent = await fs.readFile(path.join(testDir, 'about.html'), 'utf-8');
      expect(pageContent).toContain('<!DOCTYPE html>');
      expect(pageContent).toContain('<title>About Us</title>');
      expect(pageContent).toContain('<h1>About Us</h1>');
    });

    it('should handle page names that already have .html extension', async () => {
      const [, addPage] = tools;

      await addPage.handler({ page_name: 'contact.html', title: 'Contact' });

      // Should not double the extension
      const files = await fs.readdir(testDir);
      expect(files).toContain('contact.html');
      expect(files).not.toContain('contact.html.html');
    });

    it('should include link back to home page', async () => {
      const [, addPage] = tools;

      await addPage.handler({ page_name: 'services', title: 'Our Services' });

      const pageContent = await fs.readFile(path.join(testDir, 'services.html'), 'utf-8');
      expect(pageContent).toContain('href="index.html"');
      expect(pageContent).toContain('Back to home');
    });

    it('should link to styles.css', async () => {
      const [, addPage] = tools;

      await addPage.handler({ page_name: 'test', title: 'Test Page' });

      const pageContent = await fs.readFile(path.join(testDir, 'test.html'), 'utf-8');
      expect(pageContent).toContain('href="styles.css"');
    });

    it('should use provided title in multiple places', async () => {
      const [, addPage] = tools;

      await addPage.handler({ page_name: 'team', title: 'Our Team' });

      const pageContent = await fs.readFile(path.join(testDir, 'team.html'), 'utf-8');
      expect(pageContent).toContain('<title>Our Team</title>');
      expect(pageContent).toContain('<h1>Our Team</h1>');
    });

    it('should reject path traversal in page names', async () => {
      const [, addPage] = tools;

      const result = await addPage.handler({ page_name: '../escape', title: 'Escape' });

      expect(result.content[0].text).toContain('Failed to create page');
      await expect(fs.access(path.join(testDir, '../escape.html'))).rejects.toThrow();
    });
  });
});
