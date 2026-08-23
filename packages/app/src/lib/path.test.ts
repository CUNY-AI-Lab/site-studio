import { describe, it, expect } from "vitest";
import {
  sanitizeProjectId,
  sanitizeFilePath,
  getContentType,
  isTextContentType,
  addCacheBusterToCss,
  addCacheBusterToHtml,
  collectPreviewCssResourcePaths,
  rewriteRootRelativeHtmlUrls,
  rewriteRootRelativeCssUrls,
  buildFileTree,
  collectPreviewResourcePaths
} from "./path";
import { getServedContentType } from "./constants";
import type { StorageFile } from "../types";

describe("sanitizeProjectId", () => {
  it("lowercases and replaces special characters", () => {
    expect(sanitizeProjectId("My Cool Project!")).toBe("my-cool-project");
  });

  it("collapses multiple dashes", () => {
    expect(sanitizeProjectId("hello---world")).toBe("hello-world");
  });

  it("strips leading and trailing dashes", () => {
    expect(sanitizeProjectId("--test--")).toBe("test");
  });

  it("throws on empty result", () => {
    expect(() => sanitizeProjectId("!!!")).toThrow("must contain at least one letter or number");
  });

  it("preserves valid characters", () => {
    expect(sanitizeProjectId("my-project-123")).toBe("my-project-123");
  });

  it("handles unicode characters", () => {
    expect(sanitizeProjectId("café résumé")).toBe("caf-r-sum");
  });
});

describe("sanitizeFilePath", () => {
  it("strips leading slashes", () => {
    expect(sanitizeFilePath("/foo/bar.html")).toBe("foo/bar.html");
  });

  it("normalizes backslashes to forward slashes", () => {
    expect(sanitizeFilePath("foo\\bar\\baz.js")).toBe("foo/bar/baz.js");
  });

  it("collapses multiple slashes", () => {
    expect(sanitizeFilePath("foo///bar.html")).toBe("foo/bar.html");
  });

  it("trims whitespace", () => {
    expect(sanitizeFilePath("  index.html  ")).toBe("index.html");
  });

  it("throws on empty path", () => {
    expect(() => sanitizeFilePath("")).toThrow("File path is required");
  });

  it("throws on whitespace-only path", () => {
    expect(() => sanitizeFilePath("   ")).toThrow("File path is required");
  });

  it("throws on path traversal with ..", () => {
    expect(() => sanitizeFilePath("../etc/passwd")).toThrow("Invalid file path");
  });

  it("throws on embedded path traversal", () => {
    expect(() => sanitizeFilePath("foo/../../bar")).toThrow("Invalid file path");
  });

  it("throws on null bytes", () => {
    expect(() => sanitizeFilePath("foo\0bar")).toThrow("Invalid file path");
  });

  it("allows single dots in filenames", () => {
    expect(sanitizeFilePath("styles.css")).toBe("styles.css");
  });

  it("allows nested paths", () => {
    expect(sanitizeFilePath("pages/about/index.html")).toBe("pages/about/index.html");
  });
});

describe("getContentType", () => {
  it("returns correct type for HTML", () => {
    expect(getContentType("index.html")).toBe("text/html");
  });

  it("returns correct type for CSS", () => {
    expect(getContentType("styles.css")).toBe("text/css");
  });

  it("returns correct type for JavaScript", () => {
    expect(getContentType("app.js")).toBe("application/javascript");
  });

  it("returns correct type for PNG", () => {
    expect(getContentType("photo.png")).toBe("image/png");
  });

  it("returns octet-stream for unknown extensions", () => {
    expect(getContentType("file.xyz")).toBe("application/octet-stream");
  });

  it("returns octet-stream for no extension", () => {
    expect(getContentType("Makefile")).toBe("application/octet-stream");
  });

  it("is case-insensitive", () => {
    expect(getContentType("IMAGE.PNG")).toBe("image/png");
  });

  it("handles nested paths", () => {
    expect(getContentType("assets/images/logo.svg")).toBe("image/svg+xml");
  });
});

