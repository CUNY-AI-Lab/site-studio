import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../types";
import {
  validateHandle,
  checkHandle,
  claimHandle,
  getUserHandle,
  resolveHandleOwner,
  migrateHandle,
  handleRecordKey,
  userHandleRecordKey,
  RESERVED_HANDLES
} from "./handles";
import { createHandleRouter } from "../routes/handles";

// Mock R2 bucket (same shape as storage/r2.test.ts / migration.test.ts).
function createMockBucket() {
  const store = new Map<string, { data: ArrayBuffer | string; httpMetadata?: any }>();
  return {
    store,
    head: vi.fn(async (key: string) => (store.has(key) ? { key, size: 0 } : null)),
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      const data = entry.data;
      return {
        key,
        text: async () => (typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer))
      };
    }),
    put: vi.fn(async (key: string, data: any, options?: any) => {
      store.set(key, { data: typeof data === "string" ? data : String(data), httpMetadata: options?.httpMetadata });
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async () => ({ objects: [], truncated: false, delimitedPrefixes: [] }))
  } as unknown as R2Bucket & { store: Map<string, any> };
}

describe("validateHandle", () => {
  const cases: Array<[string, boolean, string?]> = [
    // good
    ["jane-rivera", true],
    ["abc", true],
    ["a1b2c3", true],
    ["x".repeat(32), true],
    // bad shape
    ["ab", false, "too short"],
    ["x".repeat(33), false, "too long"],
    ["-jane", false, "leading hyphen"],
    ["jane-", false, "trailing hyphen"],
    ["ja--ne", false, "consecutive hyphens"],
    ["Jane", false, "uppercase"],
    ["jane_doe", false, "underscore"],
    ["jane.doe", false, "dot"],
    ["jane doe", false, "space"],
    ["", false, "empty"],
    // reserved
    ["admin", false, "reserved"],
    ["api", false, "reserved"],
    ["u", false, "reserved (and too short)"],
    ["cail", false, "reserved"],
    ["official", false, "reserved"]
  ];

  for (const [input, expected, why] of cases) {
    it(`${expected ? "accepts" : "rejects"} "${input}"${why ? ` (${why})` : ""}`, () => {
      expect(validateHandle(input).valid).toBe(expected);
    });
  }

  it("reports the normalized handle on success", () => {
    const result = validateHandle("  jane-rivera  ");
    expect(result).toEqual({ valid: true, handle: "jane-rivera" });
  });

  it("keeps the reserved list broad", () => {
    for (const word of ["admin", "api", "sites", "u", "cuny", "system"]) {
      expect(RESERVED_HANDLES.has(word)).toBe(true);
    }
  });
});

describe("checkHandle", () => {
  let bucket: ReturnType<typeof createMockBucket>;
  beforeEach(() => {
    bucket = createMockBucket();
  });

  it("reports invalid with a reason and available:false", async () => {
    const res = await checkHandle(bucket, "AB");
    expect(res.valid).toBe(false);
    expect(res.available).toBe(false);
    expect(res.reason).toBeTruthy();
  });

  it("reports valid + available for a free, well-formed handle", async () => {
    const res = await checkHandle(bucket, "jane-rivera");
    expect(res).toMatchObject({ handle: "jane-rivera", valid: true, available: true });
  });

  it("reports taken when owned by someone else", async () => {
    await claimHandle(bucket, "cail-owner", "jane-rivera");
    const res = await checkHandle(bucket, "jane-rivera");
    expect(res).toMatchObject({ valid: true, available: false });
    expect(res.reason).toContain("taken");
  });
});

describe("claimHandle", () => {
  let bucket: ReturnType<typeof createMockBucket>;
  beforeEach(() => {
    bucket = createMockBucket();
  });

  it("claims a free handle and writes both mapping records", async () => {
    const res = await claimHandle(bucket, "cail-a", "jane-rivera");
    expect(res).toEqual({ ok: true, handle: "jane-rivera", alreadyOwned: false });
    expect(await resolveHandleOwner(bucket, "jane-rivera")).toBe("cail-a");
    expect(await getUserHandle(bucket, "cail-a")).toBe("jane-rivera");
  });

  it("is idempotent when the user re-claims exactly their own handle", async () => {
    await claimHandle(bucket, "cail-a", "jane-rivera");
    const res = await claimHandle(bucket, "cail-a", "jane-rivera");
    expect(res).toEqual({ ok: true, handle: "jane-rivera", alreadyOwned: true });
  });

  it("refuses (409) when the user already owns a different handle", async () => {
    await claimHandle(bucket, "cail-a", "jane-rivera");
    const res = await claimHandle(bucket, "cail-a", "someone-else");
    expect(res).toEqual({ ok: false, status: 409, reason: expect.stringContaining("already have") });
  });

  it("refuses (409) when the handle is taken by another user", async () => {
    await claimHandle(bucket, "cail-a", "jane-rivera");
    const res = await claimHandle(bucket, "cail-b", "jane-rivera");
    expect(res).toEqual({ ok: false, status: 409, reason: expect.stringContaining("taken") });
  });

  it("refuses (400) an invalid handle", async () => {
    const res = await claimHandle(bucket, "cail-a", "AB");
    expect(res).toMatchObject({ ok: false, status: 400 });
  });

  it("anonymous (user_) owners may claim too", async () => {
    const res = await claimHandle(bucket, "user_anon", "anon-handle");
    expect(res.ok).toBe(true);
    expect(await resolveHandleOwner(bucket, "anon-handle")).toBe("user_anon");
  });
});

