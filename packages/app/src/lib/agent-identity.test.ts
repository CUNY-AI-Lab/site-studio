import { describe, expect, it } from "vitest";
import { getAgentConnectionIdentityJwt } from "./agent-identity";

describe("getAgentConnectionIdentityJwt", () => {
  it("reads the middleware-verified token from agent props", () => {
    const request = new Request("https://site-studio.example/agent", {
      headers: {
        "x-partykit-props": JSON.stringify({ identityJwt: "verified-token" }),
        "X-CAIL-Identity-JWT": "unverified-raw-token"
      }
    });
    expect(getAgentConnectionIdentityJwt(request)).toBe("verified-token");
  });

  it("does not trust a raw identity header without verified agent props", () => {
    const request = new Request("https://site-studio.example/agent", {
      headers: {
        "X-CAIL-Identity-JWT": "unverified-raw-token"
      }
    });
    expect(getAgentConnectionIdentityJwt(request)).toBeNull();
  });
});
