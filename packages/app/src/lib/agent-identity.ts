import type { SiteBuilderAgentProps } from "../types";

/** Server-owned PartyServer props channel used for per-connection auth. */
export const SITE_STUDIO_AGENT_PROPS_HEADER = "x-partykit-props";

/**
 * Read the identity selected by auth middleware from serialized agent props.
 */
export function getAgentConnectionIdentityJwt(request: Request): string | null {
  const propsHeader = request.headers.get(SITE_STUDIO_AGENT_PROPS_HEADER);
  if (propsHeader) {
    try {
      const parsed = JSON.parse(propsHeader) as SiteBuilderAgentProps;
      if (typeof parsed.identityJwt === "string" && parsed.identityJwt) {
        return parsed.identityJwt;
      }
    } catch {
      return null;
    }
  }

  return null;
}
