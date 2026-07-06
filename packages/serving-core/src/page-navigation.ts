/**
 * A request "looks like a page navigation" when the visitor expects a document,
 * so a styled 404 belongs (it renders as a page). Asset requests (css/js/
 * images) keep a terse 404 so a broken tag does not download a full HTML
 * document. Shared by the app worker's preview + publish routes and the
 * standalone publisher worker — previously triplicated by hand.
 *
 * Callers pass the raw `Accept` header value (Hono `c.req.header("Accept")` or
 * `request.headers.get("Accept")`) so this stays framework-agnostic.
 */
export function looksLikePageNavigation(acceptHeader: string | null | undefined, filePath: string): boolean {
  const accept = acceptHeader || "";
  if (accept.includes("text/html")) {
    return true;
  }
  const path = filePath.trim();
  return path === "" || path.endsWith("/") || path.endsWith(".html") || path.endsWith(".htm");
}
