import { TEMPLATE_FILES } from "./template-content";

export interface TemplateMetadata {
  id: string;
  title: string;
  description: string;
  icon: string;
  categoryName: string;
}

export interface TemplateCategory {
  name: string;
  description: string;
  templates: TemplateMetadata[];
}

export const TEMPLATE_IDS = [
  "personal-minimal",
  "personal-bold",
  "personal-sidebar",
  "personal-card",
  "cv-classic",
  "cv-modern",
  "cv-timeline",
  "cv-academic",
  "portfolio-grid",
  "portfolio-magazine",
  "portfolio-showcase",
  "portfolio-minimal",
  "course-traditional",
  "course-modern",
  "publication-bibliography",
  "publication-featured",
  "event-schedule",
  "event-speaker",
  "photo-gallery",
  "photo-narrative",
  "resource-categorized",
  "resource-grid",
  "dataviz-dashboard",
  "dataviz-narrative",
  "dataviz-interactive",
  "timeline-interactive",
  "blank",
] as const;

export type TemplateId = (typeof TEMPLATE_IDS)[number];

const TEMPLATE_ID_SET = new Set<string>(TEMPLATE_IDS);

const TEMPLATE_CATEGORIES: TemplateCategory[] = [
  {
    name: "Personal Pages",
    description: "Simple landing pages and profiles",
    templates: [
      { id: "personal-minimal", title: "Minimal", description: "Clean, centered landing page", icon: "User", categoryName: "Personal Pages" },
      { id: "personal-bold", title: "Bold", description: "Vibrant page with featured work", icon: "UserCircle", categoryName: "Personal Pages" },
      { id: "personal-sidebar", title: "Sidebar", description: "Sidebar navigation layout", icon: "Contact", categoryName: "Personal Pages" },
      { id: "personal-card", title: "Card", description: "Card-based profile with content grid", icon: "SquareUser", categoryName: "Personal Pages" },
    ],
  },
  {
    name: "CV & Resume",
    description: "Academic and professional CVs",
    templates: [
      { id: "cv-classic", title: "Classic", description: "Traditional academic CV", icon: "FileText", categoryName: "CV & Resume" },
      { id: "cv-modern", title: "Modern", description: "Contemporary CV with sidebar", icon: "GraduationCap", categoryName: "CV & Resume" },
      { id: "cv-timeline", title: "Timeline", description: "Visual timeline format", icon: "Award", categoryName: "CV & Resume" },
      { id: "cv-academic", title: "Academic", description: "Two-column academic CV", icon: "ScrollText", categoryName: "CV & Resume" },
    ],
  },
  {
    name: "Portfolio",
    description: "Showcase your work and projects",
    templates: [
      { id: "portfolio-grid", title: "Grid", description: "Project grid showcase", icon: "Grid", categoryName: "Portfolio" },
      { id: "portfolio-magazine", title: "Magazine", description: "Editorial style portfolio", icon: "BookOpen", categoryName: "Portfolio" },
      { id: "portfolio-showcase", title: "Showcase", description: "Featured work display", icon: "Image", categoryName: "Portfolio" },
      { id: "portfolio-minimal", title: "Minimal", description: "Ultra-minimal with large images", icon: "Frame", categoryName: "Portfolio" },
    ],
  },
  {
    name: "Course Sites",
    description: "Syllabi, schedules, and materials",
    templates: [
      { id: "course-traditional", title: "Traditional", description: "Classic syllabus layout", icon: "Presentation", categoryName: "Course Sites" },
      { id: "course-modern", title: "Modern", description: "Contemporary course site", icon: "BookOpen", categoryName: "Course Sites" },
    ],
  },
  {
    name: "Publications",
    description: "Research papers and articles",
    templates: [
      { id: "publication-bibliography", title: "Bibliography", description: "Traditional citation format", icon: "BookMarked", categoryName: "Publications" },
      { id: "publication-featured", title: "Featured", description: "Showcase key publications", icon: "Library", categoryName: "Publications" },
    ],
  },
  {
    name: "Events",
    description: "Conferences, workshops, symposia",
    templates: [
      { id: "event-schedule", title: "Schedule", description: "Conference schedule", icon: "Calendar", categoryName: "Events" },
      { id: "event-speaker", title: "Speakers", description: "Speaker/presenter focused", icon: "Users", categoryName: "Events" },
    ],
  },
  {
    name: "Photo Essays",
    description: "Visual storytelling with images",
    templates: [
      { id: "photo-gallery", title: "Gallery", description: "Image gallery layout", icon: "Camera", categoryName: "Photo Essays" },
      { id: "photo-narrative", title: "Narrative", description: "Scrolling photo story", icon: "Image", categoryName: "Photo Essays" },
    ],
  },
  {
    name: "Resources",
    description: "Curated links and collections",
    templates: [
      { id: "resource-categorized", title: "Categorized", description: "Organized by categories", icon: "Link", categoryName: "Resources" },
      { id: "resource-grid", title: "Grid", description: "Card grid layout", icon: "Grid", categoryName: "Resources" },
    ],
  },
  {
    name: "Data Visualization",
    description: "Charts, graphs, and interactive data",
    templates: [
      { id: "dataviz-dashboard", title: "Dashboard", description: "Chart dashboard", icon: "BarChart3", categoryName: "Data Visualization" },
      { id: "dataviz-narrative", title: "Narrative", description: "Scrolling data story", icon: "PieChart", categoryName: "Data Visualization" },
      { id: "dataviz-interactive", title: "Interactive", description: "Interactive explorer", icon: "BarChart3", categoryName: "Data Visualization" },
      { id: "timeline-interactive", title: "Timeline", description: "TimelineJS visualization from CSV", icon: "Clock", categoryName: "Data Visualization" },
    ],
  },
  {
    name: "Start Fresh",
    description: "Blank canvas",
    templates: [
      { id: "blank", title: "Blank Canvas", description: "Start from scratch", icon: "Minimize2", categoryName: "Start Fresh" },
    ],
  },
];

