import { createMiddleware } from "hono/factory";
import { getCookie, setCookie } from "hono/cookie";
import type { Env, LegacySessionRecord, User } from "../types";
import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from "./constants";

type SessionVariables = {
  sessionId: string;
  user: User;
};

function sessionKey(sessionId: string): string {
  return `session:${sessionId}`;
}

function isSessionRecord(value: unknown): value is LegacySessionRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Record<string, unknown>;
  return (
    typeof maybe.expiresAt === "string" &&
    !!maybe.user &&
    typeof maybe.user === "object" &&
    typeof (maybe.user as Record<string, unknown>).id === "string" &&
    typeof (maybe.user as Record<string, unknown>).createdAt === "string"
  );
}

async function readCurrentSession(env: Env, sessionId: string): Promise<User | null> {
  const fromKv = await env.SESSION_KV.get(sessionKey(sessionId), "json");
  if (fromKv && typeof fromKv === "object" && typeof (fromKv as Record<string, unknown>).id === "string") {
    return fromKv as User;
  }

  const legacy = await env.SITE_STUDIO_BUCKET.get(`sessions/${sessionId}.json`);
  if (!legacy) {
    return null;
  }

  const parsed = JSON.parse(await legacy.text()) as unknown;
  if (!isSessionRecord(parsed)) {
    return null;
  }

  if (Date.parse(parsed.expiresAt) < Date.now()) {
    return null;
  }

  await env.SESSION_KV.put(sessionKey(sessionId), JSON.stringify(parsed.user), {
    expirationTtl: SESSION_TTL_SECONDS
  });

  return parsed.user;
}

function createAnonymousUser(): User {
  return {
    id: `user_${crypto.randomUUID().replace(/-/g, "")}`,
    createdAt: new Date().toISOString()
  };
}

export const authMiddleware = createMiddleware<{ Bindings: Env; Variables: SessionVariables }>(async (c, next) => {
  const existingSessionId = c.get("sessionId") as string | undefined;
  const existingUser = c.get("user") as User | undefined;

  if (existingSessionId && existingUser) {
    await next();
    return;
  }

  let sessionId = getCookie(c, SESSION_COOKIE_NAME) || "";
  let user: User | null = null;

  if (sessionId) {
    user = await readCurrentSession(c.env, sessionId);
  }

  if (!user) {
    sessionId = crypto.randomUUID().replace(/-/g, "");
    user = createAnonymousUser();
    await c.env.SESSION_KV.put(sessionKey(sessionId), JSON.stringify(user), {
      expirationTtl: SESSION_TTL_SECONDS
    });

    setCookie(c, SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      maxAge: SESSION_TTL_SECONDS,
      path: "/",
      sameSite: "Strict",
      secure: new URL(c.req.url).protocol === "https:"
    });
  }

  c.set("sessionId", sessionId);
  c.set("user", user);
  await next();
});

export function getUser(c: { get: (key: "user") => User }): User {
  return c.get("user");
}
