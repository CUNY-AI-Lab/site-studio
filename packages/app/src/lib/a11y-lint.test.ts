import { describe, it, expect } from "vitest";
import { lintHtml, lintProject } from "./a11y-lint";
import { TEMPLATE_FILES } from "./template-content";

function rules(findings: ReturnType<typeof lintHtml>): string[] {
  return findings.map((f) => f.rule);
}

const PAGE_HEAD = `<title>Example</title>\n<meta name="description" content="An example page.">`;

/** Wrap body markup in a minimal, otherwise-clean HTML document. */
function page(body: string, head = PAGE_HEAD): string {
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n${head}\n</head>\n<body>\n<h1>Title</h1>\n${body}\n</body>\n</html>`;
}

describe("missing-lang", () => {
  it("flags an <html> tag without a lang attribute", () => {
    const findings = lintHtml("index.html", `<html>\n<head>${PAGE_HEAD}</head><body><h1>Hi</h1></body></html>`);
    expect(rules(findings)).toContain("missing-lang");
  });

  it("does not flag when lang is present", () => {
    const findings = lintHtml("index.html", page("<p>Hello</p>"));
    expect(rules(findings)).not.toContain("missing-lang");
  });
});

describe("missing-title", () => {
  it("flags a <head> with no <title>", () => {
    const html = `<html lang="en"><head><meta name="description" content="x"></head><body><h1>Hi</h1></body></html>`;
    expect(rules(lintHtml("index.html", html))).toContain("missing-title");
  });

  it("does not flag when a title is present", () => {
    expect(rules(lintHtml("index.html", page("<p>Hi</p>")))).not.toContain("missing-title");
  });
});

describe("missing-description", () => {
  it("flags a <head> with no meta description", () => {
    const html = `<html lang="en"><head><title>T</title></head><body><h1>Hi</h1></body></html>`;
    expect(rules(lintHtml("index.html", html))).toContain("missing-description");
  });

  it("does not flag when a meta description is present", () => {
    expect(rules(lintHtml("index.html", page("<p>Hi</p>")))).not.toContain("missing-description");
  });
});

describe("missing-h1 and multiple-h1", () => {
  it("flags a document with headings but no h1", () => {
    const html = `<html lang="en"><head>${PAGE_HEAD}</head><body><h2>Section</h2></body></html>`;
    expect(rules(lintHtml("index.html", html))).toContain("missing-h1");
  });

  it("flags a document with two h1s", () => {
    const html = `<html lang="en"><head>${PAGE_HEAD}</head><body><h1>One</h1><h1>Two</h1></body></html>`;
    expect(rules(lintHtml("index.html", html))).toContain("multiple-h1");
  });

  it("does not flag a document with exactly one h1", () => {
    const r = rules(lintHtml("index.html", page("<h2>Section</h2><p>Body</p>")));
    expect(r).not.toContain("missing-h1");
    expect(r).not.toContain("multiple-h1");
  });
});

describe("skipped-heading-level", () => {
  it("flags an h1 followed by an h3 with no h2", () => {
    const findings = lintHtml("index.html", page("<h3>Deep</h3>"));
    expect(rules(findings)).toContain("skipped-heading-level");
  });

  it("does not flag well-nested headings", () => {
    const findings = lintHtml("index.html", page("<h2>A</h2><h3>B</h3><h2>C</h2>"));
    expect(rules(findings)).not.toContain("skipped-heading-level");
  });
});

describe("missing-alt", () => {
  it("flags an <img> with no alt attribute", () => {
    const findings = lintHtml("index.html", page(`<img src="cat.jpg">`));
    expect(rules(findings)).toContain("missing-alt");
  });

  it("does not flag an <img> with alt text (even empty)", () => {
    const r = rules(lintHtml("index.html", page(`<img src="cat.jpg" alt="A cat"><img src="d.png" alt="">`)));
    expect(r).not.toContain("missing-alt");
  });
});

describe("filler-alt", () => {
  it("flags alt text like \"image\"", () => {
    expect(rules(lintHtml("index.html", page(`<img src="a.jpg" alt="image">`)))).toContain("filler-alt");
  });

  it("flags numbered filler like \"photo 2\"", () => {
    expect(rules(lintHtml("index.html", page(`<img src="a.jpg" alt="photo 2">`)))).toContain("filler-alt");
  });

  it("does not flag descriptive alt text", () => {
    const r = rules(lintHtml("index.html", page(`<img src="a.jpg" alt="Students working in the lab">`)));
    expect(r).not.toContain("filler-alt");
  });
});

describe("placeholder-image", () => {
  it("flags a placehold.co src", () => {
    const findings = lintHtml("index.html", page(`<img src="https://placehold.co/150x150" alt="Placeholder — replace me">`));
    expect(rules(findings)).toContain("placeholder-image");
    const finding = findings.find((f) => f.rule === "placeholder-image");
    expect(finding?.message.toLowerCase()).toContain("gray");
    expect(finding?.message.toLowerCase()).toContain("replace");
  });

  it("does not flag a normal image src", () => {
    expect(rules(lintHtml("index.html", page(`<img src="/photo.jpg" alt="A photo of the team">`)))).not.toContain("placeholder-image");
  });
});

describe("unsafe-target-blank", () => {
  it("flags target=_blank without rel noopener", () => {
    const findings = lintHtml("index.html", page(`<a href="https://x.com" target="_blank">X</a>`));
    expect(rules(findings)).toContain("unsafe-target-blank");
  });

  it("does not flag target=_blank with rel noopener", () => {
    const findings = lintHtml("index.html", page(`<a href="https://x.com" target="_blank" rel="noopener noreferrer">X</a>`));
    expect(rules(findings)).not.toContain("unsafe-target-blank");
  });
});

describe("unlabeled-control", () => {
  it("flags an <input> with no label", () => {
    expect(rules(lintHtml("index.html", page(`<form><input type="text" name="q"></form>`)))).toContain("unlabeled-control");
  });

  it("does not flag an input labeled by a matching <label for>", () => {
    const body = `<form><label for="q">Query</label><input type="text" id="q"></form>`;
    expect(rules(lintHtml("index.html", page(body)))).not.toContain("unlabeled-control");
  });

  it("does not flag an input with aria-label", () => {
    expect(rules(lintHtml("index.html", page(`<input type="search" aria-label="Search">`)))).not.toContain("unlabeled-control");
  });

  it("does not flag an input wrapped in a <label>", () => {
    expect(rules(lintHtml("index.html", page(`<label>Name <input type="text"></label>`)))).not.toContain("unlabeled-control");
  });

  it("does not flag hidden, submit, or button inputs", () => {
    const body = `<input type="hidden" name="csrf"><input type="submit" value="Go"><input type="button" value="Click">`;
    expect(rules(lintHtml("index.html", page(body)))).not.toContain("unlabeled-control");
  });
});

describe("positive-tabindex", () => {
  it("flags tabindex greater than 0", () => {
    expect(rules(lintHtml("index.html", page(`<div tabindex="3">x</div>`)))).toContain("positive-tabindex");
  });

  it("does not flag tabindex 0 or -1", () => {
    const r = rules(lintHtml("index.html", page(`<div tabindex="0">a</div><div tabindex="-1">b</div>`)));
    expect(r).not.toContain("positive-tabindex");
  });
});

describe("region stripping", () => {
  it("ignores markup-looking content inside <script>, <style>, and comments", () => {
    const body = `
<script>document.write('<img src="x.jpg">');</script>
<style>/* <img src="y.jpg"> */</style>
<!-- <img src="z.jpg"> a commented image -->
<p>Real content</p>`;
    const findings = lintHtml("index.html", page(body));
    expect(rules(findings)).not.toContain("missing-alt");
  });

  it("preserves line numbers across stripped regions", () => {
    const html = [
      `<html lang="en">`, // line 1
      `<head><title>T</title></head>`, // 2
      `<body>`, // 3
      `<h1>Title</h1>`, // 4
      `<script>`, // 5
      `var a = 1;`, // 6
      `</script>`, // 7
      `<img src="a.jpg">`, // 8
      `</body>`, // 9
      `</html>` // 10
    ].join("\n");
    const finding = lintHtml("index.html", html).find((f) => f.rule === "missing-alt");
    expect(finding?.line).toBe(8);
  });
});

describe("lintProject", () => {
  it("only scans .html files", () => {
    const findings = lintProject({
      "index.html": page(`<img src="a.jpg">`),
      "styles.css": `.x { background: url("placehold.co"); }`,
      "data.json": `{"alt": "image"}`
    });
    expect(findings.every((f) => f.file === "index.html")).toBe(true);
    expect(rules(findings)).toContain("missing-alt");
  });

  it("produces zero errors on freshly-remediated real templates", () => {
    for (const templateId of ["cv-modern", "dataviz-interactive"] as const) {
      const files = TEMPLATE_FILES[templateId];
      expect(files, `template ${templateId} should exist`).toBeTruthy();

      const findings = lintProject(files);
      const errors = findings.filter((f) => f.severity === "error");
      expect(errors, `${templateId} errors: ${JSON.stringify(errors, null, 2)}`).toHaveLength(0);

      const ruleIds = new Set(findings.map((f) => f.rule));
      expect(ruleIds.has("filler-alt"), `${templateId} should have no filler-alt`).toBe(false);
      expect(ruleIds.has("unsafe-target-blank"), `${templateId} should have no unsafe-target-blank`).toBe(false);
    }
  });

  it("exercises the placeholder-image rule via the cv-modern template", () => {
    // The templates intentionally ship placehold.co images with honest alt
    // text, so the placeholder-image warning is expected here.
    const findings = lintProject(TEMPLATE_FILES["cv-modern"]);
    expect(findings.some((f) => f.rule === "placeholder-image")).toBe(true);
  });
});
