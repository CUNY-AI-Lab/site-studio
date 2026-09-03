import { decodeHTML, decodeHTMLAttribute } from "entities";

// The same interactive context budget as uploaded document extraction. Return
// a visible truncation flag instead of rejecting an otherwise readable page.
const MAX_PAGE_CHARS = 120_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BLOCK_ELEMENTS = new Set([
  "address", "article", "aside", "blockquote", "br", "div", "footer", "h1",
  "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "p",
  "pre", "section", "td", "tr",
]);

function publicPageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Provide a complete public http:// or https:// page URL.");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !["http:", "https:"].includes(url.protocol) || url.username || url.password ||
    !host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":") ||
    /(?:^|\.)(?:localhost|local|internal)$/.test(host)
  ) {
    // Worker fetch uses Cloudflare's public resolver. No VPC/private-network
    // binding is passed here; IP literals are unsupported by Worker fetch.
    throw new Error("Only public web pages without embedded credentials can be read.");
  }
  url.hash = "";
  return url;
}

function pageText(response: Response, baseUrl: URL): Response {
  let linkBase = baseUrl;
  let sawBase = false;
  return new HTMLRewriter()
    .on("script,style,noscript,template", {
      element(element) { element.remove(); },
    })
    .on("base[href]", {
      element(element) {
        if (sawBase) return;
        sawBase = true;
        try {
          const base = new URL(decodeHTMLAttribute(element.getAttribute("href") ?? ""), baseUrl);
          if (["http:", "https:"].includes(base.protocol) && !base.username && !base.password) linkBase = base;
        } catch {
          // Keep the document URL when its base is malformed.
        }
      },
    })
    .on("a[href]", {
      element(element) {
        const href = element.getAttribute("href");
        if (!href) return;
        try {
          const link = new URL(decodeHTMLAttribute(href), linkBase);
          if (["http:", "https:"].includes(link.protocol) && !link.username && !link.password) {
            element.after(` (${link.href})`);
          }
        } catch {
          // A malformed link does not make the surrounding page unreadable.
        }
      },
    })
    .on("*", {
      element(element) {
        if (BLOCK_ELEMENTS.has(element.tagName)) element.before("\n");
        element.removeAndKeepContent();
      },
    })
    .transform(response);
}

async function readPageText(response: Response, signal?: AbortSignal) {
  if (!response.body) return { content: "", truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let content = "";
  try {
    while (content.length <= MAX_PAGE_CHARS) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) {
        content += decoder.decode();
        break;
      }
      // At most four UTF-8 bytes per character; do not decode an entire large
      // upstream chunk once enough text is available for the context budget.
      const remaining = MAX_PAGE_CHARS + 1 - content.length;
      content += decoder.decode(chunk.value.subarray(0, remaining * 4), { stream: true }).slice(0, remaining);
    }
    const truncated = content.length > MAX_PAGE_CHARS;
    if (truncated) await reader.cancel();
    let clipped = content.slice(0, MAX_PAGE_CHARS);
    const last = clipped.charCodeAt(clipped.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) clipped = clipped.slice(0, -1);
    return { content: clipped.trim(), truncated };
  } finally {
    reader.releaseLock();
  }
}

/** Read public source material, never an authenticated page or a search index. */
export async function readWebPage(
  value: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<{ url: string; content: string; truncated: boolean }> {
  let url = publicPageUrl(value);
  // Match Fetch's redirect limit, while validating every destination ourselves.
  // https://fetch.spec.whatwg.org/#http-redirect-fetch
  for (let redirects = 0; redirects <= 20; redirects += 1) {
    signal?.throwIfAborted();
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "text/html, text/plain, text/markdown, application/json" },
        credentials: "omit",
        redirect: "manual",
        cache: "no-store",
        signal,
      });
    } catch {
      signal?.throwIfAborted();
      throw new Error("The page could not be reached. Check the link or upload its contents.");
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("The page returned a redirect without a destination.");
      url = publicPageUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`The page returned HTTP ${response.status}. It may require sign-in or block automated access.`);
    }
    const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const isHtml = contentType === "text/html" || contentType === "application/xhtml+xml";
    if (!isHtml && !contentType.startsWith("text/") && !/^application\/(?:json|ld\+json|xml|javascript)$/.test(contentType)) {
      await response.body?.cancel();
      throw new Error("This link is not a readable web page. Upload documents or images into the project instead.");
    }
    const result = await readPageText(isHtml ? pageText(response, url) : response, signal);
    signal?.throwIfAborted();
    return { url: url.href, ...result, content: isHtml ? decodeHTML(result.content) : result.content };
  }
  throw new Error("The page redirected too many times.");
}
