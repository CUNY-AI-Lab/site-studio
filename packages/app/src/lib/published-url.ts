import { isLoopbackOrigin } from "./csrf";

/**
 * The public mount is deployment configuration, not project identity. Keep
 * the current request's loopback origin for local development; production
 * uses the configured public base when one is present.
 */
export function getPublishedBaseUrl(requestUrl: string, configuredBaseUrl?: string): string {
  const requestOrigin = new URL(requestUrl).origin;
  if (isLoopbackOrigin(requestOrigin)) {
    return requestOrigin;
  }

  return normalizePublishedBaseUrl(configuredBaseUrl?.trim() || requestOrigin);
}

export function normalizePublishedBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function publishedProjectUrl(baseUrl: string, handle: string, slug: string): string {
  return `${normalizePublishedBaseUrl(baseUrl)}/u/${handle}/${slug}/`;
}
