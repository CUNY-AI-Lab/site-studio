type Env = {
  PUBLIC_DOMAIN?: string;
  SITE_STUDIO_BUCKET: R2Bucket;
};

type ProjectMetadata = {
  id?: string;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
  published?: boolean;
  publishedAt?: string;
  slug?: string;
};

function sanitizeFilePath(filePath: string): string {
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

function metadataKey(userId: string, projectId: string): string {
  return `projects/${userId}/${projectId}/.metadata.json`;
}

function fileKey(userId: string, projectId: string, filePath: string): string {
  return `projects/${userId}/${projectId}/${sanitizeFilePath(filePath)}`;
}

function getContentType(filePath: string): string {
  const match = filePath.toLowerCase().match(/\.[^.]+$/);
  const extension = match?.[0] || "";
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".pdf": "application/pdf"
  };

  return types[extension] || "application/octet-stream";
}

function publishedSortKey(metadata: ProjectMetadata): string {
  return metadata.publishedAt || metadata.updatedAt || metadata.createdAt || "";
}

function parsePublishedRequest(url: URL): { userId: string; slug: string; filePath: string } | null {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length >= 3 && parts[0] === "sites") {
    return {
      userId: parts[1],
      slug: parts[2],
      filePath: parts.slice(3).join("/") || "index.html"
    };
  }

  if (parts.length >= 2) {
    return {
      userId: parts[0],
      slug: parts[1],
      filePath: parts.slice(2).join("/") || "index.html"
    };
  }

  return null;
}

async function listProjects(bucket: R2Bucket, userId: string): Promise<string[]> {
  const prefix = `projects/${userId}/`;
  const ids = new Set<string>();
  let cursor: string | undefined;

  do {
    const listed = await bucket.list({
      prefix,
      delimiter: "/",
      cursor
    });

    for (const delimited of listed.delimitedPrefixes || []) {
      const trimmed = delimited.slice(prefix.length).replace(/\/$/, "");
      if (trimmed) {
        ids.add(trimmed);
      }
    }

    for (const object of listed.objects) {
      const relative = object.key.slice(prefix.length);
      const [projectId] = relative.split("/");
      if (projectId) {
        ids.add(projectId);
      }
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return [...ids].sort();
}

async function getProjectMetadata(
  bucket: R2Bucket,
  userId: string,
  projectId: string
): Promise<ProjectMetadata | null> {
  const object = await bucket.get(metadataKey(userId, projectId));
  if (!object) {
    return null;
  }

  try {
    return JSON.parse(await object.text()) as ProjectMetadata;
  } catch (error) {
    console.warn(`Skipping invalid project metadata: ${metadataKey(userId, projectId)}`, error);
    return null;
  }
}

async function findPublishedProject(
  bucket: R2Bucket,
  userId: string,
  requestedSlug: string
): Promise<{ projectId: string; metadata: ProjectMetadata } | null> {
  const projectIds = await listProjects(bucket, userId);
  const matches: Array<{ projectId: string; metadata: ProjectMetadata }> = [];

  for (const projectId of projectIds) {
    const metadata = await getProjectMetadata(bucket, userId, projectId);
    if (!metadata?.published) {
      continue;
    }

    if (metadata.slug === requestedSlug || (!metadata.slug && projectId === requestedSlug)) {
      matches.push({ projectId, metadata });
    }
  }

  if (matches.length === 0) {
    return null;
  }

  matches.sort((left, right) => publishedSortKey(right.metadata).localeCompare(publishedSortKey(left.metadata)));
  return matches[0] || null;
}

async function readObject(
  bucket: R2Bucket,
  userId: string,
  projectId: string,
  filePath: string
): Promise<R2ObjectBody | null> {
  return bucket.get(fileKey(userId, projectId, filePath));
}

function responseHeaders(filePath: string, object: R2ObjectBody): Headers {
  const contentType = getContentType(filePath);
  const headers = new Headers({
    "Content-Type": contentType,
    ETag: object.etag
  });

  if (object.uploaded) {
    headers.set("Last-Modified", object.uploaded.toUTCString());
  }

  if (contentType.startsWith("text/html")) {
    headers.set("Cache-Control", "public, max-age=300");
  } else {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  }

  return headers;
}

async function notFoundResponse(
  bucket: R2Bucket,
  userId: string,
  projectId: string
): Promise<Response> {
  const custom404 = await readObject(bucket, userId, projectId, "404.html");
  if (custom404) {
    return new Response(custom404.body, {
      status: 404,
      headers: responseHeaders("404.html", custom404)
    });
  }

  return new Response("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parsed = parsePublishedRequest(url);
    if (!parsed) {
      return new Response("Not found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    const resolved = await findPublishedProject(env.SITE_STUDIO_BUCKET, parsed.userId, parsed.slug);
    if (!resolved) {
      return new Response("Published site not found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    let filePath = parsed.filePath || "index.html";
    let object = await readObject(env.SITE_STUDIO_BUCKET, parsed.userId, resolved.projectId, filePath);

    if (!object && !filePath.endsWith(".html")) {
      const htmlPath = `${filePath}.html`;
      object = await readObject(env.SITE_STUDIO_BUCKET, parsed.userId, resolved.projectId, htmlPath);
      if (object) {
        filePath = htmlPath;
      }
    }

    if (!object && !filePath.endsWith(".html")) {
      const indexPath = filePath === "index.html" ? "index.html" : `${filePath.replace(/\/$/, "")}/index.html`;
      object = await readObject(env.SITE_STUDIO_BUCKET, parsed.userId, resolved.projectId, indexPath);
      if (object) {
        filePath = indexPath;
      }
    }

    if (!object) {
      return notFoundResponse(env.SITE_STUDIO_BUCKET, parsed.userId, resolved.projectId);
    }

    return new Response(object.body, {
      status: 200,
      headers: responseHeaders(filePath, object)
    });
  }
};
