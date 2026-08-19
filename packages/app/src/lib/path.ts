import { CONTENT_TYPES } from "./constants";
import type { ProjectTreeNode, StorageFile } from "../types";

export function sanitizeProjectId(name: string): string {
  const projectId = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (!projectId) {
    throw new Error("Project name must contain at least one letter or number");
  }

  return projectId;
}

export function sanitizeFilePath(filePath: string): string {
  const normalized = filePath
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");

  if (!normalized) {
    throw new Error("File path is required");
  }

  if (normalized.includes("\0") || normalized.includes("..")) {
    throw new Error("Invalid file path");
  }

  return normalized;
}

export function getContentType(filePath: string): string {
  const match = filePath.toLowerCase().match(/\.[^.]+$/);
  if (!match) return "application/octet-stream";
  const entry = Object.entries(CONTENT_TYPES).find(([extension]) => extension === match[0]);
  return entry?.[1] || "application/octet-stream";
}

export function isTextContentType(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType.includes("javascript") ||
    contentType.includes("json") ||
    contentType.includes("xml")
  );
}

export function addCacheBusterToHtml(
  html: string,
  version?: string,
  extraParams: Record<string, string> = {}
): string {
  const value = version || Date.now().toString();
  const params = { v: value, ...extraParams };

  return rewriteLocalHtmlUrls(html, (url) => addQueryParams(url, params));
}

const LOCAL_HTML_URL_RE =
  /(<(?:link|a)\b[^>]*\bhref=["']|<(?:script|img)\b[^>]*\bsrc=["'])([^"']+)(["'][^>]*>)/gi;
const URI_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

function isLocalPreviewUrl(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    !trimmed.startsWith("#") &&
    !trimmed.startsWith("/") &&
    !trimmed.startsWith("//") &&
    !URI_SCHEME_RE.test(trimmed)
  );
}

function rewriteLocalHtmlUrls(html: string, rewrite: (url: string) => string): string {
  return html.replace(LOCAL_HTML_URL_RE, (match, prefix: string, value: string, suffix: string) => {
    if (!isLocalPreviewUrl(value)) return match;
    return `${prefix}${rewrite(value)}${suffix}`;
  });
}

function addQueryParams(value: string, params: Record<string, string>): string {
  const hashIndex = value.indexOf("#");
  const fragment = hashIndex >= 0 ? value.slice(hashIndex) : "";
  const beforeFragment = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const queryIndex = beforeFragment.indexOf("?");
  const pathname = queryIndex >= 0 ? beforeFragment.slice(0, queryIndex) : beforeFragment;
  const search = new URLSearchParams(queryIndex >= 0 ? beforeFragment.slice(queryIndex + 1) : "");
  for (const [key, paramValue] of Object.entries(params)) {
    search.set(key, paramValue);
  }
  return `${pathname}?${search.toString()}${fragment}`;
}

/**
 * Resolve the authored relative URLs that a preview document may request.
 * Preview bearer grants are scoped to this set so a token visible to authored
 * JavaScript cannot read arbitrary, unlinked project files.
 */
export function collectPreviewResourcePaths(html: string, documentPath: string): string[] {
  const paths = new Set<string>();
  rewriteLocalHtmlUrls(html, (value) => {
    try {
      const resolved = new URL(value, `https://preview.invalid/${documentPath}`);
      const path = resolved.pathname.replace(/^\/+/, "");
      if (path) paths.add(path);
    } catch {
      // Preserve malformed authored markup. It will fail as a browser request,
      // but it must not turn the containing preview document into a 500.
    }
    return value;
  });
  return [...paths].sort();
}

export function buildFileTree(files: StorageFile[]): ProjectTreeNode[] {
  type TreeNode = {
    dirs: Record<string, TreeNode>;
    files: ProjectTreeNode[];
  };
  const tree: TreeNode = { dirs: {}, files: [] };

  for (const file of files) {
    const parts = file.path.split("/");
    let current = tree;

    parts.forEach((part, index) => {
      if (index === parts.length - 1) {
        current.files.push({
          name: file.name,
          path: file.path,
          type: "file",
          contentType: file.contentType,
          isText: file.isText
        });
        return;
      }

      current.dirs[part] ||= { dirs: {}, files: [] };
      current = current.dirs[part];
    });
  }

  function toArray(node: TreeNode, parentPath = ""): ProjectTreeNode[] {
    const entries: ProjectTreeNode[] = [];

    for (const key of Object.keys(node.dirs)) {
      const dirPath = parentPath ? `${parentPath}/${key}` : key;
      entries.push({
        name: key,
        path: dirPath,
        type: "directory",
        children: toArray(node.dirs[key], dirPath),
      });
    }

    entries.push(...node.files);

    return entries;
  }

  return toArray(tree);
}
