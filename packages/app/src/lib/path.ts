import { getServedContentType } from "./content-types";
import type { ProjectTreeNode, StorageFile } from "../types";
import { parse as parseModuleSyntax } from "es-module-lexer/js";

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
    .replace(/\/{2,}/g, "/");

  if (!normalized) throw new Error("File path is required");
  if (normalized.includes("\0") || normalized.includes("..")) throw new Error("Invalid file path");
  return normalized;
}

export function getContentType(filePath: string): string {
  return getServedContentType(filePath).split(";")[0];
}

export function isTextContentType(contentType: string): boolean {
  return contentType.startsWith("text/")
    || contentType.includes("javascript")
    || contentType.includes("json")
    || contentType.includes("xml");
}

type MarkupState = {
  documentPath: string;
  baseExternal: boolean;
  baseSeen: boolean;
  paths?: Set<string>;
};

type MarkupOptions = {
  documentPath: string;
  includeRootRelative: boolean;
  rootPath?: string;
};

type ResolvedUrl = { path: string; url: URL };
type BaseResolution = ResolvedUrl & { alreadyMounted: boolean };
type UrlRewrite = (url: string, resolved: ResolvedUrl) => string;

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
    documentPath: options.documentPath,
    baseExternal: false,
    baseSeen: false,
    paths
  };
  let styleText = "";

  const rewriter = new HTMLRewriter()
    .on("*", {
      element(element) {
        const attributes = Array.from(element.attributes, (attribute) => {
          if (Array.isArray(attribute)) return { name: attribute[0], value: attribute[1] };
          return { name: attribute.name, value: attribute.value };
        });

        for (const { name, value } of attributes) {
          const lowerName = name.toLowerCase();
          if (element.tagName.toLowerCase() === "base" && lowerName === "href") {
            if (state.baseSeen) continue;
            state.baseSeen = true;
            const base = resolveBase(value, state.documentPath, options.rootPath);
            if (base === "external" || base === null) {
              // Preserve an authored external base exactly. Browser URL
              // resolution makes both relative and root-relative references
              // external once this base wins, so neither may receive a local
              // preview mount or bearer token. Invalid or escaping base URLs
              // fail closed by the same rule.
              state.baseExternal = true;
            } else if (base === "current") {
              // Empty and fragment-only base URLs resolve to the current
              // document URL. Preserve the authored value so the browser can
              // keep applying its fragment/query semantics while local
              // preview/publish rewriting continues from documentPath.
              state.baseExternal = false;
            } else if (base !== null) {
              state.baseExternal = false;
              state.documentPath = base.path;
              if (options.rootPath && !base.alreadyMounted) {
                element.setAttribute(name, mountPath(options.rootPath, base.url.pathname));
              }
            }
            continue;
          }

          const next = rewriteMarkupAttribute(name, value, state, options, rewrite);
          if (next !== value) element.setAttribute(name, next);
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
  const lowerName = name.toLowerCase();
  if (lowerName === "style") {
    return rewriteCssUrls(value, (url) => rewriteMarkupUrl(url, state, options, rewrite));
  }
  if (lowerName === "srcset" || lowerName === "imagesrcset") {
    return rewriteSrcset(value, (url) => rewriteMarkupUrl(url, state, options, rewrite));
  }
  if (lowerName !== "href" && lowerName !== "src" && lowerName !== "xlink:href") return value;
  return rewriteMarkupUrl(value, state, options, rewrite);
}

function rewriteMarkupUrl(
  value: string,
  state: MarkupState,
  options: MarkupOptions,
  rewrite: UrlRewrite
): string {
  const { leading, core, trailing } = splitTrimmed(value);
  if (state.baseExternal) return value;
  const resolved = resolveLocalUrl(core, state.documentPath, options.includeRootRelative);
  if (!resolved) return value;
  const mountedPath = isRootRelative(core)
    ? unmountRootPath(resolved.url.pathname, options.rootPath)
    : null;
  state.paths?.add(mountedPath ?? resolved.path);
  return `${leading}${rewrite(core, resolved)}${trailing}`;
}

function resolveBase(
  value: string,
  documentPath: string,
  rootPath?: string
): BaseResolution | "current" | "external" | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return "current";
  }
  if (trimmed.startsWith("//") || URI_SCHEME_RE.test(trimmed)) {
    return "external";
  }
  const resolved = resolveLocalUrl(trimmed, documentPath, true);
  if (!resolved) return null;
  const unmountedPath = isRootRelative(trimmed)
    ? unmountRootPath(resolved.url.pathname, rootPath)
    : null;
  return {
    ...resolved,
    path: unmountedPath ?? resolved.path,
    alreadyMounted: unmountedPath !== null
  };
}

function resolveLocalUrl(value: string, documentPath: string, includeRootRelative: boolean): ResolvedUrl | null {
  const trimmed = value.trim();
  const rootRelative = trimmed.startsWith("/") && !trimmed.startsWith("//");
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//") || URI_SCHEME_RE.test(trimmed)) return null;
  if (rootRelative && !includeRootRelative) return null;

  const authoredPath = decodePath(stripUrlPath(trimmed));
  const authoredDocumentPath = decodePath(documentPath);
  if (authoredPath === null || authoredDocumentPath === null || hasTraversal(authoredPath, authoredDocumentPath)) {
    return null;
  }

  try {
    const url = new URL(trimmed, documentUrl(documentPath));
    if (url.origin !== PREVIEW_ORIGIN) return null;
    const pathname = decodePath(url.pathname);
    if (pathname === null || hasTraversal(pathname)) return null;
    return {
      url,
      path: pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "")
    };
  } catch {
    return null;
  }
}

