/**
 * §3¾ served-content security headers. The implementation now lives once in
 * @site-studio/serving-core (packages/serving-core/src/serving-headers.ts) and
 * is shared with the standalone publisher worker; this re-export keeps the
 * in-app import path stable. See serving-core for the full security rationale.
 */
export { servedContentHeaders } from "../../../serving-core/src/serving-headers";
