import type { SiteBuilderAgentProps } from "../types";

/**
 * Read the identity selected by auth middleware from serialized agent props.
 */
export function getAgentConnectionIdentityJwt(request: Request): string | null {
  const propsHeader = request.headers.get("x-partykit-props");
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
