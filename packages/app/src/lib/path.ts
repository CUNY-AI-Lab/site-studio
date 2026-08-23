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
  extraParams: Record<string, string> = {},
  rootPath?: string,
  documentPath?: string
): string {
  const value = version || Date.now().toString();
  const params = { v: value, ...extraParams };

  return rewriteLocalHtmlUrls(
    html,
    (url) => addQueryParams(rewriteRootRelativeUrl(url, rootPath), params),
    { includeRootRelative: Boolean(rootPath), documentPath }
  );
}

const URI_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const RAW_HTML_TAGS = new Set(["script", "style", "textarea", "title"]);

type HtmlRewriteOptions = {
  includeRootRelative?: boolean;
  documentPath?: string;
};

type UrlRewrite = (url: string) => string;

function isUrlAttribute(name: string): boolean {
  const lower = name.toLowerCase();
  if (["href", "src", "xlink:href", "poster", "action", "formaction", "data"].includes(lower)) return true;
  if (lower.startsWith("data-")) {
    const suffix = lower.slice("data-".length);
    return suffix === "background"
      || suffix === "background-image"
      || suffix === "image"
      || /(?:^|[-_:])(?:href|poster|src|url)(?:$|[-_:])/.test(suffix);
  }
  return false;
}

function isSrcsetAttribute(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "srcset" || lower === "data-srcset" || lower.endsWith("-srcset");
}

function isLocalPreviewUrl(value: string, includeRootRelative = false): boolean {
  const trimmed = value.trim();
  const isProtocolRelative = trimmed.startsWith("//");
  const isRootRelative = trimmed.startsWith("/") && !isProtocolRelative;
  return (
    trimmed.length > 0 &&
    !trimmed.startsWith("#") &&
    !isProtocolRelative &&
    (!isRootRelative || includeRootRelative) &&
    !URI_SCHEME_RE.test(trimmed)
  );
}

function rewriteLocalHtmlUrls(
  html: string,
  rewrite: UrlRewrite,
  options: HtmlRewriteOptions = {}
): string {
  let output = "";
  let cursor = 0;

  while (cursor < html.length) {
    const tagStart = html.indexOf("<", cursor);
    if (tagStart < 0) {
      output += html.slice(cursor);
      break;
    }
    output += html.slice(cursor, tagStart);

    if (html.startsWith("<!--", tagStart)) {
      const commentEnd = html.indexOf("-->", tagStart + 4);
      if (commentEnd < 0) {
        output += html.slice(tagStart);
        break;
      }
      const end = commentEnd + 3;
      output += html.slice(tagStart, end);
      cursor = end;
      continue;
    }

    const tagEnd = findHtmlTagEnd(html, tagStart + 1);
    if (tagEnd < 0) {
      output += html.slice(tagStart);
      break;
    }

    const tag = html.slice(tagStart, tagEnd + 1);
    const parsedTag = parseHtmlTag(tag);
    output += parsedTag
      ? rewriteHtmlTag(tag, rewrite, options)
      : tag;
    cursor = tagEnd + 1;

    if (!parsedTag || parsedTag.closing || parsedTag.selfClosing || !RAW_HTML_TAGS.has(parsedTag.name)) {
      continue;
    }

    const rawClose = findRawHtmlClosingTag(html, cursor, parsedTag.name);
    if (rawClose < 0) {
      const body = html.slice(cursor);
      output += parsedTag.name === "style"
        ? rewriteCssUrls(body, rewrite, options)
        : body;
      break;
    }
    const body = html.slice(cursor, rawClose);
    output += parsedTag.name === "style"
      ? rewriteCssUrls(body, rewrite, options)
      : body;
    cursor = rawClose;
  }

  return output;
}

