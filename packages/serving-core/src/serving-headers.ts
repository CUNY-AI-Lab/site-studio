/**
 * Security headers merged onto every response that hands tool-served
 * user/agent bytes to the browser: published sites (/u/, /sites/) and the
 * editor preview (/preview/), all served from the app's OWN authenticated
 * origin. Shared by the app worker (packages/app) and the standalone publisher
 * worker (packages/worker); both import this single copy.
 *
 * §3¾ active-content invariant: tool-served user/agent bytes must NEVER be
 * interpretable as an active SAME-ORIGIN document. Published sites are viewable
 * by OTHER users, and an agent- or student-authored .html/.svg reaching one of
 * these routes would otherwise run script on the app origin, read the
 * non-HttpOnly CSRF cookie, and call credentialed /api endpoints — a cross-user
 * account takeover.
 *
 * Unlike the file-download posture in the fleet reference impl
 * (packages/../file-serving.ts: `default-src 'none'; sandbox` +
 * `Content-Disposition: attachment`), a published academic site is active
 * content MEANT to render — it is a website. So we cannot kill scripting or
 * force a download. Instead we force an OPAQUE ORIGIN while keeping scripts:
 *
 *   Content-Security-Policy: sandbox allow-scripts
 *
 * The bare `sandbox allow-scripts` directive (NOTE: NO `allow-same-origin`) is
 * the load-bearing containment. It puts the document in an opaque origin EVEN
 * ON TOP-LEVEL NAVIGATION, so scripts still execute (the site works) but
 * `document.cookie`, the same-origin session, and same-origin `fetch` to /api
 * are all unreachable — the takeover is dead. This mirrors the in-app iframe
 * posture but is enforced at the RESPONSE, so a direct top-level open is
 * equally opaque-origin.
 *
 * We deliberately DO NOT set `default-src` (published academic sites
 * legitimately load their own assets and CDN subresources — fonts, scripts,
 * styles; the bare `sandbox` directive forces the opaque origin WITHOUT
 * blocking subresource loads) and DO NOT set `Content-Disposition` (published
 * sites must render, not download).
 *
 * `X-Content-Type-Options: nosniff` blocks MIME confusion (an asset sniffed
 * into an active type). `Referrer-Policy: no-referrer` keeps the app origin out
 * of outbound referers from sandboxed pages.
 *
 * JUDGMENT CALL (fleet parity): the bare `sandbox allow-scripts` token also
 * sandboxes-out forms and popups in published sites. This ships the strict
 * fleet-parity version. If student-site functionality later needs them,
 * `allow-forms` / `allow-popups` can be added to the sandbox token WITHOUT
 * weakening the cookie-theft containment — only `allow-same-origin` matters for
 * that, and it must never be added here.
 */
export function servedContentHeaders(): Record<string, string> {
  return {
    // Opaque origin even on top-level nav (no allow-same-origin): the primary
    // containment. Scripts still run so the site renders.
    "Content-Security-Policy": "sandbox allow-scripts",
    // Never let the browser sniff a different (possibly active) type.
    "X-Content-Type-Options": "nosniff",
    // Keep the app origin out of outbound referers.
    "Referrer-Policy": "no-referrer",
  };
}
