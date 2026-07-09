export const PROTECTED_FILE_NAMES = new Set([".metadata.json", ".thumbnail.png"]);

export function isProtectedServedPath(path: string): boolean {
  const normalized = path.replace(/^\/+/, "");
  if (!normalized) {
    return false;
  }

  return PROTECTED_FILE_NAMES.has(normalized.split("/").pop() || "");
}
