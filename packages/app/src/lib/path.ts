import { CONTENT_TYPES } from "./constants";
import type { ProjectTreeNode, StorageFile } from "../types";

const URI_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const PREVIEW_ORIGIN = "https://preview.invalid";

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

type MarkupState = {
  basePath: string;
  baseExternal: boolean;
  baseSeen: boolean;
  paths?: Set<string>;
};

type MarkupOptions = {
  documentPath: string;
  includeRootRelative: boolean;
  rootPath?: string;
};

type UrlRewrite = (url: string, state: MarkupState) => string;
type BaseResolution = { path: string | null; external: boolean };

export async function addCacheBusterToHtml(
  html: string,
  version?: string,
  extraParams: Record<string, string> = {},
  rootPath?: string,
  documentPath = "index.html"
): Promise<string> {
  const params = { v: version || Date.now().toString(), ...extraParams };
  return rewriteMarkup(
    html,
    (url) => addQueryParams(rewriteRootRelativeUrl(url, rootPath), params),
    { documentPath, includeRootRelative: Boolean(rootPath), rootPath }
  );
}

async function rewriteMarkup(
  markup: string,
  rewrite: UrlRewrite,
  options: MarkupOptions,
  paths?: Set<string>
): Promise<string> {
  const state: MarkupState = {
    basePath: options.documentPath,
    baseExternal: false,
    baseSeen: false,
    paths
  };
  let styleText = "";

  const rewriter = new HTMLRewriter()
    .on("*", {
      element(element) {
        const tagName = element.tagName.toLowerCase();
        const attributes = Array.from(element.attributes, (attribute) => {
          if (Array.isArray(attribute)) {
            return { name: attribute[0], value: attribute[1] };
          }
          return { name: attribute.name, value: attribute.value };
        });
        for (const attribute of attributes) {
          const { name, value } = attribute;
          const lowerName = name.toLowerCase();
          if (tagName === "base" && lowerName === "href" && !state.baseSeen) {
            state.baseSeen = true;
            const base = resolveBaseHref(value, state.basePath);
            if (base.external) {
              state.baseExternal = true;
            } else if (base.path !== null) {
              state.basePath = base.path;
              if (options.rootPath) {
                element.setAttribute(name, mountPath(options.rootPath, base.path));
              }
            }
            continue;
          }
          if (tagName === "base" && lowerName === "href") continue;

          const rewritten = rewriteMarkupAttribute(
            name,
            value,
            state,
            options,
            rewrite
          );
          if (rewritten !== value) element.setAttribute(name, rewritten);
        }
      }
    })
    .on("style", {
      text(text) {
        styleText += text.text;
        if (!text.lastInTextNode) {
          text.remove();
          return;
        }
        const rewritten = rewriteCssUrls(
          styleText,
          (url) => rewriteMarkupUrl(url, state, options, rewrite)
        );
        text.replace(rewritten, { html: true });
        styleText = "";
      }
    });

  return rewriter.transform(new Response(markup)).text();
}

function rewriteMarkupAttribute(
  name: string,
  value: string,
  state: MarkupState,
  options: MarkupOptions,
  rewrite: UrlRewrite
): string {
  const lower = name.toLowerCase();
  if (lower === "style") {
    return rewriteCssUrls(value, (url) => rewriteMarkupUrl(url, state, options, rewrite));
  }
  if (isSrcsetAttribute(lower)) {
    return rewriteSrcset(value, (url) => rewriteMarkupUrl(url, state, options, rewrite));
  }
  if (!isUrlAttribute(lower)) return value;
  return rewriteMarkupUrl(value, state, options, rewrite);
}

function rewriteMarkupUrl(
  value: string,
  state: MarkupState,
  options: MarkupOptions,
  rewrite: UrlRewrite
): string {
  const { leading, core, trailing } = splitTrimmed(value);
  if (!isLocalUrl(core, options.includeRootRelative)) return value;
  if (state.baseExternal && !core.startsWith("/")) return value;
  const path = resolvePreviewResourcePath(core, state.basePath);
  if (!path) return value;
  state.paths?.add(path);
  return `${leading}${rewrite(core, state)}${trailing}`;
}

