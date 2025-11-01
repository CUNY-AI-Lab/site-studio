import puppeteer, { Browser } from 'puppeteer';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { VALID_TEMPLATES } from './templates.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PREVIEW_DIR = path.join(__dirname, '../../frontend/static/template-previews');
const TEMPLATES_DIR = path.join(__dirname, '../templates');

async function generatePreviews() {
  console.log('Starting preview generation for all templates...');

  // Ensure preview directory exists
  await fs.mkdir(PREVIEW_DIR, { recursive: true });

  let browser: Browser | null = null;

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    for (const templateId of VALID_TEMPLATES) {
      console.log(`\nGenerating preview for: ${templateId}`);

      const page = await browser.newPage();

      try {
        // Set viewport for consistent screenshots
        await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });

        // Load the template HTML directly
        const templatePath = path.join(TEMPLATES_DIR, templateId, 'index.html');
        const htmlContent = await fs.readFile(templatePath, 'utf-8');

        // Inject the CSS into the HTML
        const cssPath = path.join(TEMPLATES_DIR, templateId, 'styles.css');
        const cssContent = await fs.readFile(cssPath, 'utf-8');

        const fullHtml = htmlContent.replace(
          '<link rel="stylesheet" href="styles.css">',
          `<style>${cssContent}</style>`
        );

        await page.setContent(fullHtml, { waitUntil: 'networkidle0', timeout: 30000 });

        // Wait a bit for any dynamic content
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Take screenshot
        const screenshotBuffer = await page.screenshot({
          type: 'png',
          fullPage: false,
        });

        // Save to preview directory
        const previewPath = path.join(PREVIEW_DIR, `${templateId}.png`);
        await fs.writeFile(previewPath, screenshotBuffer);

        console.log(`✓ Generated: ${templateId}.png`);
      } catch (error: any) {
        console.error(`✗ Failed to generate preview for ${templateId}:`, error.message);
      } finally {
        await page.close();
      }
    }

    console.log('\n✓ Preview generation complete!');
    console.log(`Previews saved to: ${PREVIEW_DIR}`);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  generatePreviews().catch(console.error);
}

export { generatePreviews };