function documentUrl(documentPath: string): string {
  const normalized = documentPath.trim().replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  return `${PREVIEW_ORIGIN}/${normalized}`;
}

function decodePath(path: string): string | null {
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

function stripUrlPath(value: string): string {
  const hashIndex = value.indexOf("#");
  const beforeHash = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const queryIndex = beforeHash.indexOf("?");
  return queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash;
}

export function decodeServedPath(path: string): string | null {
  const decoded = decodePath(path);
  if (
    decoded === null
    || decoded.startsWith("/")
    || decoded.includes("//")
    || decoded.split("/").some((segment) =>
      segment === "."
      || segment === ".."
      || segment.includes("\\")
      || /[\p{Cc}]/u.test(segment)
    )
  ) return null;
  return decoded || "index.html";
}

function hasTraversal(path: string, documentPath?: string): boolean {
  const relative = path.startsWith("/") ? path.slice(1) : path;
  if (relative.includes("//") || path.includes("\\") || /[\p{Cc}]/u.test(path)) return true;
  let depth = path.startsWith("/")
    ? 0
    : (documentPath?.split("/").slice(0, -1).filter(Boolean).length || 0);
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      depth -= 1;
      if (depth < 0) return true;
    } else {
      depth += 1;
    }
  }
  return false;
}

function rewriteRootRelativeUrl(value: string, rootPath?: string): string {
  if (!rootPath) return value;
  const { leading, core, trailing } = splitTrimmed(value);
  if (!core.startsWith("/") || core.startsWith("//")) return value;
  const resolved = resolveLocalUrl(core, "index.html", true);
  if (!resolved) return value;
  if (unmountRootPath(resolved.url.pathname, rootPath) !== null) return value;
  return `${leading}${mountPath(rootPath, resolved.url.pathname)}${resolved.url.search}${resolved.url.hash}${trailing}`;
}

function isRootRelative(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("/") && !trimmed.startsWith("//");
}

function unmountRootPath(pathname: string, rootPath?: string): string | null {
  if (!rootPath) return null;
  const decodedPath = decodePath(pathname);
  if (decodedPath === null) return null;
  const root = rootPath.trim().replace(/\/+$/, "") || "/";
  if (root === "/") return decodedPath.replace(/^\/+/, "") || "index.html";
  const prefix = `${root}/`;
  if (decodedPath !== root && !decodedPath.startsWith(prefix)) return null;
  const suffix = decodedPath.slice(prefix.length);
  return suffix || "index.html";
}

function mountPath(rootPath: string, pathname: string): string {
  const root = rootPath.trim().replace(/\/+$/, "") || "/";
  const suffix = pathname.replace(/^\/+/, "");
  return root === "/" ? `/${suffix}` : `${root}/${suffix}`;
}

function splitTrimmed(value: string) {
  const leadingLength = value.length - value.trimStart().length;
  const trailingLength = value.length - value.trimEnd().length;
  return {
    leading: value.slice(0, leadingLength),
    core: trailingLength
      ? value.slice(leadingLength, value.length - trailingLength)
      : value.slice(leadingLength),
    trailing: trailingLength ? value.slice(value.length - trailingLength) : ""
  };
}

function isAsciiWhitespace(value: string): boolean {
  return value === "\t" || value === "\n" || value === "\f" || value === "\r" || value === " ";
}