function isUrlAttribute(name: string): boolean {
  if (["href", "src", "xlink:href", "poster", "action", "formaction", "data"].includes(name)) return true;
  if (!name.startsWith("data-")) return false;
  const suffix = name.slice(5);
  return suffix === "background"
    || suffix === "background-image"
    || suffix === "image"
    || /(?:^|[-_:])(?:href|poster|src|url)(?:$|[-_:])/.test(suffix);
}

function isSrcsetAttribute(name: string): boolean {
  return name === "srcset" || name === "data-srcset" || name.endsWith("-srcset");
}

function isLocalUrl(value: string, includeRootRelative: boolean): boolean {
  const trimmed = value.trim();
  const rootRelative = trimmed.startsWith("/") && !trimmed.startsWith("//");
  return trimmed.length > 0
    && !trimmed.startsWith("#")
    && !trimmed.startsWith("//")
    && (!rootRelative || includeRootRelative)
    && !URI_SCHEME_RE.test(trimmed);
}

function resolveBaseHref(value: string, documentPath: string): BaseResolution {
  const trimmed = value.trim();
  if (trimmed.startsWith("//") || URI_SCHEME_RE.test(trimmed)) {
    return { path: null, external: true };
  }
  if (!isLocalUrl(trimmed, true)) return { path: documentPath, external: false };
  const pathPart = stripUrlPath(trimmed);
  if (hasPathEscape(pathPart, documentPath)) return { path: null, external: false };
  try {
    const pathname = new URL(trimmed, `${PREVIEW_ORIGIN}/${documentPath}`).pathname;
    if (pathname.includes("%")) return { path: null, external: false };
    return { path: pathname === "/" ? "" : pathname.slice(1), external: false };
  } catch {
    return { path: null, external: false };
  }
}

function resolvePreviewResourcePath(value: string, documentPath: string): string | null {
  const trimmed = value.trim();
  if (!isLocalUrl(trimmed, true)) return null;
  const pathPart = stripUrlPath(trimmed);
  if (hasPathEscape(pathPart, documentPath)) return null;
  try {
    const pathname = new URL(trimmed, `${PREVIEW_ORIGIN}/${documentPath}`).pathname;
    if (pathname.includes("%")) return null;
    return pathname === "/" ? "index.html" : pathname.slice(1);
  } catch {
    return null;
  }
}

function stripUrlPath(value: string): string {
  const hash = value.indexOf("#");
  const beforeFragment = hash >= 0 ? value.slice(0, hash) : value;
  const query = beforeFragment.indexOf("?");
  return query >= 0 ? beforeFragment.slice(0, query) : beforeFragment;
}

function hasPathEscape(pathPart: string, documentPath?: string): boolean {
  const pathWithoutRoot = pathPart.startsWith("/") ? pathPart.slice(1) : pathPart;
  if (pathWithoutRoot.includes("//") || pathPart.includes("%")) return true;
  let depth = pathPart.startsWith("/")
    ? 0
    : (documentPath?.split("/").slice(0, -1).filter(Boolean).length || 0);
  for (const segment of pathPart.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      depth -= 1;
      if (depth < 0) return true;
      continue;
    }
    if (segment.includes("\\") || segment.includes("\0") || /[?#"'<> &]/.test(segment)) return true;
    depth += 1;
  }
  return false;
}

function rewriteRootRelativeUrl(value: string, rootPath?: string): string {
  if (!rootPath) return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return value;
  const leadingLength = value.length - value.trimStart().length;
  const trailingLength = value.length - value.trimEnd().length;
  const leading = value.slice(0, leadingLength);
  const trailing = trailingLength > 0 ? value.slice(value.length - trailingLength) : "";
  const core = trailingLength > 0
    ? value.slice(leadingLength, value.length - trailingLength)
    : value.slice(leadingLength);
  const path = stripUrlPath(core);
  if (hasPathEscape(path)) return value;
  const hash = core.indexOf("#");
  const fragment = hash >= 0 ? core.slice(hash) : "";
  const beforeFragment = hash >= 0 ? core.slice(0, hash) : core;
  const query = beforeFragment.indexOf("?");
  const suffix = query >= 0
    ? `${beforeFragment.slice(query)}${fragment}`
    : fragment;
  try {
    const normalized = new URL(path, `${PREVIEW_ORIGIN}/`).pathname;
    if (normalized.includes("%")) return value;
    return `${leading}${mountPath(rootPath, normalized.slice(1))}${suffix}${trailing}`;
  } catch {
    return value;
  }
}

function mountPath(rootPath: string, filePath: string): string {
  const root = rootPath.trim().replace(/\/+$/, "") || "/";
  const suffix = filePath.replace(/^\/+/, "");
  return root === "/" ? `/${suffix}` : `${root}/${suffix}`;
}

function splitTrimmed(value: string) {
  const leadingLength = value.length - value.trimStart().length;
  const trailingLength = value.length - value.trimEnd().length;
  return {
    leading: value.slice(0, leadingLength),
    core: trailingLength > 0
      ? value.slice(leadingLength, value.length - trailingLength)
      : value.slice(leadingLength),
    trailing: trailingLength > 0 ? value.slice(value.length - trailingLength) : ""
  };
}

function rewriteSrcset(value: string, rewrite: (url: string) => string): string {
  return splitSrcsetCandidates(value).map((candidate) => {
    const { leading, core, trailing } = splitTrimmed(candidate);
    if (!core) return candidate;
    const match = /^(?:"([^"]*)"|'([^']*)'|(\S+))([\s\S]*)$/.exec(core);
    if (!match) return candidate;
    const url = match[1] ?? match[2] ?? match[3];
    const quote = match[1] !== undefined ? '"' : match[2] !== undefined ? "'" : "";
    const next = rewrite(url);
    return `${leading}${quote}${next}${quote}${match[4]}${trailing}`;
  }).join(",");
}

