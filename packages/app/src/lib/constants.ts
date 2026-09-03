export const SESSION_COOKIE_NAME = "site-studio-session";
/**
 * Delivery cookie for the anti-CSRF token (docs/security-and-recovery.md,
 * browser and serving defenses). The
 * KV-stored per-subject token is handed to page JS via this cookie instead of
 * a response body, so a same-origin sibling/attacker script cannot read it out
 * of a fetch response. NOT HttpOnly (page JS must read it), Secure, SameSite=Lax,
 * and Path-scoped by CSRF_COOKIE_PATH so siblings/published-site JS under other
 * prefixes never see it. See lib/csrf.ts setCsrfCookie().
 */
export const CSRF_COOKIE_NAME = "cail_csrf_sitestudio";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
/** Application upload limits; these are not R2's object-size limits. */
export const IMAGE_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Allow multipart framing while bounding the body before native form parsing. */
export const MAX_UPLOAD_BODY_MARGIN_BYTES = 1 * 1024 * 1024;
export const MAX_UPLOAD_BODY_BYTES = MAX_UPLOAD_BYTES + MAX_UPLOAD_BODY_MARGIN_BYTES;
export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
export const MAX_THUMBNAIL_DIMENSION = 4096;
export const MAX_THUMBNAIL_BODY_BYTES = MAX_THUMBNAIL_BYTES + MAX_UPLOAD_BODY_MARGIN_BYTES;
/**
 * SS-28 snapshot cap: maximum total UNCOMPRESSED project size (summed from R2
 * listing metadata) that `createSnapshot` will read into memory and zip. Every
 * agent mutation snapshots the whole project synchronously (`zipSync` blocks the
 * DO isolate while it reads + compresses every file), so an oversized project
 * turns each turn into an isolate spike.
 *
 * 50MB is chosen so normal sites always snapshot: a text-heavy academic site is
 * a few hundred KB, and even one loaded with the max-size images allowed by the
 * upload caps stays well under 50MB in practice. It is small enough that the
 * synchronous read+zip of a project at the cap stays a bounded, recoverable
 * cost rather than a multi-hundred-MB blocking spike. Projects above the cap
 * SKIP the snapshot for that turn (see createSnapshot) — the mutation still
 * proceeds, the user just has no restore point for that oversized turn.
 */
export const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;
/**
 * SS-38 snapshot retention: keep the newest 50 snapshots per project. Snapshot
 * creation is synchronous and runs on every mutation, so unbounded archives
 * would grow R2 storage forever for active projects.
 */
export const SNAPSHOT_KEEP_COUNT = 50;
export { PROTECTED_FILE_NAMES } from "./protected-files";

export const CONTENT_TYPES = {
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
  ".ogg": "audio/ogg",
} as const satisfies Readonly<Record<string, string>>;

/**
 * `SERVED_CONTENT_TYPES` differs from `CONTENT_TYPES` above (which stays bare
 * for the editor's file tree / isText classification and document.ts's
 * exact-match probes): text types carry `; charset=utf-8` and `.mjs` pins the
 * served charset. Keep this re-export so existing app callers can continue to
 * import served types from lib/constants.
 */
export {
  SERVED_CONTENT_TYPES,
  getServedContentType
} from "./content-types";
