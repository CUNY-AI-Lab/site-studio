import type { SiteBuilderAgentProps } from "../types";

/**
 * Read the identity selected by auth middleware from serialized agent props.
 * Raw headers are compatibility fallbacks only and retain V2 precedence.
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
      // Fall through to the direct-header compatibility path.
    }
  }

  return request.headers.get("X-CAIL-Identity-JWT-V2")
    ?? request.headers.get("X-CAIL-Identity-JWT");
}
