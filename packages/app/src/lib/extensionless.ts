/**
 * Resolve a requested path against project storage. An exact object wins,
 * followed by a flat `{path}.html` page and then `{path}/index.html`.
 * Extensionless fallback is skipped for paths that already end in `.html`.
 */
export async function resolveExtensionlessFile<T>(
  requestedPath: string,
  probe: (candidatePath: string) => Promise<T | null | undefined>
): Promise<{ filePath: string; object: T } | null> {
  const primary = await probe(requestedPath);
  if (primary) {
    return { filePath: requestedPath, object: primary };
  }

  if (!requestedPath.endsWith(".html")) {
    const htmlPath = `${requestedPath}.html`;
    const htmlObject = await probe(htmlPath);
    if (htmlObject) {
      return { filePath: htmlPath, object: htmlObject };
    }
  }

  if (!requestedPath.endsWith(".html")) {
    const indexPath =
      requestedPath === "index.html"
        ? "index.html"
        : `${requestedPath.replace(/\/$/, "")}/index.html`;
    const indexObject = await probe(indexPath);
    if (indexObject) {
      return { filePath: indexPath, object: indexObject };
    }
  }

  return null;
}
