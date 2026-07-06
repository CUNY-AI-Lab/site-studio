export const SESSION_COOKIE_NAME = "site-studio-session";
/**
 * Delivery cookie for the anti-CSRF token (INTEGRATION.md §3¾ rule 3). The
 * KV-stored per-subject token is handed to page JS via this cookie instead of
 * a response body, so a same-origin sibling/attacker script cannot read it out
 * of a fetch response. NOT HttpOnly (page JS must read it), Secure, SameSite=Lax,
 * and Path-scoped by CSRF_COOKIE_PATH so siblings/published-site JS under other
 * prefixes never see it. See lib/csrf.ts setCsrfCookie().
 */
export const CSRF_COOKIE_NAME = "cail_csrf_sitestudio";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
/**
 * Image uploads are held to a tighter cap than generic files. Real photos for a
 * student site rarely need more than a few MB; 10MB leaves room for a large
 * hero image without inviting multi-hundred-MB uploads into R2.
 */
export const IMAGE_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const PROTECTED_FILE_NAMES = new Set([".metadata.json", ".thumbnail.png"]);

export const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
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
 * The AUTHORITATIVE content-type table for HTTP serving, shared by BOTH the app
 * worker (published /u/, /sites/ and the editor /preview/) and the standalone
 * publisher worker (packages/worker/src/index.ts). It is the single source of
 * truth for SS-8: the two workers MUST return byte-identical Content-Type
 * headers for the same file extension, or a site serves differently depending
 * on which worker answers it.
 *
 * Differences from CONTENT_TYPES above (which stays bare for the editor's file
 * tree / isText classification and document.ts's exact-match probes):
 * - text types carry `; charset=utf-8` so browsers decode them correctly
 * - `.mjs` maps to application/javascript (bare CONTENT_TYPES lookups still work
 *   because `.mjs` was added there too, but this table pins the served charset)
 *
 * IMPORTANT: keep in sync with the hand-duplicated copy in
 * packages/worker/src/index.ts (SERVED_CONTENT_TYPES / getServedContentType).
 * The publisher worker cannot import from packages/app, so a parity test
 * (packages/worker/src/serving-parity.test.ts) asserts the two copies agree
 * across a matrix of extensions.
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
