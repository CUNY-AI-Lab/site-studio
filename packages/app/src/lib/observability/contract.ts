import type { CailLogEnvironment } from "@cuny-ai-lab/cail-log";
import { SITE_STUDIO_ACTION_ROUTES } from "./action-attempt";

export const PRODUCT_ID = "site-studio";
export const SERVICE_VERSION = "0.1.0";

/**
 * Parse the deployment environment without normalization or a fallback.
 * Configuration typos must fail closed instead of relabeling telemetry.
 */
export function parseCailLogEnvironment(value: string | null | undefined): CailLogEnvironment | undefined {
  switch (value) {
    case "production":
    case "staging":
    case "development":
    case "test":
      return value;
    default:
      return undefined;
  }
}

/** Non-cacheable response used when a required runtime contract is invalid. */
export function serviceUnavailableResponse(): Response {
  return new Response(JSON.stringify({ error: "Service unavailable" }), {
    status: 503,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=UTF-8",
    },
  });
}

export const OBSERVABILITY_CONTRACT = {
  services: {
    app: {
      name: "site-studio-app",
      version: SERVICE_VERSION,
      healthPath: "/api/health",
      healthMarker: "site-studio-app:alive:v1",
    },
  },
  actions: {
    build: {
      route: SITE_STUDIO_ACTION_ROUTES.build,
      method: "POST",
    },
    publish: {
      route: SITE_STUDIO_ACTION_ROUTES.publish,
      method: "POST",
    },
  },
} as const;

export type SiteStudioService = keyof typeof OBSERVABILITY_CONTRACT.services;

/**
 * The Cloudflare version-metadata binding is absent in local development and
 * older deployments. Keep its public health projection joinable and explicit:
 * only a canonical Cloudflare version UUID and a lowercase full Git SHA tag
 * are exposed; invalid or missing fields become null.
 */
export type HealthVersionMetadata = Readonly<{
  id: string;
  tag: string;
  timestamp?: string;
}>;

const CLOUDFLARE_VERSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GIT_SHA_VERSION_TAG_PATTERN = /^[0-9a-f]{40}$/;

function cloudflareVersionId(value: string | undefined): string | null {
  return value !== undefined && CLOUDFLARE_VERSION_ID_PATTERN.test(value)
    ? value
    : null;
}

function gitShaVersionTag(value: string | undefined): string | null {
  return value !== undefined && GIT_SHA_VERSION_TAG_PATTERN.test(value)
    ? value
    : null;
}

export function healthResponse(
  service: SiteStudioService,
  versionMetadata?: HealthVersionMetadata | null,
): Response {
  const definition = OBSERVABILITY_CONTRACT.services[service];
  return Response.json(
    {
      schema_version: "cail.health.v1",
      status: "ok",
      check: "liveness",
      marker: definition.healthMarker,
      product_id: PRODUCT_ID,
      service: {
        name: definition.name,
        version: definition.version,
      },
      version_id: cloudflareVersionId(versionMetadata?.id),
      version_tag: gitShaVersionTag(versionMetadata?.tag),
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