describe("getServedContentType (SS-8 authoritative serving map)", () => {
  it("adds charset to text types", () => {
    expect(getServedContentType("index.html")).toBe("text/html; charset=utf-8");
    expect(getServedContentType("styles.css")).toBe("text/css; charset=utf-8");
    expect(getServedContentType("app.js")).toBe("application/javascript; charset=utf-8");
    expect(getServedContentType("notes.md")).toBe("text/markdown; charset=utf-8");
    expect(getServedContentType("data.csv")).toBe("text/csv; charset=utf-8");
  });

  it("maps .mjs to application/javascript (never octet-stream)", () => {
    expect(getServedContentType("module.mjs")).toBe("application/javascript; charset=utf-8");
  });

  it("leaves binary types without a charset", () => {
    expect(getServedContentType("logo.png")).toBe("image/png");
    expect(getServedContentType("hero.avif")).toBe("image/avif");
    expect(getServedContentType("clip.mp4")).toBe("video/mp4");
    expect(getServedContentType("legacy.eot")).toBe("application/vnd.ms-fontobject");
  });

  it("is case-insensitive and falls back to octet-stream", () => {
    expect(getServedContentType("IMAGE.PNG")).toBe("image/png");
    expect(getServedContentType("file.xyz")).toBe("application/octet-stream");
    expect(getServedContentType("Makefile")).toBe("application/octet-stream");
  });
});

describe("isTextContentType", () => {
  it("returns true for text/* types", () => {
    expect(isTextContentType("text/html")).toBe(true);
    expect(isTextContentType("text/css")).toBe(true);
    expect(isTextContentType("text/plain")).toBe(true);
  });

  it("returns true for JavaScript", () => {
    expect(isTextContentType("application/javascript")).toBe(true);
  });

  it("returns true for JSON", () => {
    expect(isTextContentType("application/json")).toBe(true);
  });

  it("returns true for XML", () => {
    expect(isTextContentType("application/xml")).toBe(true);
  });

  it("returns false for binary types", () => {
    expect(isTextContentType("image/png")).toBe(false);
    expect(isTextContentType("application/pdf")).toBe(false);
    expect(isTextContentType("application/octet-stream")).toBe(false);
  });
});