export function getTemplateCategories(): TemplateCategory[] {
  return TEMPLATE_CATEGORIES;
}

export function isValidTemplate(templateId: string): templateId is TemplateId {
  return TEMPLATE_ID_SET.has(templateId);
}

export function getTemplateFiles(templateId: string): Record<string, string> | null {
  const entry = Object.entries(TEMPLATE_FILES).find(([id]) => id === templateId);
  return entry === undefined ? null : { ...entry[1] };
}

export function createBlankIndexHtml(projectName: string): string {
  const escapedTitle = projectName
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapedTitle}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Georgia, serif;
      background:
        radial-gradient(circle at top left, rgba(197, 230, 224, 0.9), transparent 30%),
        linear-gradient(160deg, #f6f1e8 0%, #fbfaf7 45%, #eef4f2 100%);
      color: #1d2a2c;
      display: grid;
      place-items: center;
      padding: 2rem;
    }
    main {
      width: min(720px, 100%);
      background: rgba(255, 255, 255, 0.82);
      border: 1px solid rgba(29, 42, 44, 0.08);
      border-radius: 24px;
      padding: 3rem;
      box-shadow: 0 24px 80px rgba(29, 42, 44, 0.12);
      backdrop-filter: blur(18px);
    }
    h1 {
      margin: 0 0 1rem;
      font-size: clamp(2.5rem, 5vw, 4rem);
      line-height: 0.95;
      letter-spacing: -0.05em;
    }
    p {
      margin: 0;
      font-size: 1.05rem;
      line-height: 1.7;
      max-width: 52ch;
      color: #365055;
    }
  </style>
</head>
<body>
  <main>
    <h1>${escapedTitle}</h1>
    <p>Welcome to your new Site Studio project. Use the editor and chat to shape the structure, content, and design.</p>
  </main>
</body>
</html>`;
}
