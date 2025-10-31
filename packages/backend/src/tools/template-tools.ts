import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';

/**
 * Create template tools with projectPath baked in
 */
export function createTemplateTools(projectPath: string) {

// HTML starter templates
const templates = {
  blank: {
    'index.html': `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>My Site</title>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <h1>Welcome to my site!</h1>
    <p>This is a blank starter template.</p>
</body>
</html>`,
    'styles.css': `* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

body {
    font-family: system-ui, -apple-system, sans-serif;
    line-height: 1.6;
    color: #333;
    max-width: 800px;
    margin: 0 auto;
    padding: 2rem;
}

h1 {
    margin-bottom: 1rem;
    color: #2563eb;
}

p {
    margin-bottom: 1rem;
}`,
  },
  'research-portfolio': {
    'index.html': `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Research Portfolio</title>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <header>
        <nav>
            <h1>Your Name</h1>
            <ul>
                <li><a href="#research">Research</a></li>
                <li><a href="#publications">Publications</a></li>
                <li><a href="#cv">CV</a></li>
                <li><a href="#contact">Contact</a></li>
            </ul>
        </nav>
    </header>

    <main>
        <section id="hero">
            <h2>Your Name, Ph.D.</h2>
            <p class="subtitle">Research Specialist in [Your Field]</p>
            <p>Affiliation: [Your Institution/Department]</p>
        </section>

        <section id="research">
            <h2>Research Interests</h2>
            <p>Describe your primary research areas and methodological approaches...</p>
            <div class="research-areas">
                <div class="research-area">
                    <h3>Research Area 1</h3>
                    <p>Brief description of this research focus</p>
                </div>
                <div class="research-area">
                    <h3>Research Area 2</h3>
                    <p>Brief description of this research focus</p>
                </div>
            </div>
        </section>

        <section id="publications">
            <h2>Selected Publications</h2>
            <article class="publication">
                <p class="citation">Author, A., & Collaborator, B. (2025). <em>Article Title</em>. Journal Name, 10(2), 123-145.</p>
                <a href="#" class="publication-link">DOI Link</a>
            </article>
            <article class="publication">
                <p class="citation">Author, A. (2024). <em>Another Publication Title</em>. Conference Proceedings, 456-478.</p>
                <a href="#" class="publication-link">PDF</a>
            </article>
        </section>

        <section id="cv">
            <h2>Curriculum Vitae</h2>
            <p><a href="cv.pdf" class="cv-link">Download CV (PDF)</a></p>
        </section>

        <section id="contact">
            <h2>Contact Information</h2>
            <p>Email: your.email@institution.edu</p>
            <p>Office: Building Name, Room XXX</p>
        </section>
    </main>

    <footer>
        <p>&copy; 2025 Your Name. Academic Portfolio.</p>
    </footer>
</body>
</html>`,
    'styles.css': `* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

body {
    font-family: 'Crimson Text', Georgia, serif;
    line-height: 1.7;
    color: #1a202c;
    background: #f7fafc;
}

header {
    background: #fff;
    border-bottom: 2px solid #e2e8f0;
    position: sticky;
    top: 0;
    box-shadow: 0 1px 3px rgba(0,0,0,0.05);
}

nav {
    max-width: 900px;
    margin: 0 auto;
    padding: 1.25rem 2rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
}

nav h1 {
    font-size: 1.25rem;
    font-weight: 600;
    color: #2d3748;
}

nav ul {
    list-style: none;
    display: flex;
    gap: 2rem;
}

nav a {
    text-decoration: none;
    color: #4a5568;
    font-weight: 500;
    font-size: 0.95rem;
}

nav a:hover {
    color: #2c5282;
}

main {
    max-width: 900px;
    margin: 0 auto;
    padding: 3rem 2rem;
    background: #fff;
    min-height: calc(100vh - 200px);
}

section {
    margin-bottom: 4rem;
    padding-bottom: 3rem;
    border-bottom: 1px solid #e2e8f0;
}

section:last-of-type {
    border-bottom: none;
}

#hero {
    padding: 2rem 0 3rem;
}

#hero h2 {
    font-size: 2.25rem;
    margin-bottom: 0.75rem;
    color: #1a202c;
    font-weight: 600;
}

#hero .subtitle {
    font-size: 1.25rem;
    color: #2c5282;
    margin-bottom: 0.5rem;
    font-weight: 500;
}

#hero p {
    color: #4a5568;
}

h2 {
    font-size: 1.75rem;
    margin-bottom: 1.5rem;
    color: #2d3748;
    font-weight: 600;
}

h3 {
    font-size: 1.25rem;
    margin-bottom: 0.75rem;
    color: #2c5282;
    font-weight: 600;
}

.research-areas {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 2rem;
    margin-top: 2rem;
}

.research-area {
    padding: 1.5rem;
    background: #f7fafc;
    border-left: 3px solid #2c5282;
    border-radius: 4px;
}

.publication {
    margin-bottom: 1.5rem;
    padding: 1rem;
    background: #f7fafc;
    border-radius: 4px;
}

.citation {
    color: #2d3748;
    margin-bottom: 0.5rem;
    line-height: 1.6;
}

.publication-link,
.cv-link {
    color: #2c5282;
    text-decoration: none;
    font-weight: 500;
    font-size: 0.9rem;
}

.publication-link:hover,
.cv-link:hover {
    text-decoration: underline;
}

footer {
    background: #2d3748;
    text-align: center;
    padding: 2rem;
    color: #cbd5e0;
    font-size: 0.9rem;
}`,
  },
  portfolio: {
    'index.html': `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>My Portfolio</title>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <header>
        <nav>
            <h1>Your Name</h1>
            <ul>
                <li><a href="#about">About</a></li>
                <li><a href="#projects">Projects</a></li>
                <li><a href="#contact">Contact</a></li>
            </ul>
        </nav>
    </header>

    <main>
        <section id="hero">
            <h2>Your Name</h2>
            <p>Student · Developer · Creator</p>
        </section>

        <section id="about">
            <h2>About</h2>
            <p>Introduce yourself and your background here...</p>
        </section>

        <section id="projects">
            <h2>Projects</h2>
            <div class="project-grid">
                <div class="project-card">
                    <h3>Project 1</h3>
                    <p>Description of your project</p>
                </div>
                <div class="project-card">
                    <h3>Project 2</h3>
                    <p>Description of your project</p>
                </div>
            </div>
        </section>

        <section id="contact">
            <h2>Contact</h2>
            <p>Email: your.email@example.com</p>
        </section>
    </main>

    <footer>
        <p>&copy; 2025 Your Name</p>
    </footer>
</body>
</html>`,
    'styles.css': `* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

body {
    font-family: system-ui, -apple-system, sans-serif;
    line-height: 1.6;
    color: #333;
}

header {
    background: #fff;
    border-bottom: 1px solid #e5e7eb;
    position: sticky;
    top: 0;
}

nav {
    max-width: 1200px;
    margin: 0 auto;
    padding: 1rem 2rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
}

nav ul {
    list-style: none;
    display: flex;
    gap: 2rem;
}

nav a {
    text-decoration: none;
    color: #374151;
    font-weight: 500;
}

nav a:hover {
    color: #2563eb;
}

main {
    max-width: 1200px;
    margin: 0 auto;
    padding: 2rem;
}

section {
    margin-bottom: 4rem;
}

#hero {
    padding: 4rem 0;
}

#hero h2 {
    font-size: 3rem;
    margin-bottom: 1rem;
    color: #111827;
}

#hero p {
    font-size: 1.5rem;
    color: #6b7280;
}

h2 {
    font-size: 2rem;
    margin-bottom: 1.5rem;
    color: #111827;
}

.project-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 2rem;
}

.project-card {
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    padding: 2rem;
}

.project-card h3 {
    margin-bottom: 1rem;
    color: #2563eb;
}

footer {
    background: #f9fafb;
    text-align: center;
    padding: 2rem;
    color: #6b7280;
}`,
  },
  blog: {
    'index.html': `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>My Blog</title>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <header>
        <h1>My Blog</h1>
        <p>Thoughts, stories, and ideas</p>
    </header>

    <main>
        <article class="post">
            <h2><a href="post1.html">First Blog Post</a></h2>
            <time datetime="2025-01-01">January 1, 2025</time>
            <p>This is a preview of your first blog post. Click to read more...</p>
        </article>

        <article class="post">
            <h2><a href="post2.html">Second Blog Post</a></h2>
            <time datetime="2025-01-02">January 2, 2025</time>
            <p>Another interesting post preview goes here...</p>
        </article>
    </main>

    <footer>
        <p>&copy; 2025 My Blog</p>
    </footer>
</body>
</html>`,
    'styles.css': `* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

body {
    font-family: Georgia, serif;
    line-height: 1.8;
    color: #1f2937;
    background: #f9fafb;
}

header {
    background: #fff;
    text-align: center;
    padding: 3rem 2rem;
    border-bottom: 1px solid #e5e7eb;
}

header h1 {
    font-size: 2.5rem;
    margin-bottom: 0.5rem;
    color: #111827;
}

header p {
    color: #6b7280;
    font-style: italic;
}

main {
    max-width: 700px;
    margin: 3rem auto;
    padding: 0 2rem;
}

.post {
    background: #fff;
    padding: 2rem;
    margin-bottom: 2rem;
    border-radius: 8px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}

.post h2 {
    margin-bottom: 0.5rem;
}

.post h2 a {
    color: #111827;
    text-decoration: none;
}

.post h2 a:hover {
    color: #2563eb;
}

.post time {
    color: #6b7280;
    font-size: 0.9rem;
    display: block;
    margin-bottom: 1rem;
}

.post p {
    color: #374151;
}

footer {
    text-align: center;
    padding: 2rem;
    color: #6b7280;
}`,
  },
};

  /**
   * Tool: scaffold_template
   * Create a new project from a template
   */
  const scaffoldTemplate = tool(
    'scaffold_template',
    `Create a new site from a template. Available templates:
- blank: Minimal HTML/CSS starter
- research-portfolio: Academic research portfolio with publications
- portfolio: General portfolio/personal website
- blog: Simple blog layout`,
    z.object({
      template: z.enum(['blank', 'research-portfolio', 'portfolio', 'blog']).describe('Template to use'),
    }).shape,
    async (params) => {
      try {
      const template = templates[params.template];

      // Write all template files
      for (const [filename, content] of Object.entries(template)) {
        const fullPath = path.join(projectPath, filename);
        await fs.writeFile(fullPath, content, 'utf-8');
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            template: params.template,
            files: Object.keys(template),
            message: `Created ${params.template} template successfully`,
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error scaffolding template: ${error.message}`,
        }],
      };
    }
  }
);

  /**
   * Tool: add_page
   * Add a new HTML page to the project
   */
  const addPage = tool(
    'add_page',
    `Create a new HTML page in the project with a basic structure.`,
    z.object({
      page_name: z.string().describe('Name of the page (e.g., "about", "contact")'),
      title: z.string().describe('Page title'),
    }).shape,
    async (params) => {
      try {
      const filename = params.page_name.endsWith('.html')
        ? params.page_name
        : `${params.page_name}.html`;
      const fullPath = path.join(projectPath, filename);

      const content = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${params.title}</title>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <h1>${params.title}</h1>
    <p>Add your content here...</p>

    <p><a href="index.html">Back to home</a></p>
</body>
</html>`;

      await fs.writeFile(fullPath, content, 'utf-8');

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            filename: filename,
            message: `Created page ${filename} successfully`,
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error creating page: ${error.message}`,
        }],
      };
    }
  }
);

  return [
    scaffoldTemplate,
    addPage,
  ];
}