describe("addCacheBusterToHtml", () => {
  it("adds version to link hrefs", async () => {
    const html = '<link rel="stylesheet" href="styles.css">';
    const result = await addCacheBusterToHtml(html, "123");
    expect(result).toBe('<link rel="stylesheet" href="styles.css?v=123">');
  });

  it("adds version to script srcs", async () => {
    const html = '<script src="app.js"></script>';
    const result = await addCacheBusterToHtml(html, "123");
    expect(result).toBe('<script src="app.js?v=123"></script>');
  });

  it("adds version to img srcs", async () => {
    const html = '<img src="photo.png">';
    const result = await addCacheBusterToHtml(html, "123");
    expect(result).toBe('<img src="photo.png?v=123">');
  });

  it("does not modify external URLs", async () => {
    const html = '<link href="https://cdn.example.com/style.css">';
    const result = await addCacheBusterToHtml(html, "123");
    expect(result).toBe(html);
  });

  it("adds cache and preview-token params to relative asset and navigation URLs", async () => {
    const html = [
      '<link href="styles.css">',
      '<script src="app.js"></script>',
      '<img src="photo.png">',
      '<a href="about.html">About</a>'
    ].join("");
    const result = await addCacheBusterToHtml(html, "123", { pt: "preview-token" });

    expect(result).toContain('href="styles.css?v=123&pt=preview-token"');
    expect(result).toContain('src="app.js?v=123&pt=preview-token"');
    expect(result).toContain('src="photo.png?v=123&pt=preview-token"');
    expect(result).toContain('href="about.html?v=123&pt=preview-token"');
  });

  it("leaves external and non-navigation URLs unchanged", async () => {
    const values = [
      "https://example.com/page",
      "http://example.com/page",
      "//example.com/page",
      "#section",
      "mailto:user@example.com",
      "tel:+12125550123",
      "javascript:void(0)",
      "data:text/plain,hello"
    ];
    const html = values.map((href) => `<a href="${href}">x</a>`).join("");

    expect(await addCacheBusterToHtml(html, "123", { pt: "token" })).toBe(html);
  });

  it("preserves existing queries and puts preview params before fragments", async () => {
    expect(await addCacheBusterToHtml(
      '<a href="about.html?existing=1#section">About</a>',
      "123",
      { pt: "token" }
    )).toBe('<a href="about.html?existing=1&v=123&pt=token#section">About</a>');
  });

  it("never appends a preview bearer to protocol-relative or root-relative destinations", async () => {
    const html = [
      '<img src="//attacker.example/pixel.png">',
      '<script src="/shared/app.js"></script>'
    ].join("");
    expect(await addCacheBusterToHtml(html, "123", { pt: "secret" })).toBe(html);
  });

  it("rewrites root-relative destinations to the supplied site mount", async () => {
    const html = [
      '<link href="/styles.css">',
      '<script src="/app.js?cache=1#ready"></script>',
      '<img src="//attacker.example/pixel.png">'
    ].join("");

    expect(await addCacheBusterToHtml(html, "123", { pt: "secret" }, "/preview/proj/")).toBe([
      '<link href="/preview/proj/styles.css?v=123&pt=secret">',
      '<script src="/preview/proj/app.js?cache=1&v=123&pt=secret#ready"></script>',
      '<img src="//attacker.example/pixel.png">'
    ].join(""));
    expect(await rewriteRootRelativeHtmlUrls(html, "/u/janedoe/site/")).toContain(
      '<link href="/u/janedoe/site/styles.css">'
    );
  });

  it("maps root navigation to index and rejects parent escapes", async () => {
    const html = '<a href="/">Home</a><script src="../outside.js"></script><img src="/../secret.png">';
    const result = await addCacheBusterToHtml(html, "123", { pt: "token" }, "/preview/proj/", "index.html");

    expect(result).toContain('href="/preview/proj/?v=123&pt=token"');
    expect(result).toContain('src="../outside.js"');
    expect(result).toContain('src="/../secret.png"');
    expect(await collectPreviewResourcePaths(html, "index.html")).toEqual(["index.html"]);
  });

  it("preserves root-relative trailing slashes for directory routes", async () => {
    const html = '<a href="/docs/">Docs</a>';
    const rewritten = await addCacheBusterToHtml(html, "123", { pt: "token" }, "/preview/proj/", "index.html");

    expect(rewritten).toContain('href="/preview/proj/docs/?v=123&pt=token"');
    expect(await collectPreviewResourcePaths(html, "index.html")).toEqual(["docs/"]);
    expect(await addCacheBusterToHtml('<a href="/foo/../">Root</a>', "123", { pt: "token" }, "/preview/proj/")
      ).toContain('href="/preview/proj/?v=123&pt=token"');
    const repeated = '<a href="/foo//">Repeated</a>';
    expect(await addCacheBusterToHtml(repeated, "123", { pt: "token" }, "/preview/proj/", "index.html"))
      .toBe(repeated);
    expect(await collectPreviewResourcePaths(repeated, "index.html")).toEqual([]);
  });

  it("uses browser URL semantics for query-only and dot-directory references", async () => {
    expect(await collectPreviewResourcePaths('<a href="?x">Current</a>', "docs/index.html")).toEqual([
      "docs/index.html"
    ]);
    expect(await collectPreviewResourcePaths('<a href="./?x">Directory</a>', "docs/index.html")).toEqual([
      "docs/"
    ]);
    expect(await collectPreviewResourcePaths('<a href=".">Directory</a>', "docs/index.html")).toEqual([
      "docs/"
    ]);
  });

  it("does not leak preview parameters through an external base", async () => {
    const html = '<base href="https://outside.example/"><script src="app.js"></script><img src="/logo.png">';
    const rewritten = await addCacheBusterToHtml(html, "123", { pt: "token" }, "/preview/proj/", "index.html");
    expect(rewritten).toContain('<script src="app.js"></script>');
    expect(rewritten).toContain('/preview/proj/logo.png?v=123&pt=token');
    expect(await collectPreviewResourcePaths(html, "index.html")).toEqual(["logo.png"]);
  });

  it("resolves later relative references from the first local base", async () => {
    const html = '<base href="assets/"><script src="app.js"></script>';
    const rewritten = await addCacheBusterToHtml(html, "123", { pt: "token" }, "/preview/proj/", "docs/index.html");
    expect(rewritten).toContain('<base href="/preview/proj/docs/assets/">');
    expect(rewritten).toContain('<script src="app.js?v=123&pt=token"></script>');
    expect(await collectPreviewResourcePaths(html, "docs/index.html")).toEqual(["docs/assets/app.js"]);
  });

  it("rewrites and scopes local CSS URLs while preserving external and data URLs", () => {
    const css = [
      '@import "/theme.css";',
      ".hero { background: url('/images/hero.png'); }",
      ".font { src: url(../fonts/body.woff2) format('woff2'); }",
      ".external { background: url(https://cdn.example.com/bg.png); }",
      ".data { background: url(data:image/png;base64,abc); }",
      "/* background: url(/comment.png); */",
      ".string { content: \"url(/string.png)\"; }"
    ].join("\n");
    const rewritten = addCacheBusterToCss(css, "123", { pt: "token" }, "/preview/proj/", "styles/main.css");

    expect(rewritten).toContain("url('/preview/proj/images/hero.png?v=123&pt=token')");
    expect(rewritten).toContain("url(../fonts/body.woff2?v=123&pt=token)");
    expect(rewritten).toContain("url(https://cdn.example.com/bg.png)");
    expect(rewritten).toContain("url(data:image/png;base64,abc)");
    expect(rewritten).toContain('@import "/preview/proj/theme.css?v=123&pt=token";');
    expect(rewritten).toContain("url(/comment.png)");
    expect(rewritten).toContain('content: "url(/string.png)"');
    expect(rewriteRootRelativeCssUrls(css, "/u/janedoe/site/")).toContain(
      "url('/u/janedoe/site/images/hero.png')"
    );
    expect(collectPreviewCssResourcePaths(css, "styles/main.css")).toEqual([
      "fonts/body.woff2",
      "images/hero.png",
      "theme.css"
    ]);
  });

  it("leaves data and external srcset candidates untouched", async () => {
    const html = '<img srcset="data:image/png;base64,abc, /images/hero.png 2x, https://cdn.example/hero.png 3x">';
    const rewritten = await addCacheBusterToHtml(html, "123", { pt: "token" }, "/preview/proj/", "index.html");
    expect(rewritten).toContain("data:image/png;base64,abc,");
    expect(rewritten).toContain("https://cdn.example/hero.png 3x");
    expect(rewritten).toContain("/preview/proj/images/hero.png?v=123&pt=token 2x");
  });

  it("fails closed for encoded root paths", async () => {
    const html = '<img src="/%3Fsecret.png"><img src="/images/safe.png">';
    expect(await addCacheBusterToHtml(html, "123", { pt: "token" }, "/preview/proj/", "index.html"))
      .toContain('src="/%3Fsecret.png"');
    expect(await collectPreviewResourcePaths(html, "index.html")).toEqual(["images/safe.png"]);
  });

  it("collects only relative project paths for a scoped preview grant", async () => {
    const html = [
      '<script src="app.js?x=1"></script>',
      '<a href="../about.html#team">About</a>',
      '<link href="/styles.css">',
      '<img src="//attacker.example/pixel.png">'
    ].join("");
    expect(await collectPreviewResourcePaths(html, "docs/index.html")).toEqual([
      "about.html",
      "docs/app.js",
      "styles.css"
    ]);
  });

  it("generates timestamp when no version provided", async () => {
    const html = '<link href="styles.css">';
    const result = await addCacheBusterToHtml(html);
    expect(result).toMatch(/styles\.css\?v=\d+/);
  });
});

