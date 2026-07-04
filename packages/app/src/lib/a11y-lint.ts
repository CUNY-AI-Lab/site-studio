/**
 * Deterministic, dependency-free accessibility linting for the static HTML
 * files a Site Studio project produces.
 *
 * This is a HEURISTIC linter, not a real HTML parser. It runs in both the
 * Cloudflare Workers runtime and plain-Node vitest, so it deliberately avoids
 * HTMLRewriter and any DOM APIs. Everything here is regex- and line-based
 * scanning over raw file contents. That means it can be fooled by unusual
 * markup (e.g. attributes split across many lines, exotic quoting, or HTML
 * generated at runtime by JavaScript). The rules are tuned to keep false
 * positives low for the hand-written and template HTML this app produces:
 * when a check is ambiguous, it stays quiet rather than crying wolf.
 *
 * Script, style, and comment regions are blanked out before scanning (with
 * newlines preserved) so their contents never trigger findings and reported
 * line numbers still line up with the original file.
 */

export interface A11yFinding {
  /** Project-relative path of the file the finding came from. */
  file: string;
  /** 1-based line number where determinable, otherwise null. */
  line: number | null;
  /** Stable kebab-case rule id, e.g. "missing-alt". */
  rule: string;
  severity: "error" | "warning";
  /** One human sentence, plain language for a student audience. */
  message: string;
}

/**
 * Replace every character of `original` outside a set of keep-ranges with a
 * space, but preserve newlines everywhere so line numbers are unchanged. Used
 * to blank out <script>, <style>, and comment regions before scanning.
 */
function blankRegions(
  content: string,
  regions: Array<{ start: number; end: number }>
): string {
  if (regions.length === 0) {
    return content;
  }
  const chars = content.split("");
  for (const { start, end } of regions) {
    for (let i = start; i < end && i < chars.length; i += 1) {
      if (chars[i] !== "\n" && chars[i] !== "\r") {
        chars[i] = " ";
      }
    }
  }
  return chars.join("");
}

/**
 * Remove the contents of <script>, <style>, and HTML comments from `content`,
 * replacing stripped characters with spaces (newlines preserved). The tags
 * themselves are blanked too so their attributes don't trip rules.
 */
function stripNonMarkup(content: string): string {
  const regions: Array<{ start: number; end: number }> = [];

  const blockRe = /<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<!--[\s\S]*?-->/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(content)) !== null) {
    regions.push({ start: match.index, end: match.index + match[0].length });
  }

  return blankRegions(content, regions);
}

/** Map a character offset in `content` to a 1-based line number. */
function offsetToLine(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i += 1) {
    if (content[i] === "\n") {
      line += 1;
    }
  }
  return line;
}

/**
 * Extract the value of an attribute from a start-tag string. Handles
 * double-quoted, single-quoted, and unquoted values. Returns null when the
 * attribute is absent, or empty string for a bare/empty attribute.
 */
function getAttr(tag: string, name: string): string | null {
  const re = new RegExp(
    `\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`,
    "i"
  );
  const m = re.exec(tag);
  if (m) {
    return m[2] ?? m[3] ?? m[4] ?? "";
  }
  // Bare boolean-style attribute, e.g. <input disabled> (no value).
  const bareRe = new RegExp(`\\b${name}\\b(?!\\s*=)`, "i");
  return bareRe.test(tag) ? "" : null;
}

/** True when the attribute is present at all (even bare/empty). */
function hasAttr(tag: string, name: string): boolean {
  const re = new RegExp(`\\b${name}\\b`, "i");
  return re.test(tag);
}

const FILLER_ALT_PATTERNS: RegExp[] = [
  /^(image|photo|picture|img)$/i,
  /^(image|photo|project|photograph|work|item|featured)\s*\d*$/i,
];

