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
  return match ? CONTENT_TYPES[match[0]] || "application/octet-stream" : "application/octet-stream";
}

export function isTextContentType(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType.includes("javascript") ||
    contentType.includes("json") ||
    contentType.includes("xml")
  );
}

export function addCacheBusterToHtml(html: string, version?: string): string {
  const value = version || Date.now().toString();

  return html
    .replace(
      /(<link[^>]*href=["'])(?!https?:\/\/)([^"'?]+)(["'][^>]*>)/gi,
      `$1$2?v=${value}$3`
    )
    .replace(
      /(<script[^>]*src=["'])(?!https?:\/\/)([^"'?]+)(["'][^>]*>)/gi,
      `$1$2?v=${value}$3`
    )
    .replace(
      /(<img[^>]*src=["'])(?!https?:\/\/)([^"'?]+)(["'][^>]*>)/gi,
      `$1$2?v=${value}$3`
    );
}

export function buildFileTree(files: StorageFile[]): ProjectTreeNode[] {
  const tree: Record<string, any> = {};

  for (const file of files) {
    const parts = file.path.split("/");
    let current = tree;

    parts.forEach((part, index) => {
      if (index === parts.length - 1) {
        current._files ||= [];
        current._files.push({
          name: file.name,
          path: file.path,
          type: "file",
          contentType: file.contentType,
          isText: file.isText
        });
        return;
      }

      current[part] ||= {};
      current = current[part];
    });
  }

  function toArray(node: Record<string, any>, parentPath = ""): ProjectTreeNode[] {
    const entries: ProjectTreeNode[] = [];

    for (const key of Object.keys(node)) {
      if (key === "_files") {
        continue;
      }

      const dirPath = parentPath ? `${parentPath}/${key}` : key;
      entries.push({
        name: key,
        path: dirPath,
        type: "directory",
        children: toArray(node[key], dirPath),
      });
    }

    if (Array.isArray(node._files)) {
      entries.push(...node._files);
    }

    return entries;
  }

  return toArray(tree);
}
