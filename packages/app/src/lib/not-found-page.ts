/**
 * Dignified fallback "Page not found" document. The implementation now lives
 * once in @site-studio/serving-core (packages/serving-core/src/not-found-page.ts)
 * and is shared with the standalone publisher worker; this re-export keeps the
 * in-app import path stable.
 */
export { renderNotFoundPage } from "../../../serving-core/src/not-found-page";
