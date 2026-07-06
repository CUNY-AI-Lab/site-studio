/**
 * Extensionless-path resolution, shared by all three serving paths: the app
 * worker's editor preview (packages/app routes/preview.ts) and publish
 * (routes/publish.ts), and the standalone publisher worker (packages/worker
 * index.ts).
 *
 * Resolution ORDER (SS-14): given a requested path with no matching object,
 *   1. try `{path}.html`      (a flat sibling page, e.g. /about -> about.html)
 *   2. then `{path}/index.html` (a directory index, e.g. /docs -> docs/index.html)
 * The flat form is tried FIRST so `/about` serves about.html when it exists,
 * matching how the site was authored. Both fallbacks are skipped when the path
 * already ends in `.html` (an exact miss stays a miss — no double-suffixing).
 *
 * Storage-agnostic: the caller supplies `probe(candidatePath)` which returns the
 * resolved object (any truthy value) or a falsy value (null/undefined) when the
 * candidate does not exist. The helper returns the resolved object together with
 * the path it was found at (so the caller can set the correct Content-Type), or
 * null when nothing resolves.
 *
 * Note: unlike the app's former preview logic — which gated its single
 * `{path}/index.html` fallback on `!path.includes(".")` and never tried
 * `{path}.html` — this helper gates on `endsWith(".html")` and tries the flat
 * form first. Routing preview through here is the sanctioned S3-alignment
 * behavior change (preview now matches publish/publisher).
 */
export async function resolveExtensionlessFile<T>(
  requestedPath: string,
  probe: (candidatePath: string) => Promise<T | null | undefined>
): Promise<{ filePath: string; object: T } | null> {
  let filePath = requestedPath;

  const primary = await probe(filePath);
  if (primary) {
    return { filePath, object: primary };
  }

  if (!filePath.endsWith(".html")) {
    const htmlPath = `${filePath}.html`;
    const htmlObject = await probe(htmlPath);
    if (htmlObject) {
      return { filePath: htmlPath, object: htmlObject };
    }
  }

  if (!filePath.endsWith(".html")) {
    const indexPath =
      filePath === "index.html" ? "index.html" : `${filePath.replace(/\/$/, "")}/index.html`;
    const indexObject = await probe(indexPath);
    if (indexObject) {
      return { filePath: indexPath, object: indexObject };
    }
  }

  return null;
}