/** Rewrite only the URL token in each candidate while preserving authored descriptors and spacing. */
function rewriteSrcset(srcset: string, rewrite: (url: string) => string): string {
  const ranges: Array<{ start: number; end: number; replacement: string }> = [];
  let position = 0;

  while (position < srcset.length) {
    while (position < srcset.length && (isAsciiWhitespace(srcset[position]) || srcset[position] === ",")) {
      position += 1;
    }
    if (position >= srcset.length) break;

    const start = position;
    while (position < srcset.length && !isAsciiWhitespace(srcset[position])) position += 1;
    let end = position;
    while (end > start && srcset[end - 1] === ",") end -= 1;

    if (end > start) {
      const url = srcset.slice(start, end);
      const replacement = rewrite(url);
      if (replacement !== url) ranges.push({ start, end, replacement });
    }

    // A trailing comma on the URL token ends a descriptorless candidate.
    if (end < position) continue;

    let inParentheses = false;
    while (position < srcset.length) {
      const character = srcset[position];
      position += 1;
      if (character === "(") {
        inParentheses = true;
      } else if (character === ")") {
        inParentheses = false;
      } else if (character === "," && !inParentheses) {
        break;
      }
    }
  }

  let rewritten = srcset;
  for (const range of ranges.reverse()) {
    rewritten = `${rewritten.slice(0, range.start)}${range.replacement}${rewritten.slice(range.end)}`;
  }
  return rewritten;
}

function isLocalModuleSpecifier(specifier: string): boolean {
  return specifier.startsWith("./")
    || specifier.startsWith("../")
    || (specifier.startsWith("/") && !specifier.startsWith("//"));
}

function escapeStaticModuleSpecifier(specifier: string, quote: string): string {
  const jsonContent = JSON.stringify(specifier).slice(1, -1);
  return quote === "'" ? jsonContent.replaceAll("'", "\\'") : jsonContent;
}

function rewriteJavaScriptModuleSpecifiers(
  source: string,
  documentPath: string,
  rootPath: string | undefined,
  rewrite: UrlRewrite,
  paths?: Set<string>
): string {
  let imports: ReturnType<typeof parseModuleSyntax>[0];
  try {
    [imports] = parseModuleSyntax(source);
  } catch {
    return source;
  }

  const ranges: Array<{ start: number; end: number; replacement: string }> = [];
  for (const imported of imports) {
    const specifier = imported.n;
    if (!specifier || !isLocalModuleSpecifier(specifier)) continue;
    const resolved = resolveLocalUrl(specifier, documentPath, true);
    if (!resolved) continue;

    const mountedPath = isRootRelative(specifier)
      ? unmountRootPath(resolved.url.pathname, rootPath)
      : null;
    paths?.add(mountedPath ?? resolved.path);

    const rewritten = rewrite(specifier, resolved);
    if (rewritten === specifier) continue;
    if (imported.d >= 0) {
      ranges.push({ start: imported.s, end: imported.e, replacement: JSON.stringify(rewritten) });
    } else {
      ranges.push({
        start: imported.s,
        end: imported.e,
        replacement: escapeStaticModuleSpecifier(rewritten, source[imported.s - 1] ?? "\"")
      });
    }
  }

  let rewritten = source;
  for (const range of ranges.reverse()) {
    rewritten = `${rewritten.slice(0, range.start)}${range.replacement}${rewritten.slice(range.end)}`;
  }
  return rewritten;
}

// This deliberately handles only CSS url(...) and quoted @import references;
// comments, quoted text, external/data URLs, and the rest of CSS stay opaque.
function rewriteCssUrls(css: string, rewrite: (url: string) => string): string {
  let output = "";
  let cursor = 0;
  while (cursor < css.length) {
    if (css.startsWith("/*", cursor)) {
      const end = css.indexOf("*/", cursor + 2);
      if (end < 0) return css;
      output += css.slice(cursor, end + 2);
      cursor = end + 2;
      continue;
    }
    if (css[cursor] === "\"" || css[cursor] === "'") {
      const end = findQuotedEnd(css, cursor);
      output += css.slice(cursor, end);
      cursor = end;
      continue;
    }
    const imported = rewriteImport(css, cursor, rewrite);
    if (imported) {
      output += imported.text;
      cursor = imported.end;
      continue;
    }
    const open = findUrlOpen(css, cursor);
    if (open < 0) {
      output += css[cursor];
      cursor += 1;
      continue;
    }
    const close = findFunctionEnd(css, open + 1);
    if (close < 0) return css;
    output += css.slice(cursor, open + 1);
    output += rewriteCssArgument(css.slice(open + 1, close), rewrite);
    output += ")";
    cursor = close + 1;
  }
  return output;
}

