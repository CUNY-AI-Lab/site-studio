import { createMiddleware } from "hono/factory";
import type { Env, User } from "../types";

const PREVIEW_TOKEN_TTL_SECONDS = 600;

export type PreviewTokenGrant = {
  userId: string;
  projectId: string;
  allowedPaths: string[];
  expiresAt: number;
};

function previewTokenKey(token: string): string {
  return `preview-token:${token}`;
}

function mintToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export async function mintPreviewToken(
  kv: KVNamespace,
  userId: string,
  projectId: string,
  allowedPaths: string[],
  expiresAt = Date.now() + PREVIEW_TOKEN_TTL_SECONDS * 1000
): Promise<string> {
  const token = mintToken();
  const remainingSeconds = Math.max(60, Math.ceil((expiresAt - Date.now()) / 1000));
  await kv.put(previewTokenKey(token), JSON.stringify({
    userId,
    projectId,
    allowedPaths: [...new Set(allowedPaths)],
    expiresAt
  } satisfies PreviewTokenGrant), {
    // Workers KV requires expirationTtl >= 60. The explicit expiresAt check
    // below preserves the absolute capability deadline while an inherited token
    // approaches expiry and KV retains its record for the minimum full minute.
    expirationTtl: remainingSeconds
  });
  return token;
}

export async function validatePreviewToken(
  kv: KVNamespace,
  token: string,
  projectId: string,
  requestedPath: string,
  now = Date.now()
): Promise<PreviewTokenGrant | null> {
  const stored = await kv.get(previewTokenKey(token));
  if (!stored) {
    return null;
  }

  try {
    const value = JSON.parse(stored) as Partial<PreviewTokenGrant>;
    return (
      value.projectId === projectId &&
      typeof value.userId === "string" &&
      Array.isArray(value.allowedPaths) &&
      value.allowedPaths.every((path) => typeof path === "string") &&
      value.allowedPaths.includes(requestedPath) &&
      typeof value.expiresAt === "number" &&
      value.expiresAt > now
    )
      ? value as PreviewTokenGrant
      : null;
  } catch {
    return null;
  }
}

type PreviewTokenVariables = {
  sessionId: string;
  user: User;
  previewTokenExpiresAt?: number;
};

/**
 * Authenticate only preview reads carrying a short-lived, project-bound token.
 * Invalid or absent tokens deliberately fall through to normal session auth.
 */
export const previewTokenAuth = createMiddleware<{
  Bindings: Env;
  Variables: PreviewTokenVariables;
}>(async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    await next();
    return;
  }

  const url = new URL(c.req.url);
  const match = /^\/preview\/([^/]+)/.exec(url.pathname);
  const token = url.searchParams.get("pt");
  if (!match || !token) {
    await next();
    return;
  }

  let projectId: string;
  try {
    projectId = decodeURIComponent(match[1]);
  } catch {
    await next();
    return;
  }

  const prefix = `${match[0]}${url.pathname.startsWith(`${match[0]}/`) ? "/" : ""}`;
  const requestedPath = url.pathname.slice(prefix.length) || "index.html";
  const grant = await validatePreviewToken(
    c.env.SESSION_KV,
    token,
    projectId,
    requestedPath
  );
  if (grant) {
    c.set("user", { id: grant.userId, createdAt: new Date().toISOString() });
    c.set("sessionId", "preview-token");
    c.set("previewTokenExpiresAt", grant.expiresAt);
  }

  await next();
});