function splitSrcsetCandidates(value: string): string[] {
  const candidates: string[] = [];
  let start = 0;
  let quote: string | null = null;
  let parentheses = 0;
  let dataStart = findDataUrlStart(value, start);
  let dataWhitespace = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && !isEscapedAt(value, index)) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses = Math.max(0, parentheses - 1);
    else if (dataStart >= 0 && index >= dataStart && /\s/.test(character)) dataWhitespace = true;
    else if (character === "," && parentheses === 0 && (dataStart < 0 || dataWhitespace || /\s/.test(value[index + 1] ?? ""))) {
      candidates.push(value.slice(start, index));
      start = index + 1;
      dataStart = findDataUrlStart(value, start);
      dataWhitespace = false;
    }
  }
  candidates.push(value.slice(start));
  return candidates;
}

function findDataUrlStart(value: string, start: number): number {
  let index = start;
  while (index < value.length && /\s/.test(value[index])) index += 1;
  return value.slice(index, index + 5).toLowerCase() === "data:" ? index : -1;
}

function rewriteCssUrls(css: string, rewrite: (url: string) => string): string {
  let output = "";
  let cursor = 0;
  while (cursor < css.length) {
    if (css.startsWith("/*", cursor)) {
      const end = css.indexOf("*/", cursor + 2);
      if (end < 0) return output + css.slice(cursor);
      const next = end + 2;
      output += css.slice(cursor, next);
      cursor = next;
      continue;
    }
    if (css[cursor] === "\"" || css[cursor] === "'") {
      const end = findCssStringEnd(css, cursor);
      output += css.slice(cursor, end);
      cursor = end;
      continue;
    }
    const imported = rewriteCssImportString(css, cursor, rewrite);
    if (imported) {
      output += imported.text;
      cursor = imported.end;
      continue;
    }
    const open = findCssUrlOpen(css, cursor);
    if (open < 0) {
      output += css[cursor];
      cursor += 1;
      continue;
    }
    output += css.slice(cursor, open + 1);
    const close = findCssFunctionEnd(css, open + 1);
    if (close < 0) return output + css.slice(open + 1);
    const inner = css.slice(open + 1, close);
    output += rewriteCssUrlArgument(inner, rewrite);
    output += ")";
    cursor = close + 1;
  }
  return output;
}

function rewriteCssImportString(css: string, start: number, rewrite: (url: string) => string) {
  if (css.slice(start, start + 7).toLowerCase() !== "@import") return null;
  const afterName = css[start + 7];
  if (afterName && /[A-Za-z0-9_-]/.test(afterName)) return null;
  let quoteStart = start + 7;
  while (quoteStart < css.length && /\s/.test(css[quoteStart])) quoteStart += 1;
  const quote = css[quoteStart];
  if (quote !== "\"" && quote !== "'") return null;
  const end = findCssStringEnd(css, quoteStart);
  if (end <= quoteStart || css[end - 1] !== quote) return null;
  const url = css.slice(quoteStart + 1, end - 1);
  return {
    end,
    text: `${css.slice(start, quoteStart + 1)}${rewrite(url)}${quote}`
  };
}

