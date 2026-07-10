import { createMiddleware } from "hono/factory";
import type { Env, User } from "../types";

const PREVIEW_TOKEN_TTL_SECONDS = 600;

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
  projectId: string
): Promise<string> {
  const token = mintToken();
  await kv.put(previewTokenKey(token), JSON.stringify({ userId, projectId }), {
    expirationTtl: PREVIEW_TOKEN_TTL_SECONDS
  });
  return token;
}

export async function validatePreviewToken(
  kv: KVNamespace,
  token: string,
  projectId: string
): Promise<string | null> {
  const stored = await kv.get(previewTokenKey(token));
  if (!stored) {
    return null;
  }

  try {
    const value = JSON.parse(stored) as { userId?: unknown; projectId?: unknown };
    return value.projectId === projectId && typeof value.userId === "string"
      ? value.userId
      : null;
  } catch {
    return null;
  }
}

type PreviewTokenVariables = {
  sessionId: string;
  user: User;
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

  const userId = await validatePreviewToken(c.env.SESSION_KV, token, projectId);
  if (userId) {
    c.set("user", { id: userId, createdAt: new Date().toISOString() });
    c.set("sessionId", "preview-token");
  }

  await next();
});
