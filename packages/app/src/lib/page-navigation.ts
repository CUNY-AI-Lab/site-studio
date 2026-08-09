/**
 * Return whether a request expects an HTML document rather than an asset.
 * Callers can use this to choose the styled page fallback for 404 responses.
 */
export function looksLikePageNavigation(
  acceptHeader: string | null | undefined,
  filePath: string
): boolean {
  const accept = acceptHeader || "";
  if (accept.includes("text/html")) {
    return true;
  }
  const path = filePath.trim();
  return path === "" || path.endsWith("/") || path.endsWith(".html") || path.endsWith(".htm");
}