function rewriteImport(css: string, start: number, rewrite: (url: string) => string) {
  if (css.slice(start, start + 7).toLowerCase() !== "@import") return null;
  const next = css[start + 7];
  if (next && /[\w-]/.test(next)) return null;
  let quoteStart = start + 7;
  while (/\s/.test(css[quoteStart] ?? "")) quoteStart += 1;
  const quote = css[quoteStart];
  if (quote !== "\"" && quote !== "'") return null;
  const end = findQuotedEnd(css, quoteStart);
  if (end <= quoteStart || css[end - 1] !== quote) return null;
  return {
    end,
    text: `${css.slice(start, quoteStart + 1)}${rewrite(css.slice(quoteStart + 1, end - 1))}${quote}`
  };
}

function findUrlOpen(css: string, start: number): number {
  if (css.slice(start, start + 3).toLowerCase() !== "url") return -1;
  if (/[\w-]/.test(css[start - 1] ?? "")) return -1;
  let open = start + 3;
  while (/\s/.test(css[open] ?? "")) open += 1;
  return css[open] === "(" ? open : -1;
}

function findFunctionEnd(css: string, start: number): number {
  let depth = 1;
  let quote = "";
  for (let index = start; index < css.length; index += 1) {
    const character = css[index];
    if (quote) {
      if (character === quote && css[index - 1] !== "\\") quote = "";
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")" && --depth === 0) {
      return index;
    }
  }
  return -1;
}

function findQuotedEnd(value: string, start: number): number {
  const quote = value[start];
  for (let index = start + 1; index < value.length; index += 1) {
    if (value[index] === quote && value[index - 1] !== "\\") return index + 1;
  }
  return value.length;
}

function rewriteCssArgument(inner: string, rewrite: (url: string) => string): string {
  const { leading, core, trailing } = splitTrimmed(inner);
  if (!core) return inner;
  const quote = core[0] === "\"" || core[0] === "'" ? core[0] : "";
  const url = quote && core.endsWith(quote) ? core.slice(1, -1) : core;
  const next = rewrite(url);
  return `${leading}${quote}${next}${quote}${trailing}`;
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
    const resolved = resolveLocalUrl(url, documentPath, true);
    return resolved ? addQueryParams(rewriteRootRelativeUrl(url, rootPath), params) : url;
  });
}

export function addCacheBusterToJavaScript(
  source: string,
  version?: string,
  extraParams: Record<string, string> = {},
  rootPath?: string,
  documentPath = "index.js"
): string {
  const params = { v: version || Date.now().toString(), ...extraParams };
  return rewriteJavaScriptModuleSpecifiers(
    source,
    documentPath,
    rootPath,
    (url) => addQueryParams(rewriteRootRelativeUrl(url, rootPath), params)
  );
}

export async function rewriteRootRelativeHtmlUrls(
  html: string,
  rootPath: string,
  documentPath = "index.html"
): Promise<string> {
  return rewriteMarkup(
    html,
    (url) => rewriteRootRelativeUrl(url, rootPath),
    { documentPath, includeRootRelative: true, rootPath }
  );
}

export function rewriteRootRelativeCssUrls(css: string, rootPath: string): string {
  return rewriteCssUrls(css, (url) => rewriteRootRelativeUrl(url, rootPath));
}

export function rewriteRootRelativeJavaScriptUrls(
  source: string,
  rootPath: string,
  documentPath = "index.js"
): string {
  return rewriteJavaScriptModuleSpecifiers(
    source,
    documentPath,
    rootPath,
    (url) => rewriteRootRelativeUrl(url, rootPath)
  );
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

export async function collectPreviewResourcePaths(
  html: string,
  documentPath: string,
  rootPath?: string
): Promise<string[]> {
  const paths = new Set<string>();
  await rewriteMarkup(html, (url) => url, { documentPath, includeRootRelative: true, rootPath }, paths);
  return [...paths].sort();
}

export function collectPreviewCssResourcePaths(
  css: string,
  documentPath: string,
  rootPath?: string
): string[] {
  const paths = new Set<string>();
  rewriteCssUrls(css, (url) => {
    const resolved = resolveLocalUrl(url, documentPath, true);
    if (resolved) {
      const mountedPath = isRootRelative(url)
        ? unmountRootPath(resolved.url.pathname, rootPath)
        : null;
      paths.add(mountedPath ?? resolved.path);
    }
    return url;
  });
  return [...paths].sort();
}

export function collectPreviewJavaScriptResourcePaths(
  source: string,
  documentPath: string,
  rootPath?: string
): string[] {
  const paths = new Set<string>();
  rewriteJavaScriptModuleSpecifiers(source, documentPath, rootPath, (url) => url, paths);
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
