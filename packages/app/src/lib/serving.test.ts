import { describe, it, expect } from "vitest";
import {
  SERVED_CONTENT_TYPES,
  getServedContentType
} from "./content-types";
import { servedContentHeaders } from "./serving-headers";
import { renderNotFoundPage } from "./not-found-page";
import { looksLikePageNavigation } from "./page-navigation";

describe("app serving content-types (SS-8)", () => {
  const EXTENSION_MATRIX: Array<[string, string]> = [
    ["index.html", "text/html; charset=utf-8"],
    ["page.htm", "text/html; charset=utf-8"],
    ["styles.css", "text/css; charset=utf-8"],
    ["app.js", "application/javascript; charset=utf-8"],
    ["module.mjs", "application/javascript; charset=utf-8"],
    ["data.json", "application/json; charset=utf-8"],
    ["sitemap.xml", "application/xml; charset=utf-8"],
    ["notes.txt", "text/plain; charset=utf-8"],
    ["readme.md", "text/markdown; charset=utf-8"],
    ["table.csv", "text/csv; charset=utf-8"],
    ["logo.png", "image/png"],
    ["photo.jpg", "image/jpeg"],
    ["photo.jpeg", "image/jpeg"],
    ["anim.gif", "image/gif"],
    ["art.svg", "image/svg+xml"],
    ["hero.webp", "image/webp"],
    ["hero.avif", "image/avif"],
    ["favicon.ico", "image/x-icon"],
    ["paper.pdf", "application/pdf"],
    ["font.woff", "font/woff"],
    ["font.woff2", "font/woff2"],
    ["font.ttf", "font/ttf"],
    ["legacy.eot", "application/vnd.ms-fontobject"],
    ["font.otf", "font/otf"],
    ["clip.mp4", "video/mp4"],
    ["clip.webm", "video/webm"],
    ["song.mp3", "audio/mpeg"],
    ["sound.wav", "audio/wav"],
    ["audio.ogg", "audio/ogg"]
  ];

  it("resolves every known extension to its served Content-Type", () => {
    for (const [file, type] of EXTENSION_MATRIX) {
      expect(getServedContentType(file), `content-type for ${file}`).toBe(type);
    }
  });

  it("is case-insensitive on the extension", () => {
    expect(getServedContentType("UPPER.PNG")).toBe("image/png");
    expect(getServedContentType("styles.CSS")).toBe("text/css; charset=utf-8");
  });

  it("falls through to octet-stream for unknown / extensionless files", () => {
    expect(getServedContentType("archive.bin")).toBe("application/octet-stream");
    expect(getServedContentType("Makefile")).toBe("application/octet-stream");
    expect(getServedContentType("README")).toBe("application/octet-stream");
  });

  it("keeps .mjs off the octet-stream fall-through (module loads)", () => {
    expect(getServedContentType("m.mjs")).toBe("application/javascript; charset=utf-8");
    expect(SERVED_CONTENT_TYPES[".mjs"]).toBe("application/javascript; charset=utf-8");
  });
});

describe("app serving security headers", () => {
  it("emits the load-bearing opaque-origin CSP (sandbox, NO allow-same-origin)", () => {
    const headers = servedContentHeaders();
    expect(headers["Content-Security-Policy"]).toBe("sandbox allow-scripts");
    expect(headers["Content-Security-Policy"]).not.toContain("allow-same-origin");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Referrer-Policy"]).toBe("no-referrer");
    expect(headers).not.toHaveProperty("Content-Disposition");
    expect(headers["Content-Security-Policy"]).not.toContain("default-src");
  });
});

describe("app not-found page", () => {
  it("renders a home link only when a site root path is supplied", () => {
    const withLink = renderNotFoundPage("/u/example/blog/");
    expect(withLink).toContain('href="/u/example/blog/"');
    expect(withLink).toContain("Go to site home");

    const withoutLink = renderNotFoundPage();
    expect(withoutLink).not.toContain("Go to site home");
  });

  it("escapes the site root path into the href attribute", () => {
    const html = renderNotFoundPage('/u/example/"><script>/');
    expect(html).not.toContain('"><script>');
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("is a noindex, zero-JS document", () => {
    const html = renderNotFoundPage();
    expect(html).toContain('name="robots" content="noindex"');
    expect(html).not.toContain("<script");
  });
});

describe("app looksLikePageNavigation", () => {
  it("treats an Accept: text/html request as a navigation regardless of path", () => {
    expect(looksLikePageNavigation("text/html", "some.css")).toBe(true);
    expect(looksLikePageNavigation("text/html,*/*", "logo.png")).toBe(true);
  });

  it("treats document-shaped paths as navigations even without an html Accept", () => {
    expect(looksLikePageNavigation("*/*", "")).toBe(true);
    expect(looksLikePageNavigation("*/*", "docs/")).toBe(true);
    expect(looksLikePageNavigation("*/*", "about.html")).toBe(true);
    expect(looksLikePageNavigation(null, "about.htm")).toBe(true);
  });

  it("treats asset requests as non-navigations", () => {
    expect(looksLikePageNavigation("image/png,*/*", "logo.png")).toBe(false);
    expect(looksLikePageNavigation(undefined, "app.js")).toBe(false);
  });
});
