/**
 * The AUTHORITATIVE content-type table for HTTP serving, shared by BOTH the app
 * worker (published /u/, /sites/ and the editor /preview/) and the standalone
 * publisher worker (packages/worker/src/index.ts). It is the single source of
 * truth for SS-8: the two workers MUST return byte-identical Content-Type
 * headers for the same file extension, or a site serves differently depending
 * on which worker answers it.
 *
 * Differences from packages/app's bare CONTENT_TYPES (which stays bare for the
 * editor's file tree / isText classification and document.ts's exact-match
 * probes):
 * - text types carry `; charset=utf-8` so browsers decode them correctly
 * - `.mjs` maps to application/javascript (bare CONTENT_TYPES lookups still work
 *   because `.mjs` was added there too, but this table pins the served charset)
 *
 * This used to be a hand-duplicated copy in each worker (app constants.ts /
 * worker index.ts) guarded by a parity test. It now lives here once; both
 * workers import it and wrangler bundles it into each at build time.
 */
export const SERVED_CONTENT_TYPES: Record<string, string> = {
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
  ".ogg": "audio/ogg"
};

/**
 * Look up the Content-Type for an HTTP response serving `filePath`. Case-
 * insensitive on the extension; unknown/extensionless files fall back to
 * application/octet-stream. Shared by both workers — see SERVED_CONTENT_TYPES.
 */
export function getServedContentType(filePath: string): string {
  const match = filePath.toLowerCase().match(/\.[^.]+$/);
  return match ? SERVED_CONTENT_TYPES[match[0]] || "application/octet-stream" : "application/octet-stream";
}