function isFillerAlt(alt: string): boolean {
  const trimmed = alt.trim();
  if (trimmed === "") {
    return false;
  }
  return FILLER_ALT_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * Scan a single HTML file for accessibility findings. `content` should be the
 * raw file text; script/style/comment regions are stripped internally.
 */
export function lintHtml(path: string, content: string): A11yFinding[] {
  const findings: A11yFinding[] = [];
  const cleaned = stripNonMarkup(content);
  const lower = cleaned.toLowerCase();

  const add = (
    line: number | null,
    rule: string,
    severity: A11yFinding["severity"],
    message: string
  ) => {
    findings.push({ file: path, line, rule, severity, message });
  };

  // --- Document-level rules: lang, title, description ---
  const htmlTagMatch = /<html\b[^>]*>/i.exec(cleaned);
  if (htmlTagMatch) {
    const langValue = getAttr(htmlTagMatch[0], "lang");
    if (langValue === null || langValue.trim() === "") {
      add(
        offsetToLine(cleaned, htmlTagMatch.index),
        "missing-lang",
        "error",
        "The <html> tag needs a lang attribute (like lang=\"en\") so screen readers and browsers know what language the page is in."
      );
    }
  }

  // Only apply title/description checks when there is a <head> to hold them.
  const headMatch = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/i.exec(cleaned);
  if (headMatch) {
    const headContent = headMatch[1];
    if (!/<title\b[^>]*>[\s\S]*?<\/title\s*>/i.test(headContent)) {
      add(
        offsetToLine(cleaned, headMatch.index),
        "missing-title",
        "error",
        "This page has no <title>, so browser tabs and search results have nothing to show. Add a short, descriptive title."
      );
    }
    if (!/<meta\b[^>]*\bname\s*=\s*["']?description["']?[^>]*>/i.test(headContent)) {
      add(
        offsetToLine(cleaned, headMatch.index),
        "missing-description",
        "warning",
        "This page has no meta description, so search engines and link previews will guess at the summary. Add one sentence describing the page."
      );
    }
  }

  // --- Heading structure: h1 count and skipped levels ---
  const headingRe = /<h([1-6])\b[^>]*>/gi;
  const headings: Array<{ level: number; index: number }> = [];
  let hMatch: RegExpExecArray | null;
  while ((hMatch = headingRe.exec(cleaned)) !== null) {
    headings.push({ level: Number(hMatch[1]), index: hMatch.index });
  }
  const h1s = headings.filter((h) => h.level === 1);
  // Only judge heading structure on documents that actually contain a body /
  // headings — avoids noise on non-page fragments with no headings at all.
  if (headings.length > 0) {
    if (h1s.length === 0) {
      add(
        null,
        "missing-h1",
        "warning",
        "This page has no <h1> heading. Give it one main heading so readers and screen readers know what the page is about."
      );
    } else if (h1s.length > 1) {
      add(
        offsetToLine(cleaned, h1s[1].index),
        "multiple-h1",
        "warning",
        "This page has more than one <h1>. Use a single <h1> for the main title and <h2>/<h3> for the sections under it."
      );
    }

    // Skipped-heading-level: walking headings in document order, the level
    // should never jump deeper by more than one (e.g. h1 -> h3 skips h2).
    let previousLevel = 0;
    for (const heading of headings) {
      if (previousLevel !== 0 && heading.level > previousLevel + 1) {
        add(
          offsetToLine(cleaned, heading.index),
          "skipped-heading-level",
          "warning",
          `This page jumps from an h${previousLevel} straight to an h${heading.level}, skipping a level. Step heading levels down one at a time so the outline stays logical.`
        );
      }
      previousLevel = heading.level;
    }
  }

  // --- Images: missing alt and filler alt ---
  const imgRe = /<img\b[^>]*>/gi;
  let imgMatch: RegExpExecArray | null;
  while ((imgMatch = imgRe.exec(cleaned)) !== null) {
    const tag = imgMatch[0];
    const line = offsetToLine(cleaned, imgMatch.index);

    if (!hasAttr(tag, "alt")) {
      add(
        line,
        "missing-alt",
        "error",
        "This image has no alt attribute, so screen readers can't describe it. Add alt text, or alt=\"\" if the image is purely decorative."
      );
    } else {
      const alt = getAttr(tag, "alt") ?? "";
      if (isFillerAlt(alt)) {
        add(
          line,
          "filler-alt",
          "warning",
          `The alt text "${alt.trim()}" doesn't describe the image. Replace it with a short phrase about what the image actually shows, or use alt="" if it's decorative.`
        );
      }
    }

    const src = getAttr(tag, "src") ?? "";
    if (/placehold\.co/i.test(src)) {
      add(
        line,
        "placeholder-image",
        "warning",
        "This image points at placehold.co, so it will publish as a gray placeholder box. Replace it with a real image before publishing."
      );
    }
  }

  // placehold.co can also appear on non-<img> elements (e.g. CSS-free
  // background usage in markup). Catch any remaining placehold.co references
  // that weren't already reported on an <img>.
  const reportedPlaceholderLines = new Set(
    findings.filter((f) => f.rule === "placeholder-image").map((f) => f.line)
  );
  const placeholderRe = /placehold\.co/gi;
  let phMatch: RegExpExecArray | null;
  while ((phMatch = placeholderRe.exec(cleaned)) !== null) {
    const line = offsetToLine(cleaned, phMatch.index);
    // Skip if this offset falls inside an <img> we already flagged.
    if (reportedPlaceholderLines.has(line)) {
      continue;
    }
    // Only flag when it looks like a URL reference (src/href/url()), not prose.
    const contextStart = Math.max(0, phMatch.index - 40);
    const context = cleaned.slice(contextStart, phMatch.index);
    if (/\b(src|href|content|url\()\s*=?\s*["'(]?[^"'()]*$/i.test(context)) {
      reportedPlaceholderLines.add(line);
      add(
        line,
        "placeholder-image",
        "warning",
        "This uses a placehold.co URL, so it will publish as a gray placeholder box. Replace it with a real image before publishing."
      );
    }
  }

  // --- Links: unsafe target="_blank" ---
  const anchorRe = /<a\b[^>]*>/gi;
  let aMatch: RegExpExecArray | null;
  while ((aMatch = anchorRe.exec(cleaned)) !== null) {
    const tag = aMatch[0];
    const target = getAttr(tag, "target");
    if (target !== null && target.trim().toLowerCase() === "_blank") {
      const rel = getAttr(tag, "rel") ?? "";
      if (!/\bnoopener\b/i.test(rel)) {
        add(
          offsetToLine(cleaned, aMatch.index),
          "unsafe-target-blank",
          "warning",
          "This link opens in a new tab but is missing rel=\"noopener\", which the new page could otherwise abuse. Add rel=\"noopener noreferrer\"."
        );
      }
    }
  }

  // --- Positive tabindex ---
  const tabindexRe = /<[a-z][^>]*\btabindex\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))[^>]*>/gi;
  let tiMatch: RegExpExecArray | null;
  while ((tiMatch = tabindexRe.exec(cleaned)) !== null) {
    const raw = (tiMatch[2] ?? tiMatch[3] ?? tiMatch[4] ?? "").trim();
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) {
      add(
        offsetToLine(cleaned, tiMatch.index),
        "positive-tabindex",
        "warning",
        "This element uses a positive tabindex, which fights the natural tab order and confuses keyboard users. Use tabindex=\"0\" or restructure the markup instead."
      );
    }
  }

  // --- Unlabeled form controls ---
  findings.push(...lintFormControls(path, cleaned, lower));

  return findings;
}

/**
 * Heuristic form-control labeling check. This is intentionally conservative:
 * a control is only flagged when we can't find ANY plausible labeling
 * mechanism, because false "you forgot a label" warnings are worse than a few
 * misses on unusual markup.
 */
function lintFormControls(
  path: string,
  cleaned: string,
  lower: string
): A11yFinding[] {
  const findings: A11yFinding[] = [];

  // Collect all `for="..."` values from <label> tags so we can match by id.
  const labelForIds = new Set<string>();
  const labelForRe = /<label\b[^>]*\bfor\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  let lfMatch: RegExpExecArray | null;
  while ((lfMatch = labelForRe.exec(cleaned)) !== null) {
    const id = (lfMatch[2] ?? lfMatch[3] ?? lfMatch[4] ?? "").trim();
    if (id) {
      labelForIds.add(id);
    }
  }

  const controlRe = /<(input|select|textarea)\b[^>]*>/gi;
  let cMatch: RegExpExecArray | null;
  while ((cMatch = controlRe.exec(cleaned)) !== null) {
    const tag = cMatch[0];
    const tagName = cMatch[1].toLowerCase();
    const start = cMatch.index;

    if (tagName === "input") {
      const type = (getAttr(tag, "type") ?? "").trim().toLowerCase();
      if (type === "hidden" || type === "submit" || type === "button") {
        continue;
      }
    }

    // Any of these count as a label and clear the control.
    const id = (getAttr(tag, "id") ?? "").trim();
    if (id && labelForIds.has(id)) {
      continue;
    }
    if (hasAttr(tag, "aria-label") && (getAttr(tag, "aria-label") ?? "").trim() !== "") {
      continue;
    }
    if (hasAttr(tag, "aria-labelledby") && (getAttr(tag, "aria-labelledby") ?? "").trim() !== "") {
      continue;
    }
    // Wrapped in a <label>: look for an unclosed <label> in the text before
    // this control (i.e. more opening <label> than </label> up to here).
    const before = lower.slice(0, start);
    const openLabels = (before.match(/<label\b/gi) || []).length;
    const closeLabels = (before.match(/<\/label\s*>/gi) || []).length;
    if (openLabels > closeLabels) {
      continue;
    }
    // A <title> on the control is also an accessible name; some controls use
    // placeholder-as-name patterns which are weak, so we only accept title.
    if (hasAttr(tag, "title") && (getAttr(tag, "title") ?? "").trim() !== "") {
      continue;
    }

    findings.push({
      file: path,
      line: offsetToLine(cleaned, start),
      rule: "unlabeled-control",
      severity: "warning",
      message:
        "This form control has no label, so users won't know what to type. Add a <label for> tied to its id, or an aria-label.",
    });
  }

  return findings;
}

/** Lint every .html file in a project's file map. Non-HTML files are skipped. */
export function lintProject(files: Record<string, string>): A11yFinding[] {
  const findings: A11yFinding[] = [];
  for (const [path, content] of Object.entries(files)) {
    if (!/\.html?$/i.test(path)) {
      continue;
    }
    findings.push(...lintHtml(path, content));
  }
  return findings;
}
