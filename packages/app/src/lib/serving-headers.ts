/**
 * Security headers for authored bytes served by preview and published-site
 * routes on the app origin.
 *
 * The bare `sandbox allow-scripts` policy intentionally omits
 * `allow-same-origin`, keeping authored documents in an opaque origin while
 * still allowing ordinary site scripts to render. The remaining headers block
 * MIME confusion and keep the app origin out of outbound referrers.
 */
export function servedContentHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": "sandbox allow-scripts",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  };
}
