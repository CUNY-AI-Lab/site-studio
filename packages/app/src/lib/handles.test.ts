import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../types";
import {
  type HandleRecord,
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
import { csrfProtect } from "./csrf";
import { createMockKV, mintCsrfSession, type CsrfSession } from "./test-utils";
import { TEST_SUBJECTS, canonicalTestSubject } from "@cuny-ai-lab/cail-identity/testing";

// Canonical test subjects (cail-identity/testing kit) used as owner ids.
const OWNER = TEST_SUBJECTS.alice;
const RIVAL = TEST_SUBJECTS.bob;
const RACER_A = canonicalTestSubject("racer-a");
const RACER_B = canonicalTestSubject("racer-b");
const SELF_RACER = canonicalTestSubject("self-racer");
const ROUTE_USER = canonicalTestSubject("route-user");
const OTHER_USER = canonicalTestSubject("other-user");

// Mock R2 bucket (same shape as storage/r2.test.ts / migration.test.ts).
function createMockBucket() {
  let revision = 0;
  const store = new Map<string, { data: ArrayBuffer | string; httpMetadata?: any; etag?: string }>();
  return {
    store,
    head: vi.fn(async (key: string) => (store.has(key) ? { key, size: 0 } : null)),
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      const data = entry.data;
      return {
        key,
        etag: entry.etag,
        text: async () => (typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer))
      };
    }),
    put: vi.fn(async (key: string, data: any, options?: any) => {
      // Honor R2 put-if-absent: onlyIf.etagDoesNotMatch:"*" writes only when the
      // key is empty; a failed condition returns null (no write, no throw).
      if (options?.onlyIf?.etagDoesNotMatch === "*" && store.has(key)) {
        return null;
      }
      if (options?.onlyIf?.etagMatches && store.get(key)?.etag !== options.onlyIf.etagMatches) {
        return null;
      }
      const etag = `etag-${++revision}`;
      store.set(key, { data: typeof data === "string" ? data : String(data), httpMetadata: options?.httpMetadata, etag });
      return { key, etag };
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
    await claimHandle(bucket, OWNER, "jane-rivera");
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
    const res = await claimHandle(bucket, OWNER, "jane-rivera");
    expect(res).toEqual({ ok: true, handle: "jane-rivera", alreadyOwned: false });
    expect(await resolveHandleOwner(bucket, "jane-rivera")).toBe(OWNER);
    expect(await getUserHandle(bucket, OWNER)).toBe("jane-rivera");
  });

  it("is idempotent when the user re-claims exactly their own handle", async () => {
    await claimHandle(bucket, OWNER, "jane-rivera");
    const res = await claimHandle(bucket, OWNER, "jane-rivera");
    expect(res).toEqual({ ok: true, handle: "jane-rivera", alreadyOwned: true });
  });

  it("refuses (409) when the user already owns a different handle", async () => {
    await claimHandle(bucket, OWNER, "jane-rivera");
    const res = await claimHandle(bucket, OWNER, "someone-else");
    expect(res).toEqual({ ok: false, status: 409, reason: expect.stringContaining("already have") });
  });

  it("refuses (409) when the handle is taken by another user", async () => {
    await claimHandle(bucket, OWNER, "jane-rivera");
    const res = await claimHandle(bucket, RIVAL, "jane-rivera");
    expect(res).toEqual({ ok: false, status: 409, reason: expect.stringContaining("taken") });
  });

  it("refuses (400) an invalid handle", async () => {
    const res = await claimHandle(bucket, OWNER, "AB");
    expect(res).toMatchObject({ ok: false, status: 400 });
  });

  it("anonymous (user_) owners may claim too", async () => {
    const res = await claimHandle(bucket, "user_anon", "anon-handle");
    expect(res.ok).toBe(true);
    expect(await resolveHandleOwner(bucket, "anon-handle")).toBe("user_anon");
  });

  it("self-heals when the handle record points at us but the reverse slot is missing", async () => {
    // Simulate a half-written prior claim: handle record exists (owned by us),
    // reverse record absent. Re-claiming must succeed idempotently and restore
    // the reverse record without clobbering the handle record.
    await bucket.put(handleRecordKey("jane-rivera"), JSON.stringify({ ownerId: OWNER, claimedAt: "t0" }));
    const res = await claimHandle(bucket, OWNER, "jane-rivera");
    expect(res).toEqual({ ok: true, handle: "jane-rivera", alreadyOwned: true });
    expect(await getUserHandle(bucket, OWNER)).toBe("jane-rivera");
    expect(await resolveHandleOwner(bucket, "jane-rivera")).toBe(OWNER);
  });

  it("does not treat a reverse-only or mismatched mapping as an owned handle", async () => {
    await bucket.put(
      userHandleRecordKey(OWNER),
      JSON.stringify({ handle: "stale-handle", claimedAt: "2020-01-01T00:00:00.000Z" })
    );
    expect(await getUserHandle(bucket, OWNER)).toBeNull();

    await bucket.put(
      handleRecordKey("stale-handle"),
      JSON.stringify({ ownerId: RIVAL, claimedAt: "2020-01-01T00:00:01.000Z" })
    );
    expect(await getUserHandle(bucket, OWNER)).toBeNull();
    expect(await getUserHandle(bucket, RIVAL)).toBeNull();
  });
});

