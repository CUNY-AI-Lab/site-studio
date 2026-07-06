/**
 * Security headers merged onto every response that serves published-site
 * user/agent bytes (/u/, /sites/) from the app's OWN origin.
 *
 * §3¾ active-content invariant: tool-served user/agent bytes must NEVER be
 * interpretable as an active SAME-ORIGIN document. Published sites are viewable
 * by OTHER users, and an agent- or student-authored .html/.svg reaching one of
 * these routes would otherwise run script on the app origin, read the
 * non-HttpOnly CSRF cookie, and call credentialed /api endpoints — a cross-user
 * account takeover.
 *
 * A published academic site is active content MEANT to render — a website — so
 * we cannot kill scripting or force a download. Instead we force an OPAQUE
 * ORIGIN while keeping scripts:
 *
 *   Content-Security-Policy: sandbox allow-scripts
 *
 * The bare `sandbox allow-scripts` directive (NOTE: NO `allow-same-origin`) is
 * the load-bearing containment. It puts the document in an opaque origin EVEN
 * ON TOP-LEVEL NAVIGATION, so scripts still execute (the site works) but
 * `document.cookie`, the same-origin session, and same-origin `fetch` to /api
 * are all unreachable — the takeover is dead.
 *
 * We deliberately DO NOT set `default-src` (published sites legitimately load
 * their own + CDN subresources; the bare `sandbox` directive forces the opaque
 * origin without blocking those loads) and DO NOT set `Content-Disposition`
 * (published sites must render, not download).
 *
 * `X-Content-Type-Options: nosniff` blocks MIME confusion. `Referrer-Policy:
 * no-referrer` keeps the app origin out of outbound referers.
 *
 * JUDGMENT CALL (fleet parity): the bare `sandbox allow-scripts` token also
 * sandboxes-out forms and popups. This ships the strict fleet-parity version;
 * `allow-forms` / `allow-popups` can be added later WITHOUT weakening the
 * cookie-theft containment (only `allow-same-origin` matters for that, and it
 * must never be added here).
 *
 * IMPORTANT: keep in sync with the source-of-truth copy in
 * packages/app/src/lib/serving-headers.ts. This package cannot import from
 * packages/app, so the two copies are maintained by hand.
 */
export function servedContentHeaders(_contentType: string): Record<string, string> {
  return {
    "Content-Security-Policy": "sandbox allow-scripts",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}
