import { describe, it, expect } from "vitest";
import {
  sanitizeProjectId,
  sanitizeFilePath,
  getContentType,
  isTextContentType,
  addCacheBusterToCss,
  addCacheBusterToHtml,
  addCacheBusterToJavaScript,
  collectPreviewCssResourcePaths,
  collectPreviewJavaScriptResourcePaths,
  rewriteRootRelativeCssUrls,
  rewriteRootRelativeHtmlUrls,
  rewriteRootRelativeJavaScriptUrls,
  buildFileTree,
  collectPreviewResourcePaths
} from "./path";
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
  it("adds params to project links while preserving query and fragment", async () => {
    const html = [
      '<link href="styles.css?existing=1#ready">',
      '<script src="app.js"></script>',
      '<img src="photo.png">'
    ].join("");
    const result = await addCacheBusterToHtml(html, "123", { pt: "preview-token" });

    expect(result).toContain('href="styles.css?existing=1&v=123&pt=preview-token#ready"');
    expect(result).toContain('src="app.js?v=123&pt=preview-token"');
    expect(result).toContain('src="photo.png?v=123&pt=preview-token"');
  });

  it("rewrites and grants every local srcset and imagesrcset candidate", async () => {
    const html = [
      '<img srcset="images/small.jpg 1x, /images/large.jpg 2x, https://cdn.example/remote.jpg 3x">',
      '<link rel="preload" imagesrcset="images/card.jpg 400w, data:image/png;base64,AAAA 800w">'
    ].join("");
    const rewritten = await addCacheBusterToHtml(
      html,
      "123",
      { pt: "token" },
      "/preview/proj/",
      "pages/index.html"
    );

    expect(rewritten).toContain("images/small.jpg?v=123&pt=token 1x");
    expect(rewritten).toContain("/preview/proj/images/large.jpg?v=123&pt=token 2x");
    expect(rewritten).toContain("https://cdn.example/remote.jpg 3x");
    expect(rewritten).toContain("images/card.jpg?v=123&pt=token 400w");
    expect(rewritten).toContain("data:image/png;base64,AAAA 800w");
    expect(await collectPreviewResourcePaths(html, "pages/index.html", "/preview/proj/")).toEqual([
      "images/large.jpg",
      "pages/images/card.jpg",
      "pages/images/small.jpg"
    ]);
  });

  it("maps root navigation and rejects parent escapes", async () => {
    const html = '<a href="/">Home</a><script src="../outside.js"></script><img src="/../secret.png">';
    const result = await addCacheBusterToHtml(html, "123", { pt: "token" }, "/preview/proj/", "index.html");

    expect(result).toContain('href="/preview/proj/?v=123&pt=token"');
    expect(result).toContain('src="../outside.js"');
    expect(result).toContain('src="/../secret.png"');
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

  it("resolves later relative references from the first local base", async () => {
    const html = '<base href="assets/"><script src="app.js"></script>';
    const rewritten = await addCacheBusterToHtml(html, "123", { pt: "token" }, "/preview/proj/", "docs/index.html");
    expect(rewritten).toContain('<base href="/preview/proj/docs/assets/">');
    expect(rewritten).toContain('<script src="app.js?v=123&pt=token"></script>');
    expect(await collectPreviewResourcePaths(html, "docs/index.html")).toEqual(["docs/assets/app.js"]);
  });

  it.each(["", "#section"])("keeps a %j base on the current local document", async (baseHref) => {
    const html = `<base href="${baseHref}"><script src="app.js"></script><img src="/images/hero.png">`;
    const rewritten = await addCacheBusterToHtml(
      html,
      "123",
      { pt: "token" },
      "/site-studio/preview/proj/",
      "docs/index.html"
    );

    expect(rewritten).toContain(`<base href="${baseHref}">`);
    expect(rewritten).toContain('src="app.js?v=123&pt=token"');
    expect(rewritten).toContain('src="/site-studio/preview/proj/images/hero.png?v=123&pt=token"');
    const documentUrl = new URL(
      "/site-studio/preview/proj/docs/index.html",
      "https://preview.example"
    );
    const effectiveBase = new URL(baseHref, documentUrl);
    expect(effectiveBase.pathname).toBe("/site-studio/preview/proj/docs/index.html");
    expect(new URL("app.js", effectiveBase).pathname).toBe(
      "/site-studio/preview/proj/docs/app.js"
    );
    expect(await collectPreviewResourcePaths(html, "docs/index.html", "/site-studio/preview/proj/")).toEqual([
      "docs/app.js",
      "images/hero.png"
    ]);
  });

  it("does not double-mount an authored preview base or its child URLs", async () => {
    const html = [
      '<base href="/site-studio/preview/proj/docs/">',
      '<script src="app.js"></script>',
      '<img src="/site-studio/preview/proj/images/hero.png">'
    ].join("");
    const rewritten = await addCacheBusterToHtml(
      html,
      "123",
      { pt: "token" },
      "/site-studio/preview/proj/",
      "index.html"
    );

    expect(rewritten).toContain('<base href="/site-studio/preview/proj/docs/">');
    expect(rewritten).not.toContain("/site-studio/preview/proj/site-studio/preview/proj/");
    expect(rewritten).toContain('src="app.js?v=123&pt=token"');
    expect(rewritten).toContain(
      'src="/site-studio/preview/proj/images/hero.png?v=123&pt=token"'
    );
    expect(await collectPreviewResourcePaths(html, "index.html", "/site-studio/preview/proj/")).toEqual([
      "docs/app.js",
      "images/hero.png"
    ]);
  });

  it("keeps relative paths that collide with the ingress mount in project storage", async () => {
    const html = [
      '<base href="site-studio/preview/proj/">',
      '<link rel="stylesheet" href="styles.css">',
      '<script src="app.js"></script>'
    ].join("");
    const rewritten = await addCacheBusterToHtml(
      html,
      "123",
      { pt: "token" },
      "/site-studio/preview/proj/",
      "index.html"
    );

    expect(rewritten).toContain(
      '<base href="/site-studio/preview/proj/site-studio/preview/proj/">'
    );
    expect(rewritten).toContain('href="styles.css?v=123&pt=token"');
    expect(rewritten).toContain('src="app.js?v=123&pt=token"');
    expect(await collectPreviewResourcePaths(html, "index.html", "/site-studio/preview/proj/")).toEqual([
      "site-studio/preview/proj/app.js",
      "site-studio/preview/proj/styles.css"
    ]);
  });

  it("uses a nested document path when rewriting a published local base", async () => {
    const html = '<base href="assets/"><script src="app.js"></script>';
    const rewritten = await rewriteRootRelativeHtmlUrls(
      html,
      "/u/janedoe/site/",
      "docs/index.html"
    );
    expect(rewritten).toContain('<base href="/u/janedoe/site/docs/assets/">');
    expect(rewritten).toContain('<script src="app.js"></script>');
    const documentUrl = new URL("/u/janedoe/site/docs/index.html", "https://published.example");
    const effectiveBase = new URL("/u/janedoe/site/docs/assets/", documentUrl);
    expect(new URL("app.js", effectiveBase).pathname).toBe(
      "/u/janedoe/site/docs/assets/app.js"
    );
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
    expect(collectPreviewCssResourcePaths(
      ".hero { background: url(/site-studio/preview/proj/images/hero.png); }",
      "docs/styles.css",
      "/site-studio/preview/proj/"
    )).toEqual(["images/hero.png"]);
  });

  it("rewrites literal static and dynamic module imports without touching computed or bare imports", () => {
    const source = [
      'import value from "./nested.js";',
      "export { shared } from '../shared.js';",
      "const lazy = import('/lazy.js');",
      "const computed = import('./chunks/' + name);",
      "import 'package-name';",
      "import 'https://cdn.example/module.js';"
    ].join("\n");
    const rewritten = addCacheBusterToJavaScript(
      source,
      "123",
      { pt: "token" },
      "/preview/proj/",
      "scripts/main.js"
    );

    expect(rewritten).toContain('from "./nested.js?v=123&pt=token"');
    expect(rewritten).toContain("from '../shared.js?v=123&pt=token'");
    expect(rewritten).toContain('import("/preview/proj/lazy.js?v=123&pt=token")');
    expect(rewritten).toContain("import('./chunks/' + name)");
    expect(rewritten).toContain("import 'package-name'");
    expect(rewritten).toContain("import 'https://cdn.example/module.js'");
    expect(collectPreviewJavaScriptResourcePaths(source, "scripts/main.js", "/preview/proj/")).toEqual([
      "lazy.js",
      "scripts/nested.js",
      "shared.js"
    ]);

    const published = rewriteRootRelativeJavaScriptUrls(
      source,
      "/site-studio/u/janedoe/site/",
      "scripts/main.js"
    );
    expect(published).toContain('from "./nested.js"');
    expect(published).toContain("from '../shared.js'");
    expect(published).toContain('import("/site-studio/u/janedoe/site/lazy.js")');
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
