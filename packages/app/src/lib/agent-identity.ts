import { z } from "zod";

/** Server-owned PartyServer props channel used for per-connection auth. */
export const SITE_STUDIO_AGENT_PROPS_HEADER = "x-partykit-props";

/**
 * Read the identity selected by auth middleware from serialized agent props.
 */
export function getAgentConnectionIdentityJwt(request: Request): string | null {
  const propsHeader = request.headers.get(SITE_STUDIO_AGENT_PROPS_HEADER);
  if (propsHeader) {
    try {
      const parsed = z.object({ identityJwt: z.string().min(1) }).safeParse(JSON.parse(propsHeader));
      return parsed.success ? parsed.data.identityJwt : null;
    } catch {
      return null;
    }
  }

  return null;
}