function findCssUrlOpen(css: string, start: number): number {
  if (css.slice(start, start + 3).toLowerCase() !== "url") return -1;
  const previous = css[start - 1];
  if (previous && /[A-Za-z0-9_-]/.test(previous)) return -1;
  let open = start + 3;
  while (open < css.length && /\s/.test(css[open])) open += 1;
  return css[open] === "(" ? open : -1;
}

function findCssFunctionEnd(css: string, start: number): number {
  let quote: string | null = null;
  for (let index = start; index < css.length; index += 1) {
    const character = css[index];
    if (quote) {
      if (character === quote && !isEscapedAt(css, index)) quote = null;
    } else if (character === "\"" || character === "'") quote = character;
    else if (character === ")" && !isEscapedAt(css, index)) return index;
  }
  return -1;
}

function findCssStringEnd(css: string, start: number): number {
  const quote = css[start];
  for (let index = start + 1; index < css.length; index += 1) {
    if (css[index] === quote && !isEscapedAt(css, index)) return index + 1;
  }
  return css.length;
}

function isEscapedAt(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function rewriteCssUrlArgument(inner: string, rewrite: (url: string) => string): string {
  const { leading, core, trailing } = splitTrimmed(inner);
  if (!core || core.includes("\\") || /[\p{Cc}\p{Zs}]/u.test(core)) return inner;
  const quote = core[0] === "\"" || core[0] === "'" ? core[0] : null;
  const url = quote && core.endsWith(quote) ? core.slice(1, -1) : core;
  const next = rewrite(url);
  const wrapped = quote && core.endsWith(quote) ? `${quote}${next}${quote}` : next;
  return `${leading}${wrapped}${trailing}`;
}

export function addCacheBusterToCss(
  css: string,
  version?: string,
  extraParams: Record<string, string> = {},
  rootPath?: string,
  documentPath = "index.css"
): string {
  const params = { v: version || Date.now().toString(), ...extraParams };
  return rewriteCssUrls(css, (url) => {
    const path = resolvePreviewResourcePath(url, documentPath);
    if (!path) return url;
    return addQueryParams(rewriteRootRelativeUrl(url, rootPath), params);
  });
}

export async function rewriteRootRelativeHtmlUrls(html: string, rootPath: string): Promise<string> {
  return rewriteMarkup(
    html,
    (url) => rewriteRootRelativeUrl(url, rootPath),
    { documentPath: "index.html", includeRootRelative: true, rootPath }
  );
}

export function rewriteRootRelativeCssUrls(css: string, rootPath: string): string {
  return rewriteCssUrls(css, (url) => rewriteRootRelativeUrl(url, rootPath));
}

function addQueryParams(value: string, params: Record<string, string>): string {
  const hashIndex = value.indexOf("#");
  const fragment = hashIndex >= 0 ? value.slice(hashIndex) : "";
  const beforeFragment = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const queryIndex = beforeFragment.indexOf("?");
  const pathname = queryIndex >= 0 ? beforeFragment.slice(0, queryIndex) : beforeFragment;
  const search = new URLSearchParams(queryIndex >= 0 ? beforeFragment.slice(queryIndex + 1) : "");
  for (const [key, paramValue] of Object.entries(params)) search.set(key, paramValue);
  return `${pathname}?${search.toString()}${fragment}`;
}

export async function collectPreviewResourcePaths(html: string, documentPath: string): Promise<string[]> {
  const paths = new Set<string>();
  await rewriteMarkup(html, (url) => url, { documentPath, includeRootRelative: true }, paths);
  return [...paths].sort();
}

export function collectPreviewCssResourcePaths(css: string, documentPath: string): string[] {
  const paths = new Set<string>();
  rewriteCssUrls(css, (url) => {
    const path = resolvePreviewResourcePath(url, documentPath);
    if (path) paths.add(path);
    return url;
  });
  return [...paths].sort();
}

function buildFileTree(files: StorageFile[]): ProjectTreeNode[] {
  type TreeNode = { dirs: Record<string, TreeNode>; files: ProjectTreeNode[] };
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
      entries.push({ name: key, path: dirPath, type: "directory", children: toArray(node.dirs[key], dirPath) });
    }
    entries.push(...node.files);
    return entries;
  }

  return toArray(tree);
}

export { buildFileTree };
