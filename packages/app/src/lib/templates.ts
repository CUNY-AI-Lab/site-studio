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

const BLANK_TEMPLATE: TemplateCategory[] = [
  {
    name: "Start Fresh",
    description: "Blank canvas",
    templates: [
      {
        id: "blank",
        title: "Blank Canvas",
        description: "Start from scratch",
        icon: "Minimize2",
        categoryName: "Start Fresh"
      }
    ]
  }
];

export function getTemplateCategories(): TemplateCategory[] {
  return BLANK_TEMPLATE;
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
