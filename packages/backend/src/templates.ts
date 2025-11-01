import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { IStorage } from './storage/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to templates directory
const TEMPLATES_DIR = path.join(__dirname, '../templates');

// Valid template IDs
export type TemplateId =
  // Personal pages
  | 'personal-minimal'
  | 'personal-bold'
  | 'personal-sidebar'
  // CV sites
  | 'cv-classic'
  | 'cv-modern'
  | 'cv-timeline'
  // Portfolios
  | 'portfolio-grid'
  | 'portfolio-magazine'
  | 'portfolio-showcase'
  // Course sites
  | 'course-traditional'
  | 'course-modern'
  // Publications
  | 'publication-bibliography'
  | 'publication-featured'
  // Events
  | 'event-schedule'
  | 'event-speaker'
  // Photo essays
  | 'photo-gallery'
  | 'photo-narrative'
  // Resources
  | 'resource-categorized'
  | 'resource-grid'
  // Data visualization
  | 'dataviz-dashboard'
  | 'dataviz-narrative'
  | 'dataviz-interactive'
  // Blank
  | 'blank';

export const VALID_TEMPLATES: TemplateId[] = [
  'personal-minimal',
  'personal-bold',
  'personal-sidebar',
  'cv-classic',
  'cv-modern',
  'cv-timeline',
  'portfolio-grid',
  'portfolio-magazine',
  'portfolio-showcase',
  'course-traditional',
  'course-modern',
  'publication-bibliography',
  'publication-featured',
  'event-schedule',
  'event-speaker',
  'photo-gallery',
  'photo-narrative',
  'resource-categorized',
  'resource-grid',
  'dataviz-dashboard',
  'dataviz-narrative',
  'dataviz-interactive',
  'blank',
];

/**
 * Check if a template ID is valid
 */
export function isValidTemplate(templateId: string): templateId is TemplateId {
  return VALID_TEMPLATES.includes(templateId as TemplateId);
}

/**
 * Load template files from disk
 * @param templateId - The template to load
 * @returns Map of filename -> content
 */
export async function loadTemplate(templateId: TemplateId): Promise<Map<string, string>> {
  const templatePath = path.join(TEMPLATES_DIR, templateId);
  const files = new Map<string, string>();

  try {
    const entries = await fs.readdir(templatePath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isFile()) {
        const filePath = path.join(templatePath, entry.name);
        const content = await fs.readFile(filePath, 'utf-8');
        files.set(entry.name, content);
      }
    }

    if (files.size === 0) {
      throw new Error(`Template ${templateId} has no files`);
    }

    return files;
  } catch (error: any) {
    throw new Error(`Failed to load template ${templateId}: ${error.message}`);
  }
}

/**
 * Apply a template to a project
 * Copies all template files to the project directory
 * @param storage - Storage instance
 * @param userId - User ID
 * @param projectId - Project ID
 * @param templateId - Template to apply
 */
export async function applyTemplate(
  storage: IStorage,
  userId: string,
  projectId: string,
  templateId: TemplateId
): Promise<void> {
  const templateFiles = await loadTemplate(templateId);

  // Write all template files to the project
  for (const [filename, content] of templateFiles.entries()) {
    await storage.writeFile(userId, projectId, filename, content);
  }

  console.log(`Applied template ${templateId} to project ${projectId} (${templateFiles.size} files)`);
}