describe("createHandleRouter", () => {
  let bucket: ReturnType<typeof createMockBucket>;
  let app: Hono<{ Bindings: Env; Variables: { user: { id: string } } }>;
  const env = (b: R2Bucket) => ({ SITE_STUDIO_BUCKET: b }) as unknown as Env;

  beforeEach(() => {
    bucket = createMockBucket();
    app = new Hono<{ Bindings: Env; Variables: { user: { id: string } } }>();
    app.use("*", async (c, next) => {
      c.set("user", { id: "cail-me" });
      await next();
    });
    app.route("/", createHandleRouter());
  });

  it("GET /api/handle returns null before claiming, the handle after", async () => {
    const before = await app.request("/api/handle", {}, env(bucket));
    await expect(before.json()).resolves.toEqual({ handle: null });

    await claimHandle(bucket, "cail-me", "jane-rivera");
    const after = await app.request("/api/handle", {}, env(bucket));
    await expect(after.json()).resolves.toEqual({ handle: "jane-rivera" });
  });

  it("GET /api/handle/check reports validity and availability", async () => {
    const ok = await app.request("/api/handle/check?handle=jane-rivera", {}, env(bucket));
    await expect(ok.json()).resolves.toMatchObject({ valid: true, available: true });

    const bad = await app.request("/api/handle/check?handle=admin", {}, env(bucket));
    await expect(bad.json()).resolves.toMatchObject({ valid: false, available: false });
  });

  it("POST /api/handle claims and is idempotent; 409 on a different handle", async () => {
    const claim = await app.request(
      "/api/handle",
      { method: "POST", body: JSON.stringify({ handle: "jane-rivera" }), headers: { "Content-Type": "application/json" } },
      env(bucket)
    );
    expect(claim.status).toBe(200);
    await expect(claim.json()).resolves.toMatchObject({ handle: "jane-rivera", alreadyOwned: false });

    const again = await app.request(
      "/api/handle",
      { method: "POST", body: JSON.stringify({ handle: "jane-rivera" }), headers: { "Content-Type": "application/json" } },
      env(bucket)
    );
    expect(again.status).toBe(200);
    await expect(again.json()).resolves.toMatchObject({ alreadyOwned: true });

    const other = await app.request(
      "/api/handle",
      { method: "POST", body: JSON.stringify({ handle: "another-one" }), headers: { "Content-Type": "application/json" } },
      env(bucket)
    );
    expect(other.status).toBe(409);
  });

  it("POST /api/handle 409s when the handle is taken by someone else", async () => {
    await claimHandle(bucket, "cail-other", "jane-rivera");
    const res = await app.request(
      "/api/handle",
      { method: "POST", body: JSON.stringify({ handle: "jane-rivera" }), headers: { "Content-Type": "application/json" } },
      env(bucket)
    );
    expect(res.status).toBe(409);
  });

  it("no handle-route response body contains an owner/subject id (GET, check, and all POST outcomes)", async () => {
    const post = (handle: string) =>
      app.request(
        "/api/handle",
        { method: "POST", body: JSON.stringify({ handle }), headers: { "Content-Type": "application/json" } },
        env(bucket)
      );

    // Seed a competing owner so the taken-conflict body is exercised too.
    await claimHandle(bucket, "cail-other", "taken-one");

    const conflictTaken = await post("taken-one"); // 409: taken by cail-other
    const claim = await post("jane-rivera"); // 200: fresh claim by cail-me
    const idempotent = await post("jane-rivera"); // 200: alreadyOwned
    const conflictOwn = await post("another-one"); // 409: already has a different handle
    const get = await app.request("/api/handle", {}, env(bucket));
    const check = await app.request("/api/handle/check?handle=jane-rivera", {}, env(bucket));

    for (const res of [conflictTaken, claim, idempotent, conflictOwn, get, check]) {
      const body = await res.text();
      expect(body).not.toContain("cail-me");
      expect(body).not.toContain("cail-other");
    }
  });
});

describe("migrateHandle", () => {
  let bucket: ReturnType<typeof createMockBucket>;
  const ANON = "user_anon123";
  const SUBJECT = "cail-abc123";

  beforeEach(() => {
    bucket = createMockBucket();
  });

  it("re-homes an anon handle to a subject that has none (promotes to primary)", async () => {
    await claimHandle(bucket, ANON, "jane-rivera");

    await migrateHandle({ bucket, anonUserId: ANON, subject: SUBJECT });

    // Handle record now points at the subject; reverse record moved.
    expect(await resolveHandleOwner(bucket, "jane-rivera")).toBe(SUBJECT);
    expect(await getUserHandle(bucket, SUBJECT)).toBe("jane-rivera");
    expect(await getUserHandle(bucket, ANON)).toBeNull();
    // /u/{anonHandle}/ still resolves (now to the subject).
    expect(bucket.store.has(handleRecordKey("jane-rivera"))).toBe(true);
  });

  it("keeps the subject's own handle as primary but re-points the anon handle as an alias", async () => {
    await claimHandle(bucket, SUBJECT, "primary-handle");
    await claimHandle(bucket, ANON, "anon-handle");

    await migrateHandle({ bucket, anonUserId: ANON, subject: SUBJECT });

    // Subject keeps its own primary.
    expect(await getUserHandle(bucket, SUBJECT)).toBe("primary-handle");
    // The anon handle survives as an alias pointing at the subject.
    expect(await resolveHandleOwner(bucket, "anon-handle")).toBe(SUBJECT);
    // The anon reverse record is gone.
    expect(bucket.store.has(userHandleRecordKey(ANON))).toBe(false);
  });

  it("is a no-op when the anon user has no handle", async () => {
    await migrateHandle({ bucket, anonUserId: ANON, subject: SUBJECT });
    expect(await getUserHandle(bucket, SUBJECT)).toBeNull();
  });
});
