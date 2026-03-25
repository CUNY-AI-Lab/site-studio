import { describe, it, expect } from "vitest";
import { sanitizeProjectId, sanitizeFilePath, getContentType, isTextContentType, addCacheBusterToHtml, buildFileTree } from "./path";
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
  it("adds version to link hrefs", () => {
    const html = '<link rel="stylesheet" href="styles.css">';
    const result = addCacheBusterToHtml(html, "123");
    expect(result).toBe('<link rel="stylesheet" href="styles.css?v=123">');
  });

  it("adds version to script srcs", () => {
    const html = '<script src="app.js"></script>';
    const result = addCacheBusterToHtml(html, "123");
    expect(result).toBe('<script src="app.js?v=123"></script>');
  });

  it("adds version to img srcs", () => {
    const html = '<img src="photo.png">';
    const result = addCacheBusterToHtml(html, "123");
    expect(result).toBe('<img src="photo.png?v=123">');
  });

  it("does not modify external URLs", () => {
    const html = '<link href="https://cdn.example.com/style.css">';
    const result = addCacheBusterToHtml(html, "123");
    expect(result).toBe(html);
  });

  it("generates timestamp when no version provided", () => {
    const html = '<link href="styles.css">';
    const result = addCacheBusterToHtml(html);
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