describe("buildFileTree", () => {
  it("returns empty array for no files", () => {
    expect(buildFileTree([])).toEqual([]);
  });

  it("creates flat list for root-level files", () => {
    const files: StorageFile[] = [
      { path: "index.html", name: "index.html", size: 100, lastModified: "", isDirectory: false },
      { path: "styles.css", name: "styles.css", size: 50, lastModified: "", isDirectory: false }
    ];
    const tree = buildFileTree(files);
    expect(tree).toHaveLength(2);
    expect(tree[0]).toEqual({ name: "index.html", path: "index.html", type: "file" });
    expect(tree[1]).toEqual({ name: "styles.css", path: "styles.css", type: "file" });
  });

  it("creates nested directories", () => {
    const files: StorageFile[] = [
      { path: "pages/about.html", name: "about.html", size: 100, lastModified: "", isDirectory: false }
    ];
    const tree = buildFileTree(files);
    expect(tree).toHaveLength(1);
    expect(tree[0].type).toBe("directory");
    expect(tree[0].name).toBe("pages");
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children![0].name).toBe("about.html");
  });

  it("groups files under the same directory", () => {
    const files: StorageFile[] = [
      { path: "css/main.css", name: "main.css", size: 100, lastModified: "", isDirectory: false },
      { path: "css/reset.css", name: "reset.css", size: 50, lastModified: "", isDirectory: false }
    ];
    const tree = buildFileTree(files);
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("css");
    expect(tree[0].children).toHaveLength(2);
  });
});
