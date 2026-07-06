/**
 * @site-studio/serving-core — single source of truth for the HTTP-serving logic
 * shared by the app worker (packages/app) and the standalone publisher worker
 * (packages/worker). Both import these TypeScript sources directly; wrangler's
 * esbuild bundles them into each worker at build time. The cross-worker
 * restriction (a deployed worker cannot call another worker's code) is
 * runtime-only and does not apply to build-time source sharing.
 */
export { SERVED_CONTENT_TYPES, getServedContentType } from "./content-types";
export { servedContentHeaders } from "./serving-headers";
export { renderNotFoundPage } from "./not-found-page";
export { looksLikePageNavigation } from "./page-navigation";
export { resolveExtensionlessFile } from "./extensionless";
