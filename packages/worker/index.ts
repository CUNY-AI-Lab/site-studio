/**
 * Cloudflare Worker for serving published Site Studio projects
 *
 * This worker serves static sites from Cloudflare R2 storage.
 * URL format: https://site-studio-publisher.workers.dev/{userId}/{projectId}/[path]
 *
 * It handles:
 * - Serving HTML, CSS, JS, and other static assets
 * - Automatic index.html routing (e.g., /about/ → /about/index.html)
 * - Proper Content-Type headers
 * - 404 error pages
 * - Cache optimization
 */

export interface Env {
  // R2 bucket binding (configured in wrangler.toml)
  SITE_STUDIO_BUCKET: R2Bucket;

  // Optional: Custom domain for published sites
  PUBLIC_DOMAIN?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;

      // Parse URL: /{userId}/{projectId}/[path]
      const parts = pathname.split('/').filter(p => p);

      if (parts.length < 2) {
        return new Response('Invalid URL. Format: /{userId}/{projectId}/[path]', {
          status: 400,
          headers: { 'Content-Type': 'text/plain' },
        });
      }

      const userId = parts[0];
      const projectId = parts[1];
      const filePath = parts.slice(2).join('/') || 'index.html';

      // Build R2 key: projects/{userId}/{projectId}/{filePath}
      let r2Key = `projects/${userId}/${projectId}/${filePath}`;

      // Try to fetch the file from R2
      let object = await env.SITE_STUDIO_BUCKET.get(r2Key);

      // If not found and path doesn't end with .html, try adding index.html
      if (!object && !filePath.includes('.')) {
        const indexPath = filePath ? `${filePath}/index.html` : 'index.html';
        r2Key = `projects/${userId}/${projectId}/${indexPath}`;
        object = await env.SITE_STUDIO_BUCKET.get(r2Key);
      }

      // If still not found, try just index.html in that directory
      if (!object && filePath && !filePath.endsWith('/')) {
        r2Key = `projects/${userId}/${projectId}/${filePath}/index.html`;
        object = await env.SITE_STUDIO_BUCKET.get(r2Key);
      }

      if (!object) {
        // Check if project exists at all
        const projectCheck = await env.SITE_STUDIO_BUCKET.get(
          `projects/${userId}/${projectId}/index.html`
        );

        if (!projectCheck) {
          return new Response('Project not found or not published', {
            status: 404,
            headers: { 'Content-Type': 'text/plain' },
          });
        }

        // File not found, try to serve 404.html if it exists
        const notFoundPage = await env.SITE_STUDIO_BUCKET.get(
          `projects/${userId}/${projectId}/404.html`
        );

        if (notFoundPage) {
          return new Response(notFoundPage.body, {
            status: 404,
            headers: {
              'Content-Type': 'text/html',
              'Cache-Control': 'public, max-age=300',
            },
          });
        }

        // Default 404 page
        return new Response(`
          <!DOCTYPE html>
          <html>
            <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>404 - Page Not Found</title>
              <style>
                body {
                  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  min-height: 100vh;
                  margin: 0;
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  color: white;
                }
                .container {
                  text-align: center;
                  padding: 2rem;
                }
                h1 {
                  font-size: 6rem;
                  margin: 0;
                  font-weight: 700;
                }
                p {
                  font-size: 1.5rem;
                  margin: 1rem 0;
                }
                a {
                  color: white;
                  text-decoration: underline;
                }
              </style>
            </head>
            <body>
              <div class="container">
                <h1>404</h1>
                <p>Page not found</p>
                <p><a href="/">Return to home</a></p>
              </div>
            </body>
          </html>
        `, {
          status: 404,
          headers: {
            'Content-Type': 'text/html',
            'Cache-Control': 'public, max-age=300',
          },
        });
      }

      // Get content type based on file extension
      const contentType = getContentType(r2Key);

      // Determine cache duration based on file type
      let cacheControl = 'public, max-age=3600'; // 1 hour default
      if (r2Key.endsWith('.html')) {
        cacheControl = 'public, max-age=300'; // 5 minutes for HTML
      } else if (r2Key.match(/\.(css|js|jpg|jpeg|png|gif|svg|woff|woff2|ttf|eot)$/)) {
        cacheControl = 'public, max-age=86400'; // 24 hours for assets
      }

      // Return the file
      return new Response(object.body, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': cacheControl,
          'ETag': object.etag,
          'Last-Modified': object.uploaded.toUTCString(),
        },
      });

    } catch (error: any) {
      console.error('Worker error:', error);
      return new Response(`Internal Server Error: ${error.message}`, {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
  },
};

/**
 * Get Content-Type header based on file extension
 */
function getContentType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();

  const mimeTypes: Record<string, string> = {
    'html': 'text/html',
    'htm': 'text/html',
    'css': 'text/css',
    'js': 'application/javascript',
    'json': 'application/json',
    'xml': 'application/xml',
    'txt': 'text/plain',

    // Images
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'svg': 'image/svg+xml',
    'ico': 'image/x-icon',
    'webp': 'image/webp',

    // Fonts
    'woff': 'font/woff',
    'woff2': 'font/woff2',
    'ttf': 'font/ttf',
    'eot': 'application/vnd.ms-fontobject',
    'otf': 'font/otf',

    // Documents
    'pdf': 'application/pdf',
    'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',

    // Archives
    'zip': 'application/zip',
    'tar': 'application/x-tar',
    'gz': 'application/gzip',

    // Media
    'mp3': 'audio/mpeg',
    'mp4': 'video/mp4',
    'webm': 'video/webm',
    'ogg': 'audio/ogg',
  };

  return mimeTypes[ext || ''] || 'application/octet-stream';
}
