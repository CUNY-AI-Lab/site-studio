import puppeteer, { Browser } from 'puppeteer';
import { IStorage } from '../storage/types.js';

let browser: Browser | null = null;

// Track last generation time per project (projectId -> timestamp)
const lastGenerationTime = new Map<string, number>();

// Throttle duration in milliseconds (1 minute)
const THROTTLE_DURATION = 60 * 1000;

/**
 * Initialize the browser instance (reused across thumbnail generations)
 */
async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    });
  }
  return browser;
}

/**
 * Check if enough time has passed to generate a new thumbnail
 * @param projectId - Project ID to check
 * @returns true if thumbnail should be generated, false if throttled
 */
function shouldGenerateThumbnail(projectId: string): boolean {
  const lastTime = lastGenerationTime.get(projectId);
  if (!lastTime) {
    return true; // Never generated before
  }

  const timeSinceLastGeneration = Date.now() - lastTime;
  return timeSinceLastGeneration >= THROTTLE_DURATION;
}

/**
 * Update the last generation time for a project
 * @param projectId - Project ID
 */
function updateGenerationTime(projectId: string): void {
  lastGenerationTime.set(projectId, Date.now());
}

/**
 * Generate a thumbnail for a project
 * @param storage - Storage instance to save the thumbnail
 * @param userId - User ID who owns the project
 * @param projectId - Project ID to generate thumbnail for
 * @param previewUrl - Full URL to the internal preview endpoint
 * @param force - Force generation even if throttled (default: false)
 * @returns The path/URL of the generated thumbnail, or null if throttled
 */
export async function generateThumbnail(
  storage: IStorage,
  userId: string,
  projectId: string,
  previewUrl: string,
  force: boolean = false
): Promise<string | null> {
  // Check throttle (unless forced)
  if (!force && !shouldGenerateThumbnail(projectId)) {
    console.log(`Thumbnail generation throttled for project ${projectId}`);
    return null;
  }

  const browserInstance = await getBrowser();
  const page = await browserInstance.newPage();

  try {
    // Set viewport size for consistent thumbnails
    await page.setViewport({
      width: 1200,
      height: 800,
      deviceScaleFactor: 1,
    });

    // Navigate to the preview URL with internal auth header
    await page.setExtraHTTPHeaders({
      'X-Internal-Auth': process.env.INTERNAL_AUTH_TOKEN || 'internal-secret-token',
      'X-User-Id': userId,
    });

    // Navigate to the preview URL
    await page.goto(previewUrl, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // Wait a bit for any dynamic content
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Take screenshot
    const screenshotBuffer = Buffer.from(await page.screenshot({
      type: 'png',
      fullPage: false, // Only capture the viewport
    }));

    // Save thumbnail to storage
    const thumbnailPath = '.thumbnail.png';
    await storage.writeFile(userId, projectId, thumbnailPath, screenshotBuffer);

    // Update project metadata with thumbnail URL
    await storage.updateProjectMetadata(userId, projectId, {
      thumbnailUrl: `/api/projects/${projectId}/thumbnail`,
    });

    // Update generation time to enforce throttle
    updateGenerationTime(projectId);

    console.log(`Thumbnail generated successfully for project ${projectId}`);
    return thumbnailPath;
  } catch (error) {
    console.error(`Failed to generate thumbnail for project ${projectId}:`, error);
    throw error;
  } finally {
    await page.close();
  }
}

/**
 * Clean up the browser instance (call on server shutdown)
 */
export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}
