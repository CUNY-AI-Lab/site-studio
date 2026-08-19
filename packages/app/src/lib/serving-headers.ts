/**
 * Security headers for authored bytes served by preview and published-site
 * routes on the app origin.
 *
 * The bare `sandbox allow-scripts` policy intentionally omits
 * `allow-same-origin`, keeping authored documents in an opaque origin while
 * still allowing ordinary site scripts to render. The remaining headers block
 * MIME confusion and keep the app origin out of outbound referrers.
 */
export function servedContentHeaders() {
  const headers = {
    "Content-Security-Policy": "sandbox allow-scripts",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  } satisfies Record<string, string>;
  return headers;
}

/** Headers for the app-generated 404 document or plain-text missing asset. */
export function servedNotFoundHeaders(cacheControl: string) {
  const headers = {
    "Cache-Control": cacheControl,
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "Vary": "Accept",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  } satisfies Record<string, string>;
  return headers;
}
