/**
 * Dignified fallback "Page not found" document. The implementation now lives
 * once in @site-studio/serving-core (packages/serving-core/src/not-found-page.ts)
 * and is shared with the app worker; this re-export keeps this worker's import
 * path stable.
 */
export { renderNotFoundPage } from "../../serving-core/src/not-found-page";