function findHtmlTagEnd(html: string, start: number): number {
  let quote: string | null = null;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function findRawHtmlClosingTag(html: string, start: number, tagName: string): number {
  const closing = new RegExp(`<\\/\\s*${tagName}\\b`, "ig");
  closing.lastIndex = start;
  const match = closing.exec(html);
  return match?.index ?? -1;
}

function parseHtmlTag(tag: string): { name: string; closing: boolean; selfClosing: boolean } | null {
  const match = /^<\s*(\/?|\?)\s*([A-Za-z][A-Za-z0-9:_-]*)/.exec(tag);
  if (!match) return null;
  return {
    name: match[2].toLowerCase(),
    closing: match[1] === "/",
    selfClosing: match[1] === "?" || /\/\s*>$/.test(tag)
  };
}

function rewriteHtmlTag(
  tag: string,
  rewrite: UrlRewrite,
  options: HtmlRewriteOptions
): string {
  const tagMatch = /^<\s*(?:\/?|\?)\s*[A-Za-z][A-Za-z0-9:_-]*/.exec(tag);
  if (!tagMatch) return tag;

  let output = tag.slice(0, tagMatch[0].length);
  let cursor = tagMatch[0].length;
  while (cursor < tag.length) {
    if (tag[cursor] === ">") {
      output += tag.slice(cursor);
      break;
    }

    const attributeStart = cursor;
    while (cursor < tag.length && /\s/.test(tag[cursor])) cursor += 1;
    if (cursor >= tag.length) {
      output += tag.slice(attributeStart);
      break;
    }
    if (tag[cursor] === "/") {
      output += tag.slice(attributeStart);
      break;
    }

    const nameStart = cursor;
    while (cursor < tag.length && !/[\s=/>]/.test(tag[cursor])) cursor += 1;
    if (cursor === nameStart) {
      output += tag.slice(attributeStart, cursor + 1);
      cursor += 1;
      continue;
    }

    const attributeName = tag.slice(nameStart, cursor);
    let equals = cursor;
    while (equals < tag.length && /\s/.test(tag[equals])) equals += 1;
    if (tag[equals] !== "=") {
      output += tag.slice(attributeStart, equals);
      cursor = equals;
      continue;
    }

    let valueStart = equals + 1;
    while (valueStart < tag.length && /\s/.test(tag[valueStart])) valueStart += 1;
    if (valueStart >= tag.length) {
      output += tag.slice(attributeStart);
      break;
    }

    const quote = tag[valueStart] === "\"" || tag[valueStart] === "'" ? tag[valueStart] : null;
    const contentStart = quote ? valueStart + 1 : valueStart;
    let valueEnd = contentStart;
    if (quote) {
      while (valueEnd < tag.length && tag[valueEnd] !== quote) valueEnd += 1;
    } else {
      while (valueEnd < tag.length && !/[\s>]/.test(tag[valueEnd])) valueEnd += 1;
    }

    const rawValue = tag.slice(contentStart, valueEnd);
    const rewritten = rewriteHtmlAttribute(attributeName, rawValue, rewrite, options);
    output += tag.slice(attributeStart, contentStart);
    output += rewritten;
    if (quote && valueEnd < tag.length) output += quote;
    cursor = quote && valueEnd < tag.length ? valueEnd + 1 : valueEnd;
  }

  return output;
}

function rewriteHtmlAttribute(
  name: string,
  value: string,
  rewrite: UrlRewrite,
  options: HtmlRewriteOptions
): string {
  if (isSrcsetAttribute(name)) {
    return rewriteSrcset(value, rewrite, options);
  }
  if (name.toLowerCase() === "style") {
    return rewriteCssUrls(value, rewrite, options);
  }
  if (!isUrlAttribute(name)) return value;
  return rewriteLocalUrlValue(value, rewrite, options);
}

function rewriteLocalUrlValue(value: string, rewrite: UrlRewrite, options: HtmlRewriteOptions): string {
  const { leading, core, trailing } = splitTrimmed(value);
  if (!isLocalPreviewUrl(core, options.includeRootRelative)) return value;
  if (options.documentPath && !resolvePreviewResourcePath(core, options.documentPath)) return value;
  return `${leading}${rewrite(core)}${trailing}`;
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

function rewriteSrcset(value: string, rewrite: UrlRewrite, options: HtmlRewriteOptions): string {
  const candidates = splitSrcsetCandidates(value);
  return candidates.map((candidate) => {
    const { leading, core, trailing } = splitTrimmed(candidate);
    if (!core) return candidate;
    const match = /^(?:"([^"]*)"|'([^']*)'|(\S+))([\s\S]*)$/.exec(core);
    if (!match) return candidate;
    const url = match[1] ?? match[2] ?? match[3];
    const quote = match[1] !== undefined ? '"' : match[2] !== undefined ? "'" : "";
    const rewritten = rewriteLocalUrlValue(url, rewrite, options);
    return `${leading}${quote}${rewritten}${quote}${match[4]}${trailing}`;
  }).join(",");
}

function splitSrcsetCandidates(value: string): string[] {
  const candidates: string[] = [];
  let start = 0;
  let index = 0;
  let quote: string | null = null;
  let parentheses = 0;
  let dataUrlStart = findDataUrlStart(value, start);
  let dataUrl = dataUrlStart >= 0;
  let dataUrlHasWhitespace = false;
  while (index < value.length) {
    const character = value[index];
    if (quote) {
      if (character === quote && !isEscapedAt(value, index)) quote = null;
      index += 1;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === "(") {
      parentheses += 1;
    } else if (character === ")") {
      parentheses = Math.max(0, parentheses - 1);
    } else if (dataUrl && index >= dataUrlStart && /\s/.test(character)) {
      dataUrlHasWhitespace = true;
    } else if (
      character === ","
      && parentheses === 0
      && (!dataUrl || dataUrlHasWhitespace || /\s/.test(value[index + 1] ?? ""))
    ) {
      // A data URL owns its payload commas. A comma followed by whitespace
      // still unambiguously starts the next candidate when the data URL has
      // no descriptor.
      candidates.push(value.slice(start, index));
      start = index + 1;
      index = start;
      quote = null;
      parentheses = 0;
      dataUrlStart = findDataUrlStart(value, start);
      dataUrl = dataUrlStart >= 0;
      dataUrlHasWhitespace = false;
      continue;
    }
    index += 1;
  }
  candidates.push(value.slice(start));
  return candidates;
}

function findDataUrlStart(value: string, start: number): number {
  let index = start;
  while (index < value.length && /\s/.test(value[index])) index += 1;
  return value.slice(index, index + 5).toLowerCase() === "data:" ? index : -1;
}

function rewriteCssUrls(css: string, rewrite: UrlRewrite, options: HtmlRewriteOptions = {}): string {
  let output = "";
  let cursor = 0;
  while (cursor < css.length) {
    if (css.startsWith("/*", cursor)) {
      const end = css.indexOf("*/", cursor + 2);
      if (end < 0) {
        output += css.slice(cursor);
        break;
      }
      const commentEnd = end + 2;
      output += css.slice(cursor, commentEnd);
      cursor = commentEnd;
      continue;
    }
    if (css[cursor] === "\"" || css[cursor] === "'") {
      const end = findCssStringEnd(css, cursor);
      output += css.slice(cursor, end);
      cursor = end;
      continue;
    }

    const rewrittenImport = rewriteCssImportString(css, cursor, rewrite, options);
    if (rewrittenImport) {
      output += rewrittenImport.text;
      cursor = rewrittenImport.end;
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
    if (close < 0) {
      output += css.slice(open + 1);
      break;
    }
    const inner = css.slice(open + 1, close);
    output += rewriteCssUrlArgument(inner, rewrite, options);
    output += ")";
    cursor = close + 1;
  }
  return output;
}

function rewriteCssImportString(
  css: string,
  start: number,
  rewrite: UrlRewrite,
  options: HtmlRewriteOptions
) {
  if (css.slice(start, start + 7).toLowerCase() !== "@import") return null;
  const afterName = css[start + 7];
  if (afterName && /[A-Za-z0-9_-]/.test(afterName)) return null;

  let quoteStart = start + 7;
  while (quoteStart < css.length && /\s/.test(css[quoteStart])) quoteStart += 1;
  const quote = css[quoteStart];
  if (quote !== "\"" && quote !== "'") return null;

  const end = findCssStringEnd(css, quoteStart);
  if (end <= quoteStart || css[end - 1] !== quote) return null;
  const rawUrl = css.slice(quoteStart + 1, end - 1);
  const rewritten = rewriteLocalUrlValue(rawUrl, rewrite, options);
  return {
    end,
    text: `${css.slice(start, quoteStart + 1)}${rewritten}${quote}`
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
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === ")" && !isEscapedAt(css, index)) {
      return index;
    }
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
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function rewriteCssUrlArgument(inner: string, rewrite: UrlRewrite, options: HtmlRewriteOptions): string {
  const { leading, core, trailing } = splitTrimmed(inner);
  if (!core) return inner;
  // CSS escapes can change token boundaries (for example `\)` inside an
  // unquoted URL). Leave those authored tokens byte-for-byte intact until a
  // CSS tokenizer is available instead of guessing at their decoded path.
  if (core.includes("\\") || hasUnsafeCssTokenCharacter(core)) return inner;
  const quote = core[0] === "\"" || core[0] === "'" ? core[0] : null;
  const url = quote && core.endsWith(quote) ? core.slice(1, -1) : core;
  const rewritten = rewriteLocalUrlValue(url, rewrite, options);
  const wrapped = quote && core.endsWith(quote) ? `${quote}${rewritten}${quote}` : rewritten;
  return `${leading}${wrapped}${trailing}`;
}

export function addCacheBusterToCss(
  css: string,
  version?: string,
  extraParams: Record<string, string> = {},
  rootPath?: string,
  documentPath?: string
): string {
  const value = version || Date.now().toString();
  const params = { v: value, ...extraParams };
  return rewriteCssUrls(
    css,
    (url) => addQueryParams(rewriteRootRelativeUrl(url, rootPath), params),
    { includeRootRelative: Boolean(rootPath), documentPath }
  );
}

function normalizeRootPath(rootPath: string): string {
  const trimmed = rootPath.trim();
  if (!trimmed) return "/";
  const rooted = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return `${rooted.replace(/\/+$/, "")}/`;
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

  const hashIndex = core.indexOf("#");
  const fragment = hashIndex >= 0 ? core.slice(hashIndex) : "";
  const beforeFragment = hashIndex >= 0 ? core.slice(0, hashIndex) : core;
  const queryIndex = beforeFragment.indexOf("?");
  const path = queryIndex >= 0 ? beforeFragment.slice(0, queryIndex) : beforeFragment;
  const suffix = queryIndex >= 0
    ? `${beforeFragment.slice(queryIndex)}${fragment}`
    : fragment;
  const normalizedPath = normalizeRootRelativePath(path);
  if (normalizedPath === null) return value;
  const trailingSlash = path.length > 1 && path.endsWith("/") ? "/" : "";
  const root = normalizeRootPath(rootPath);
  return `${leading}${root}${normalizedPath}${trailingSlash}${suffix}${trailing}`;
}

function normalizeRootRelativePath(path: string): string | null {
  const segments: string[] = [];
  for (const rawSegment of path.slice(1).split("/")) {
    if (rawSegment.includes("%")) return null;
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return null;
    }
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    if (isUnsafeDecodedPathSegment(segment)) return null;
    segments.push(segment);
  }
  return segments.join("/");
}

function isUnsafeDecodedPathSegment(segment: string): boolean {
  for (const character of segment) {
    if ("\\/?#%\"'<> &".includes(character)) return true;
    const code = character.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

function hasUnsafeCssTokenCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Rewrite root-relative authored URLs to the canonical site mount. A static
 * document's `/styles.css` means "from this site's root", not from the app
 * origin; without this boundary rewrite it falls through to the SPA shell.
 */
export function rewriteRootRelativeHtmlUrls(html: string, rootPath: string): string {
  return rewriteLocalHtmlUrls(
    html,
    (url) => rewriteRootRelativeUrl(url, rootPath),
    { includeRootRelative: true }
  );
}

export function rewriteRootRelativeCssUrls(css: string, rootPath: string): string {
  return rewriteCssUrls(css, (url) => rewriteRootRelativeUrl(url, rootPath), {
    includeRootRelative: true
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
    const path = resolvePreviewResourcePath(value, documentPath);
    if (path) paths.add(path);
    return value;
  }, { includeRootRelative: true, documentPath });
  return [...paths].sort();
}

export function collectPreviewCssResourcePaths(css: string, documentPath: string): string[] {
  const paths = new Set<string>();
  rewriteCssUrls(css, (value) => {
    const path = resolvePreviewResourcePath(value, documentPath);
    if (path) paths.add(path);
    return value;
  }, { includeRootRelative: true, documentPath });
  return [...paths].sort();
}

function resolvePreviewResourcePath(value: string, documentPath: string): string | null {
  const trimmed = value.trim();
  if (!isLocalPreviewUrl(trimmed, true)) return null;
  const hashIndex = trimmed.indexOf("#");
  const beforeFragment = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed;
  const queryIndex = beforeFragment.indexOf("?");
  const pathPart = queryIndex >= 0 ? beforeFragment.slice(0, queryIndex) : beforeFragment;
  const rooted = pathPart.startsWith("/");
  const baseSegments = rooted
    ? []
    : documentPath.replace(/\\/g, "/").split("/").slice(0, -1).filter(Boolean);
  const segments = [...baseSegments];
  for (const rawSegment of pathPart.split("/")) {
    if (rawSegment.includes("%")) return null;
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return null;
    }
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    if (isUnsafeDecodedPathSegment(segment)) return null;
    segments.push(segment);
  }
  if (segments.length === 0) return "index.html";
  const resolved = segments.join("/");
  return pathPart.length > 1 && pathPart.endsWith("/") ? `${resolved}/` : resolved;
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