// SS-3 residual #2: a process death BETWEEN claimHandle's two put-if-absent
// writes can leave a reverse slot `userhandles/{owner}` with no matching forward
// `handles/{handle}` record (or a forward owned by someone else). The old fast
// path returned "you already have a handle" on the reverse slot alone, HIDING
// the orphan. The repair CAS-replaces the stale reverse generation with the new
// claim and lets it proceed; a HEALTHY reverse+forward pair still yields the
// normal 409/idempotent behavior.
describe("claimHandle reverse-orphan reaper (SS-3 residual #2)", () => {
  let bucket: ReturnType<typeof createMockBucket>;
  beforeEach(() => {
    bucket = createMockBucket();
  });

  it("reaps an orphaned reverse slot (forward MISSING) and lets the SAME handle claim proceed", async () => {
    // Reverse slot written, forward `handles/…` never written (crash between puts).
    await bucket.put(userHandleRecordKey(OWNER), JSON.stringify({ handle: "jane-rivera", claimedAt: "2020-01-01T00:00:00.000Z" }));
    expect(bucket.store.has(handleRecordKey("jane-rivera"))).toBe(false);

    const res = await claimHandle(bucket, OWNER, "jane-rivera");
    // Claim proceeds cleanly to a fresh, fully-formed claim (not a false "already have").
    expect(res).toEqual({ ok: true, handle: "jane-rivera", alreadyOwned: false });
    expect(await getUserHandle(bucket, OWNER)).toBe("jane-rivera");
    expect(await resolveHandleOwner(bucket, "jane-rivera")).toBe(OWNER);
  });

  it("reaps an orphaned reverse slot and lets a DIFFERENT handle claim proceed (no false 409)", async () => {
    // Orphan points at a handle the owner never truly claimed (forward missing).
    await bucket.put(userHandleRecordKey(OWNER), JSON.stringify({ handle: "orphaned-one", claimedAt: "2020-01-01T00:00:00.000Z" }));

    // Owner now claims a DIFFERENT, free handle. The orphan must not 409 them.
    const res = await claimHandle(bucket, OWNER, "brand-new");
    expect(res).toEqual({ ok: true, handle: "brand-new", alreadyOwned: false });
    expect(await getUserHandle(bucket, OWNER)).toBe("brand-new");
    // The orphan forward record still doesn't exist (never was written).
    expect(await resolveHandleOwner(bucket, "orphaned-one")).toBeNull();
  });

  it("reaps a reverse slot whose forward record points at a STRANGER, then resolves against real state", async () => {
    // Crash left reverse {OWNER -> shared}, then RIVAL legitimately won `shared`.
    await bucket.put(userHandleRecordKey(OWNER), JSON.stringify({ handle: "shared", claimedAt: "2020-01-01T00:00:00.000Z" }));
    await claimHandle(bucket, RIVAL, "shared"); // RIVAL owns the forward record

    // OWNER re-claims the very handle it's orphaned against: it does NOT own it,
    // so this must resolve to a taken-409 (not a false idempotent success).
    const res = await claimHandle(bucket, OWNER, "shared");
    expect(res).toEqual({ ok: false, status: 409, reason: expect.stringContaining("taken") });
    // The orphan reverse slot was reaped; OWNER owns nothing.
    expect(await getUserHandle(bucket, OWNER)).toBeNull();
    // RIVAL's healthy ownership is intact.
    expect(await resolveHandleOwner(bucket, "shared")).toBe(RIVAL);
  });

  it("does NOT reap a HEALTHY different-handle pair: still 409s", async () => {
    // Legitimate full claim of a different handle.
    await claimHandle(bucket, OWNER, "jane-rivera");
    // Asking for a new handle must 409 (owner already has a valid handle).
    const res = await claimHandle(bucket, OWNER, "someone-else");
    expect(res).toEqual({ ok: false, status: 409, reason: expect.stringContaining("already have") });
    // The healthy pair is untouched.
    expect(await getUserHandle(bucket, OWNER)).toBe("jane-rivera");
    expect(await resolveHandleOwner(bucket, "jane-rivera")).toBe(OWNER);
  });

  it("SS-32: a concurrent orphan repair cannot erase the healthy CAS winner", async () => {
    const ownerId = OWNER;
    await bucket.put(userHandleRecordKey(ownerId), JSON.stringify({ handle: "orphaned-one", claimedAt: "2020-01-01T00:00:00.000Z" }));

    const originalPut = bucket.put;
    let injected = false;
    bucket.put = vi.fn(async (key: string, data: any, options?: any) => {
      if (
        key === userHandleRecordKey(ownerId) &&
        options?.onlyIf?.etagMatches &&
        String(data).includes('"beta"') &&
        !injected
      ) {
        injected = true;
        const winner = await claimHandle(bucket, ownerId, "alpha", () => "t1");
        expect(winner).toEqual({ ok: true, handle: "alpha", alreadyOwned: false });
      }
      return originalPut(key, data, options);
    }) as typeof bucket.put;

    const res = await claimHandle(bucket, ownerId, "beta", () => "t2");
    expect(res).toEqual({ ok: false, status: 409, reason: expect.stringContaining("already have") });

    const forwardHandles = [...bucket.store.entries()]
      .filter(([key]) => key.startsWith("handles/"))
      .map(([key, entry]) => ({
        key,
        record: JSON.parse(entry.data as string) as HandleRecord
      }))
      .filter(({ record }) => record.ownerId === ownerId);

    expect(forwardHandles).toEqual([
      {
        key: handleRecordKey("alpha"),
        record: { ownerId, claimedAt: "t1" }
      }
    ]);
    expect(await getUserHandle(bucket, ownerId)).toBe("alpha");
    expect(await resolveHandleOwner(bucket, "alpha")).toBe(ownerId);
    expect(await resolveHandleOwner(bucket, "beta")).toBeNull();
  });

  it("does not reap a fresh reverse record while its forward claim is still in flight", async () => {
    const ownerId = OWNER;
    let releaseForward!: () => void;
    let forwardStarted!: () => void;
    const release = new Promise<void>((resolve) => (releaseForward = resolve));
    const started = new Promise<void>((resolve) => (forwardStarted = resolve));
    const originalPut = bucket.put;
    let paused = false;
    bucket.put = vi.fn(async (key: string, data: any, options?: any) => {
      if (key === handleRecordKey("alpha") && !paused) {
        paused = true;
        forwardStarted();
        await release;
      }
      return originalPut(key, data, options);
    }) as typeof bucket.put;

    const first = claimHandle(bucket, ownerId, "alpha", () => "2026-07-14T12:00:00.000Z");
    await started;
    const second = await claimHandle(bucket, ownerId, "beta", () => "2026-07-14T12:00:01.000Z");
    releaseForward();
    const firstResult = await first;

    expect(firstResult).toEqual({ ok: true, handle: "alpha", alreadyOwned: false });
    expect(second).toEqual({ ok: false, status: 409, reason: expect.stringContaining("in progress") });
    expect(await getUserHandle(bucket, ownerId)).toBe("alpha");
    expect(await resolveHandleOwner(bucket, "alpha")).toBe(ownerId);
    expect(await resolveHandleOwner(bucket, "beta")).toBeNull();
  });
});

