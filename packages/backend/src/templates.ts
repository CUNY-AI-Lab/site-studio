import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { IStorage } from './storage/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to templates directory
const TEMPLATES_DIR = path.join(__dirname, '../templates');

// Template metadata
export interface TemplateMetadata {
  id: string;
  title: string;
  description: string;
  icon: string; // lucide icon name
  categoryName: string;
}

export interface TemplateCategory {
  name: string;
  description: string;
  templates: TemplateMetadata[];
}

// Valid template IDs
export type TemplateId =
  // Personal pages
  | 'personal-minimal'
  | 'personal-bold'
  | 'personal-sidebar'
  | 'personal-card'
  // CV sites
  | 'cv-classic'
  | 'cv-modern'
  | 'cv-timeline'
  | 'cv-academic'
  // Portfolios
  | 'portfolio-grid'
  | 'portfolio-magazine'
  | 'portfolio-showcase'
  | 'portfolio-minimal'
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
  | 'timeline-interactive'
  // Blank
  | 'blank';

export const VALID_TEMPLATES: TemplateId[] = [
  'personal-minimal',
  'personal-bold',
  'personal-sidebar',
  'personal-card',
  'cv-classic',
  'cv-modern',
  'cv-timeline',
  'cv-academic',
  'portfolio-grid',
  'portfolio-magazine',
  'portfolio-showcase',
  'portfolio-minimal',
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
  'timeline-interactive',
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
 * @returns Map of filename -> content (string for text files, Buffer for binary files)
 */
export async function loadTemplate(templateId: TemplateId): Promise<Map<string, string | Buffer>> {
  const templatePath = path.join(TEMPLATES_DIR, templateId);
  const files = new Map<string, string | Buffer>();

  try {
    const entries = await fs.readdir(templatePath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isFile()) {
        const filePath = path.join(templatePath, entry.name);
        // Read as Buffer to preserve binary files (images, PDFs, etc.)
        const content = await fs.readFile(filePath);
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

/**
 * Template categories with metadata
 * This is the single source of truth for template organization
 */
export const TEMPLATE_CATEGORIES: TemplateCategory[] = [
  {
    name: 'Personal Pages',
    description: 'Simple landing pages and profiles',
    templates: [
      { id: 'personal-minimal', title: 'Minimal', description: 'Clean, centered landing page', icon: 'User', categoryName: 'Personal Pages' },
      { id: 'personal-bold', title: 'Bold', description: 'Vibrant page with featured work', icon: 'UserCircle', categoryName: 'Personal Pages' },
      { id: 'personal-sidebar', title: 'Sidebar', description: 'Sidebar navigation layout', icon: 'Contact', categoryName: 'Personal Pages' },
      { id: 'personal-card', title: 'Card', description: 'Card-based profile with content grid', icon: 'SquareUser', categoryName: 'Personal Pages' }
    ]
  },
  {
    name: 'CV & Resume',
    description: 'Academic and professional CVs',
    templates: [
      { id: 'cv-classic', title: 'Classic', description: 'Traditional academic CV', icon: 'FileText', categoryName: 'CV & Resume' },
      { id: 'cv-modern', title: 'Modern', description: 'Contemporary CV with sidebar', icon: 'GraduationCap', categoryName: 'CV & Resume' },
      { id: 'cv-timeline', title: 'Timeline', description: 'Visual timeline format', icon: 'Award', categoryName: 'CV & Resume' },
      { id: 'cv-academic', title: 'Academic', description: 'Two-column academic CV', icon: 'ScrollText', categoryName: 'CV & Resume' }
    ]
  },
  {
    name: 'Portfolio',
    description: 'Showcase your work and projects',
    templates: [
      { id: 'portfolio-grid', title: 'Grid', description: 'Project grid showcase', icon: 'Grid', categoryName: 'Portfolio' },
      { id: 'portfolio-magazine', title: 'Magazine', description: 'Editorial style portfolio', icon: 'BookOpen', categoryName: 'Portfolio' },
      { id: 'portfolio-showcase', title: 'Showcase', description: 'Featured work display', icon: 'Image', categoryName: 'Portfolio' },
      { id: 'portfolio-minimal', title: 'Minimal', description: 'Ultra-minimal with large images', icon: 'Frame', categoryName: 'Portfolio' }
    ]
  },
  {
    name: 'Course Sites',
    description: 'Syllabi, schedules, and materials',
    templates: [
      { id: 'course-traditional', title: 'Traditional', description: 'Classic syllabus layout', icon: 'Presentation', categoryName: 'Course Sites' },
      { id: 'course-modern', title: 'Modern', description: 'Contemporary course site', icon: 'BookOpen', categoryName: 'Course Sites' }
    ]
  },
  {
    name: 'Publications',
    description: 'Research papers and articles',
    templates: [
      { id: 'publication-bibliography', title: 'Bibliography', description: 'Traditional citation format', icon: 'BookMarked', categoryName: 'Publications' },
      { id: 'publication-featured', title: 'Featured', description: 'Showcase key publications', icon: 'Library', categoryName: 'Publications' }
    ]
  },
  {
    name: 'Events',
    description: 'Conferences, workshops, symposia',
    templates: [
      { id: 'event-schedule', title: 'Schedule', description: 'Conference schedule', icon: 'Calendar', categoryName: 'Events' },
      { id: 'event-speaker', title: 'Speakers', description: 'Speaker/presenter focused', icon: 'Users', categoryName: 'Events' }
    ]
  },
  {
    name: 'Photo Essays',
    description: 'Visual storytelling with images',
    templates: [
      { id: 'photo-gallery', title: 'Gallery', description: 'Image gallery layout', icon: 'Camera', categoryName: 'Photo Essays' },
      { id: 'photo-narrative', title: 'Narrative', description: 'Scrolling photo story', icon: 'Image', categoryName: 'Photo Essays' }
    ]
  },
  {
    name: 'Resources',
    description: 'Curated links and collections',
    templates: [
      { id: 'resource-categorized', title: 'Categorized', description: 'Organized by categories', icon: 'Link', categoryName: 'Resources' },
      { id: 'resource-grid', title: 'Grid', description: 'Card grid layout', icon: 'Grid', categoryName: 'Resources' }
    ]
  },
  {
    name: 'Data Visualization',
    description: 'Charts, graphs, and interactive data',
    templates: [
      { id: 'dataviz-dashboard', title: 'Dashboard', description: 'Chart dashboard', icon: 'BarChart3', categoryName: 'Data Visualization' },
      { id: 'dataviz-narrative', title: 'Narrative', description: 'Scrolling data story', icon: 'PieChart', categoryName: 'Data Visualization' },
      { id: 'dataviz-interactive', title: 'Interactive', description: 'Interactive explorer', icon: 'BarChart3', categoryName: 'Data Visualization' },
      { id: 'timeline-interactive', title: 'Timeline', description: 'TimelineJS visualization from CSV', icon: 'Clock', categoryName: 'Data Visualization' }
    ]
  },
  {
    name: 'Start Fresh',
    description: 'Blank canvas',
    templates: [
      { id: 'blank', title: 'Blank Canvas', description: 'Start from scratch', icon: 'Minimize2', categoryName: 'Start Fresh' }
    ]
  }
];

/**
 * Get all template categories with metadata
 */
export function getTemplateCategories(): TemplateCategory[] {
  return TEMPLATE_CATEGORIES;
}
