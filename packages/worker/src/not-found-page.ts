/**
 * Dignified fallback "Page not found" document served on students' OWN
 * published sites when a requested page is missing and the project supplies no
 * 404.html of its own.
 *
 * Design constraints (a broken link on someone else's live site should not look
 * like our infrastructure leaking through):
 * - neutral, no Site Studio branding beyond at most a muted one-liner
 * - system font stack; honors prefers-color-scheme (light + dark)
 * - accessible: lang, landmarks, sufficient contrast, real heading
 * - zero JavaScript, zero external requests, inline CSS only
 *
 * IMPORTANT: keep in sync with the source-of-truth copy in
 * packages/app/src/lib/not-found-page.ts. This package cannot import from
 * packages/app, so the two copies are maintained by hand.
 */

/**
 * Render the fallback 404 HTML document.
 *
 * @param siteRootPath Optional path to the site's root (e.g. "/sites/u/slug/").
 *   When provided, a "Go to site home" link is rendered. When omitted, the
 *   link is dropped so the page never points somewhere it cannot resolve.
 */
export function renderNotFoundPage(siteRootPath?: string): string {
  const homeLink = siteRootPath
    ? `\n        <p class="actions"><a href="${escapeHtmlAttribute(siteRootPath)}">Go to site home</a></p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Page not found</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f7f7f6;
    --panel: #ffffff;
    --border: #e3e3e0;
    --text: #1c1c1a;
    --muted: #6b6b66;
    --link: #2b5cb8;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16161a;
      --panel: #1e1e24;
      --border: #303039;
      --text: #ececf0;
      --muted: #9a9aa4;
      --link: #8fb4ff;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.6;
    background: var(--bg);
    color: var(--text);
    display: flex;
    min-height: 100%;
  }
  main {
    margin: auto;
    max-width: 32rem;
    width: 100%;
    padding: 2.5rem 1.5rem;
    text-align: center;
  }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 2.5rem 2rem;
  }
  h1 {
    margin: 0 0 0.75rem;
    font-size: 1.6rem;
    font-weight: 650;
    letter-spacing: -0.01em;
  }
  p { margin: 0 0 0.5rem; color: var(--muted); }
  .actions { margin-top: 1.5rem; }
  a {
    color: var(--link);
    font-weight: 550;
    text-decoration: none;
    border-bottom: 1px solid transparent;
  }
  a:hover, a:focus { border-bottom-color: currentColor; }
  a:focus-visible { outline: 2px solid var(--link); outline-offset: 3px; border-radius: 2px; }
</style>
</head>
<body>
  <main>
    <div class="card">
      <h1>Page not found</h1>
      <p>The page you were looking for isn&rsquo;t here. It may have been moved or removed.</p>${homeLink}
    </div>
  </main>
</body>
</html>
`;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