// SS-4: read-check-write against R2 with no compare-and-set lets two concurrent
// claims both "win", or a single user racing two handles end up owning two. The
// put-if-absent claim must make exactly one winner and leave NO orphan records.
describe("claimHandle races (SS-4)", () => {
  let bucket: ReturnType<typeof createMockBucket>;
  beforeEach(() => {
    bucket = createMockBucket();
  });

  it("two users racing the SAME handle: exactly one wins, loser leaves no orphan", async () => {
    const [a, b] = await Promise.all([
      claimHandle(bucket, RACER_A, "shared-one"),
      claimHandle(bucket, RACER_B, "shared-one")
    ]);

    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ ok: false, status: 409 });

    // The handle record points at exactly one owner, and that owner's reverse
    // record agrees. The loser owns NO handle (its reverse slot was rolled back).
    const owner = await resolveHandleOwner(bucket, "shared-one");
    expect(owner === RACER_A || owner === RACER_B).toBe(true);
    const loserId = owner === RACER_A ? RACER_B : RACER_A;
    expect(await getUserHandle(bucket, owner!)).toBe("shared-one");
    expect(await getUserHandle(bucket, loserId)).toBeNull();
  });

  it("one user racing TWO different handles: ends up owning exactly one, no orphan handle record", async () => {
    const [a, b] = await Promise.all([
      claimHandle(bucket, SELF_RACER, "handle-aaa"),
      claimHandle(bucket, SELF_RACER, "handle-bbb")
    ]);

    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ ok: false, status: 409, reason: expect.stringContaining("already have") });

    // The user owns exactly one handle, and the OTHER handle record must not
    // exist as an orphan (the loser wrote nothing under handles/…).
    const owned = await getUserHandle(bucket, SELF_RACER);
    expect(owned === "handle-aaa" || owned === "handle-bbb").toBe(true);
    const orphan = owned === "handle-aaa" ? "handle-bbb" : "handle-aaa";
    expect(await resolveHandleOwner(bucket, owned!)).toBe(SELF_RACER);
    expect(await resolveHandleOwner(bucket, orphan)).toBeNull();
  });
});

