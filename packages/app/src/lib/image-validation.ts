/**
 * Magic-byte sniffing for the raster image formats Site Studio accepts as
 * uploads. This exists so an uploaded ".png" that is actually an HTML page (or
 * anything else) is rejected before it ever lands in R2 and gets served to a
 * visitor — the extension alone is not trusted.
 *
 * Deliberately dependency-free and runtime-agnostic: it runs in both the
 * Cloudflare Workers runtime and plain-Node vitest. It only inspects the first
 * handful of bytes, so callers can pass a full buffer or just a small prefix.
 */

export type ImageType = "png" | "jpeg" | "gif" | "webp";

/** The image file extensions we accept for image uploads (lowercase, dotted). */
export const IMAGE_EXTENSIONS = new Set<string>([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
]);

/** True when `ext` (a lowercase, dotted extension) is a known image extension. */
export function isImageExtension(ext: string): boolean {
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * Map a lowercase dotted extension to the image "family" its magic bytes must
 * match. `.jpg` and `.jpeg` both belong to the `jpeg` family. Returns null for
 * non-image extensions.
 */
export function imageTypeForExtension(ext: string): ImageType | null {
  switch (ext) {
    case ".png":
      return "png";
    case ".jpg":
    case ".jpeg":
      return "jpeg";
    case ".gif":
      return "gif";
    case ".webp":
      return "webp";
    default:
      return null;
  }
}

/** Compare `bytes[offset..]` against a fixed signature of byte values. */
function matchesSignature(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) {
    return false;
  }
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) {
      return false;
    }
  }
  return true;
}

/** ASCII bytes for a short string, for readable signature comparisons. */
function ascii(text: string): number[] {
  return Array.from(text, (ch) => ch.charCodeAt(0));
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]; // \x89PNG\r\n\x1a\n
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const GIF87A = ascii("GIF87a");
const GIF89A = ascii("GIF89a");
const RIFF = ascii("RIFF");
const WEBP = ascii("WEBP");

/**
 * Sniff the image format of `bytes` from its leading magic bytes. Returns the
 * detected format, or null when the bytes do not match any accepted image
 * format. Never throws.
 */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (matchesSignature(bytes, PNG_SIGNATURE)) {
    return "png";
  }
  if (matchesSignature(bytes, JPEG_SIGNATURE)) {
    return "jpeg";
  }
  if (matchesSignature(bytes, GIF87A) || matchesSignature(bytes, GIF89A)) {
    return "gif";
  }
  // WEBP is a RIFF container: "RIFF" .... "WEBP" (the 4 bytes at offset 4 are
  // the little-endian file size, which we skip).
  if (matchesSignature(bytes, RIFF) && matchesSignature(bytes, WEBP, 8)) {
    return "webp";
  }
  return null;
}
