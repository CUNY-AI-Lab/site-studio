/**
 * Content types used by the app's preview and published-site routes.
 *
 * Text types include an explicit UTF-8 charset so browsers decode authored
 * documents consistently, and `.mjs` is served as JavaScript so browser
 * modules load correctly.
 */
export const SERVED_CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
} as const satisfies Readonly<Record<string, string>>;

/**
 * Look up the Content-Type for an HTTP response serving `filePath`. Extension
 * matching is case-insensitive; unknown and extensionless files use the safe
 * binary fallback.
 */
export function getServedContentType(filePath: string): string {
  const match = filePath.toLowerCase().match(/\.[^.]+$/);
  if (!match) return "application/octet-stream";
  const entry = Object.entries(SERVED_CONTENT_TYPES).find(([extension]) => extension === match[0]);
  return entry?.[1] || "application/octet-stream";
}
