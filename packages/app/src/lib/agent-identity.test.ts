import { describe, expect, it } from "vitest";
import { getAgentConnectionIdentityJwt } from "./agent-identity";

describe("getAgentConnectionIdentityJwt", () => {
  it("prefers the middleware-selected props token over raw identity headers", () => {
    const request = new Request("https://site-studio.example/agent", {
      headers: {
        "x-partykit-props": JSON.stringify({ identityJwt: "selected-v2-token" }),
        "X-CAIL-Identity-JWT": "stale-v1-token",
        "X-CAIL-Identity-JWT-V2": "raw-v2-token"
      }
    });
    expect(getAgentConnectionIdentityJwt(request)).toBe("selected-v2-token");
  });

  it("uses V2 before V1 on the direct-header compatibility path", () => {
    const request = new Request("https://site-studio.example/agent", {
      headers: {
        "X-CAIL-Identity-JWT": "stale-v1-token",
        "X-CAIL-Identity-JWT-V2": "selected-v2-token"
      }
    });
    expect(getAgentConnectionIdentityJwt(request)).toBe("selected-v2-token");
  });
});