describe("createHandleRouter", () => {
  let bucket: ReturnType<typeof createMockBucket>;
  let app: Hono<{ Bindings: Env; Variables: { user: { id: string } } }>;
  let kv: ReturnType<typeof createMockKV>;
  let csrf: CsrfSession;
  const env = (b: R2Bucket) => ({ CAIL_LOG_ENV: "test", SITE_STUDIO_BUCKET: b, SESSION_KV: kv }) as unknown as Env;
  // Every POST carries the session CSRF token + same-origin posture, matching
  // production where csrfProtect guards all /api mutations (lib/csrf.ts).
  const postHeaders = () => ({ "Content-Type": "application/json", ...csrf.headers });

  beforeEach(async () => {
    bucket = createMockBucket();
    kv = createMockKV();
    csrf = await mintCsrfSession(bucket, ROUTE_USER);
    app = new Hono<{ Bindings: Env; Variables: { user: { id: string } } }>();
    app.use("*", async (c, next) => {
      c.set("user", { id: ROUTE_USER });
      await next();
    });
    app.use("*", csrfProtect);
    app.route("/", createHandleRouter());
  });

  it("GET /api/handle returns null before claiming, the handle after", async () => {
    const before = await app.request("/api/handle", {}, env(bucket));
    await expect(before.json()).resolves.toEqual({ handle: null });

    await claimHandle(bucket, ROUTE_USER, "jane-rivera");
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
      { method: "POST", body: JSON.stringify({ handle: "jane-rivera" }), headers: postHeaders() },
      env(bucket)
    );
    expect(claim.status).toBe(200);
    await expect(claim.json()).resolves.toMatchObject({ handle: "jane-rivera", alreadyOwned: false });

    const again = await app.request(
      "/api/handle",
      { method: "POST", body: JSON.stringify({ handle: "jane-rivera" }), headers: postHeaders() },
      env(bucket)
    );
    expect(again.status).toBe(200);
    await expect(again.json()).resolves.toMatchObject({ alreadyOwned: true });

    const other = await app.request(
      "/api/handle",
      { method: "POST", body: JSON.stringify({ handle: "another-one" }), headers: postHeaders() },
      env(bucket)
    );
    expect(other.status).toBe(409);
  });

  it("POST /api/handle 409s when the handle is taken by someone else", async () => {
    await claimHandle(bucket, OTHER_USER, "jane-rivera");
    const res = await app.request(
      "/api/handle",
      { method: "POST", body: JSON.stringify({ handle: "jane-rivera" }), headers: postHeaders() },
      env(bucket)
    );
    expect(res.status).toBe(409);
  });

  it("no handle-route response body contains an owner/subject id (GET, check, and all POST outcomes)", async () => {
    const post = (handle: string) =>
      app.request(
        "/api/handle",
        { method: "POST", body: JSON.stringify({ handle }), headers: postHeaders() },
        env(bucket)
      );

    // Seed a competing owner so the taken-conflict body is exercised too.
    await claimHandle(bucket, OTHER_USER, "taken-one");

    const conflictTaken = await post("taken-one"); // 409: taken by OTHER_USER
    const claim = await post("jane-rivera"); // 200: fresh claim by ROUTE_USER
    const idempotent = await post("jane-rivera"); // 200: alreadyOwned
    const conflictOwn = await post("another-one"); // 409: already has a different handle
    const get = await app.request("/api/handle", {}, env(bucket));
    const check = await app.request("/api/handle/check?handle=jane-rivera", {}, env(bucket));

    for (const res of [conflictTaken, claim, idempotent, conflictOwn, get, check]) {
      const body = await res.text();
      expect(body).not.toContain(ROUTE_USER);
      expect(body).not.toContain(OTHER_USER);
    }
  });
});

