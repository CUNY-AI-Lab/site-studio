import { describe, expect, it } from "vitest";
import { servedContentHeaders } from "./serving-headers";

/**
 * §3¾ active-content invariant. Every served user/agent byte gets the
 * opaque-origin CSP + nosniff, whether or not the content-type is an active
 * document type — the containment must never depend on the content-type, and
 * `allow-same-origin` must NEVER appear (that is the token that would re-enable
 * cookie/session theft).
 */
describe("servedContentHeaders", () => {
  const activeTypes = [
    "text/html; charset=utf-8",
    "image/svg+xml",
    "application/xml; charset=utf-8",
    "application/xhtml+xml"
  ];
  const inactiveTypes = [
    "text/css; charset=utf-8",
    "application/javascript; charset=utf-8",
    "image/png",
    "application/octet-stream"
  ];

  for (const contentType of [...activeTypes, ...inactiveTypes]) {
    it(`forces opaque-origin scripting + nosniff for ${contentType}`, () => {
      const headers = servedContentHeaders(contentType);
      expect(headers["Content-Security-Policy"]).toBe("sandbox allow-scripts");
      expect(headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(headers["Referrer-Policy"]).toBe("no-referrer");
    });

    it(`never grants allow-same-origin for ${contentType}`, () => {
      const headers = servedContentHeaders(contentType);
      expect(headers["Content-Security-Policy"]).not.toContain("allow-same-origin");
    });
  }

  it("never sets default-src (subresources/CDN assets must still load)", () => {
    const csp = servedContentHeaders("text/html; charset=utf-8")["Content-Security-Policy"];
    expect(csp).not.toContain("default-src");
  });

  it("never forces a download (published sites must render)", () => {
    expect(servedContentHeaders("text/html; charset=utf-8")).not.toHaveProperty("Content-Disposition");
  });
});
