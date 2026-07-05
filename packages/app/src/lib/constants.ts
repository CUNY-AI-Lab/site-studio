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