describe("migrateHandle", () => {
  let bucket: ReturnType<typeof createMockBucket>;
  const ANON = "user_anon123";
  const SUBJECT = TEST_SUBJECTS.carol;

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

  it("refuses to re-home an orphaned reverse record over another owner's forward claim", async () => {
    await bucket.put(
      userHandleRecordKey(ANON),
      JSON.stringify({ handle: "shared-handle", claimedAt: "2026-07-14T12:00:00.000Z" })
    );
    await bucket.put(
      handleRecordKey("shared-handle"),
      JSON.stringify({ ownerId: RIVAL, claimedAt: "2026-07-14T12:00:01.000Z" })
    );

    await expect(migrateHandle({ bucket, anonUserId: ANON, subject: SUBJECT })).rejects.toThrow(
      "ownership changed"
    );
    expect(await resolveHandleOwner(bucket, "shared-handle")).toBe(RIVAL);
    expect(await getUserHandle(bucket, ANON)).toBeNull();
    expect(bucket.store.has(userHandleRecordKey(ANON))).toBe(true);
    expect(await getUserHandle(bucket, SUBJECT)).toBeNull();
  });

  // SS-52: migrateHandle's promotion used to be read-check-then-plain-put on
  // `userhandles/{subject}` — the one key the subject's own POST /api/handle
  // CAS-claims concurrently (claimHandle step 1). Losing that race and then
  // writing anyway CLOBBERED the just-claimed reverse slot, permanently
  // orphaning the claimed handle: its forward record points at the subject
  // forever, but no reverse slot names it, so it is neither usable nor
  // re-claimable. The promotion must be put-if-absent and must NOT overwrite.
  it("SS-52: does not clobber a reverse slot the subject CAS-claimed concurrently", async () => {
    await claimHandle(bucket, ANON, "anon-handle");

    const originalPut = bucket.put;
    let injected = false;
    bucket.put = vi.fn(async (key: string, data: any, options?: any) => {
      if (key === userHandleRecordKey(SUBJECT) && !injected) {
        injected = true;
        // Lands in migrateHandle's check-to-write window: the subject's own
        // POST /api/handle claims a handle right before the promotion write.
        const claim = await claimHandle(bucket, SUBJECT, "my-new-handle");
        expect(claim.ok).toBe(true);
      }
      return originalPut(key, data, options);
    }) as typeof bucket.put;

    await migrateHandle({ bucket, anonUserId: ANON, subject: SUBJECT });

    // The subject's own concurrent claim survives as the primary...
    expect(await getUserHandle(bucket, SUBJECT)).toBe("my-new-handle");
    expect(await resolveHandleOwner(bucket, "my-new-handle")).toBe(SUBJECT);
    // ...and the anon handle stays an alias pointing at the subject.
    expect(await resolveHandleOwner(bucket, "anon-handle")).toBe(SUBJECT);
    // The anon reverse record is still cleaned up.
    expect(bucket.store.has(userHandleRecordKey(ANON))).toBe(false);
  });
});
