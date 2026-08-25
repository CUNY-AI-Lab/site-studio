import { describe, it, expect, beforeEach, vi } from "vitest";
import { canonicalTestSubject } from "@cuny-ai-lab/cail-identity/testing";
import { z } from "zod";
import type { ProjectMetadata } from "../types";
import {
  migrateAnonymousData,
  migrationClaimKey,
  migrationPendingKey,
  type ChatHistoryPorter,
  type MigrationClaim
} from "./migration";
import { getUserHandle } from "./handles";
import { createMockKV as createSharedMockKV, createTestR2Object } from "./test-utils";

function testConditional(options?: R2PutOptions): R2Conditional | undefined {
  const conditional = options?.onlyIf;
  return conditional instanceof Headers ? undefined : conditional;
}

function testMetadata(options?: R2PutOptions): R2HTTPMetadata | undefined {
  const metadata = options?.httpMetadata;
  return metadata instanceof Headers ? undefined : metadata;
}

// Mock R2 bucket (same shape as storage/r2.test.ts).
function createMockBucket() {
  let revision = 0;
  const store = new Map<string, { data: string; httpMetadata?: R2HTTPMetadata; etag?: string }>();

  function textData(data: string | ArrayBuffer | Uint8Array): string {
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    if (data instanceof Uint8Array) return new TextDecoder().decode(data);
    return data;
  }

  // SAFETY: This fixture implements the R2 methods exercised by account import;
  // uncalled binding methods are outside this test boundary.
  return {
    store,
    head: vi.fn(async (key: string) => {
      return store.has(key) ? { key, size: 0 } : null;
    }),
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      entry.etag ??= `etag-${++revision}`;
      return {
        key,
        etag: entry.etag,
        size: entry.data.length,
        httpMetadata: entry.httpMetadata || {},
        text: async () => entry.data,
        arrayBuffer: async () => new TextEncoder().encode(entry.data).buffer
      };
    }),
    put: vi.fn(async (key: string, data: string | ArrayBuffer | Uint8Array, options?: R2PutOptions) => {
      // Honor R2 put-if-absent: onlyIf.etagDoesNotMatch:"*" writes only when
      // the key is empty; a failed condition returns null (no write, no throw).
      // migrateHandle's promotion (SS-52) relies on this contract.
      const conditional = testConditional(options);
      if (conditional?.etagDoesNotMatch === "*" && store.has(key)) {
        return null;
      }
      if (conditional?.etagMatches && store.get(key)?.etag !== conditional.etagMatches) {
        return null;
      }
      const text = textData(data);
      const etag = `etag-${++revision}`;
      store.set(key, { data: text, httpMetadata: testMetadata(options), etag });
      return createTestR2Object(key, etag, text.length);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async ({ prefix, delimiter, limit }: R2ListOptions = {}) => {
      const objects: R2Object[] = [];
      const delimitedPrefixes: string[] = [];

      for (const key of store.keys()) {
        if (prefix && !key.startsWith(prefix)) continue;

        if (delimiter) {
          const rest = key.slice(prefix?.length || 0);
          const delimIndex = rest.indexOf(delimiter);
          if (delimIndex >= 0) {
            const delimitedPrefix = (prefix || "") + rest.slice(0, delimIndex + 1);
            if (!delimitedPrefixes.includes(delimitedPrefix)) {
              delimitedPrefixes.push(delimitedPrefix);
            }
            continue;
          }
        }

        objects.push(createTestR2Object(key));
      }

      return {
        objects: limit ? objects.slice(0, limit) : objects,
        truncated: false,
        delimitedPrefixes
      };
    }),
    createMultipartUpload: vi.fn(async () => { throw new Error("multipart upload is not part of this fixture"); }),
    resumeMultipartUpload: vi.fn(() => { throw new Error("multipart upload is not part of this fixture"); })
  } as R2Bucket & { store: Map<string, { data: string; httpMetadata?: R2HTTPMetadata; etag?: string }> };
}

function createMockKV() {
  return createSharedMockKV();
}

const ANON = "user_anon123";
const SUBJECT = canonicalTestSubject("migration-owner");

/** Copied objects are stored as strings by the mock. */
function textOf(entry: { data: string } | undefined): string | undefined {
  if (!entry) return undefined;
  return entry.data;
}

function metadataFor(id: string, extra: Partial<ProjectMetadata> = {}): string {
  return JSON.stringify({
    id,
    name: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    published: false,
    ...extra
  } satisfies ProjectMetadata);
}

function seedAnonProject(
  bucket: ReturnType<typeof createMockBucket>,
  projectId: string,
  extra: Partial<ProjectMetadata> = {},
  content = `<h1>${projectId} (anon)</h1>`
) {
  bucket.store.set(`projects/${ANON}/${projectId}/.metadata.json`, { data: metadataFor(projectId, extra) });
  bucket.store.set(`projects/${ANON}/${projectId}/index.html`, { data: content });
}

function seedAnonHandle(
  bucket: ReturnType<typeof createMockBucket>,
  handle = "jane-rivera",
) {
  const claimedAt = "2026-01-01T00:00:00.000Z";
  bucket.store.set(`handles/${handle}.json`, {
    data: JSON.stringify({ ownerId: ANON, claimedAt })
  });
  bucket.store.set(`userhandles/${ANON}.json`, {
    data: JSON.stringify({ handle, claimedAt })
  });
}

describe("migrateAnonymousData", () => {
  let bucket: ReturnType<typeof createMockBucket>;
  let kv: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    bucket = createMockBucket();
    kv = createMockKV();
  });

  const run = (overrides: Partial<Parameters<typeof migrateAnonymousData>[0]> = {}) =>
    migrateAnonymousData({
      bucket,
      kv,
      anonUserId: ANON,
      subject: SUBJECT,
      anonSessionId: "anon-session-id",
      ...overrides
    });

  it("migrates projects, snapshots, and uploads into the subject namespace (happy path)", async () => {
    seedAnonProject(bucket, "portfolio");
    bucket.store.set(`projects/${ANON}/portfolio/styles.css`, { data: "body{}" });
    bucket.store.set(`snapshots/${ANON}/portfolio/snap1.zip`, { data: "zipbytes" });
    bucket.store.set(`snapshots/${ANON}/portfolio/snap1.json`, {
      data: JSON.stringify({ id: "snap1", createdAt: "2026-01-02T00:00:00.000Z", projectId: "portfolio", trigger: "manual", fileCount: 2 })
    });
    bucket.store.set(`uploads/${ANON}/paper.pdf`, { data: "pdfbytes" });
    kv.store.set("session:anon-session-id", JSON.stringify({ id: ANON, createdAt: "2026-01-01T00:00:00.000Z" }));

    const ported: string[] = [];
    const porter: ChatHistoryPorter = {
      port: async (fromOwner, fromId, toOwner, toId) => {
        ported.push(`${fromOwner}:${fromId}->${toOwner}:${toId}`);
      }
    };

    const result = await run({ porter });
    expect(result.status).toBe("migrated");
    expect(result.projects).toEqual({ portfolio: "portfolio" });

    // Subject now owns the data.
    const meta = JSON.parse(bucket.store.get(`projects/${SUBJECT}/portfolio/.metadata.json`)!.data);
    expect(meta.id).toBe("portfolio");
    expect(meta.importedFrom).toBe(ANON);
    expect(meta.importedOriginalId).toBe("portfolio");
    expect(textOf(bucket.store.get(`projects/${SUBJECT}/portfolio/index.html`))).toContain("(anon)");
    expect(bucket.store.get(`projects/${SUBJECT}/portfolio/styles.css`)).toBeTruthy();
    expect(bucket.store.get(`snapshots/${SUBJECT}/portfolio/snap1.zip`)).toBeTruthy();
    const snapRecord = JSON.parse(bucket.store.get(`snapshots/${SUBJECT}/portfolio/snap1.json`)!.data);
    expect(snapRecord.projectId).toBe("portfolio");
    expect(bucket.store.get(`uploads/${SUBJECT}/paper.pdf`)).toBeTruthy();

    // Chat history ported with mapped ids.
    expect(ported).toEqual([`${ANON}:portfolio->${SUBJECT}:portfolio`]);

    // Originals are retired after the complete copy.
    expect(bucket.store.get(`projects/${ANON}/portfolio/index.html`)).toBeUndefined();
    expect(bucket.store.get(`snapshots/${ANON}/portfolio/snap1.zip`)).toBeUndefined();
    expect(bucket.store.get(`uploads/${ANON}/paper.pdf`)).toBeUndefined();
    expect([...bucket.store.keys()].some((key) => key.startsWith(`projects/${ANON}/`))).toBe(false);

    // Claim recorded complete; anon session and pending marker cleared.
    // SAFETY: The migration service writes this KV value from the MigrationClaim schema.
    const claim = JSON.parse(kv.store.get(migrationClaimKey(ANON))!) as MigrationClaim;
    expect(claim).toMatchObject({ subject: SUBJECT, status: "complete" });
    expect(kv.store.has("session:anon-session-id")).toBe(false);
    expect(kv.store.has(migrationPendingKey(SUBJECT))).toBe(false);
  });

  it("is idempotent: a second run is a no-op that changes nothing", async () => {
    seedAnonProject(bucket, "portfolio");
    await run();

    const snapshotBefore = new Map(
      [...bucket.store.entries()].map(([k, v]) => [k, v.data])
    );
    const second = await run();

    expect(second.status).toBe("already-complete");
    expect(bucket.store.size).toBe(snapshotBefore.size);
    for (const [key, data] of snapshotBefore) {
      expect(bucket.store.get(key)?.data).toBe(data);
    }
  });

  it("merges without overwriting: colliding project ids are suffixed, subject data untouched", async () => {
    // Subject already owns "site" with its own content.
    bucket.store.set(`projects/${SUBJECT}/site/.metadata.json`, { data: metadataFor("site") });
    bucket.store.set(`projects/${SUBJECT}/site/index.html`, { data: "<h1>subject original</h1>" });

    // Anonymous namespace has a colliding "site" and a non-colliding "blog".
    seedAnonProject(bucket, "site");
    seedAnonProject(bucket, "blog");

    const result = await run();
    expect(result.status).toBe("migrated");
    expect(result.projects).toEqual({ site: "site-imported", blog: "blog" });

    // Subject's original is byte-identical.
    expect(bucket.store.get(`projects/${SUBJECT}/site/index.html`)!.data).toBe("<h1>subject original</h1>");
    // Incoming copy lives under the suffixed id with its own content.
    const imported = JSON.parse(bucket.store.get(`projects/${SUBJECT}/site-imported/.metadata.json`)!.data);
    expect(imported.id).toBe("site-imported");
    expect(imported.importedOriginalId).toBe("site");
    expect(textOf(bucket.store.get(`projects/${SUBJECT}/site-imported/index.html`))).toContain("(anon)");
    // Non-colliding project keeps its id.
    expect(bucket.store.get(`projects/${SUBJECT}/blog/index.html`)).toBeTruthy();
  });

  it("preserves both namespaces when a subject write wins the copy-if-absent race", async () => {
    seedAnonProject(bucket, "portfolio", {}, "<h1>anonymous source</h1>");
    const destination = `projects/${SUBJECT}/portfolio/index.html`;
    const originalPut = bucket.put;
    let injected = false;
    // SAFETY: This replacement preserves the R2 put signature while injecting
    // a subject-side writer for the copy-if-absent race.
    bucket.put = vi.fn(async (key: string, data: string, options?: R2PutOptions) => {
      if (key === destination && !injected) {
        injected = true;
        await originalPut(destination, "<h1>subject concurrent edit</h1>");
      }
      return originalPut(key, data, options);
    });

    await expect(run()).rejects.toThrow("destination changed");
    expect(textOf(bucket.store.get(destination))).toBe("<h1>subject concurrent edit</h1>");
    expect(textOf(bucket.store.get(`projects/${ANON}/portfolio/index.html`))).toBe(
      "<h1>anonymous source</h1>"
    );
    // SAFETY: The failed migration leaves the claim in its documented pending shape.
    const claim = JSON.parse(kv.store.get(migrationClaimKey(ANON))!) as MigrationClaim;
    expect(claim.status).toBe("pending");
  });

  it("claims once: a second subject is refused and receives nothing", async () => {
    seedAnonProject(bucket, "portfolio");
    await run(); // SUBJECT claims and completes

    const otherSubject = canonicalTestSubject("other-owner");
    const result = await run({ subject: otherSubject, anonSessionId: undefined });

    expect(result.status).toBe("refused");
    // SAFETY: The completed first claim is stored using the MigrationClaim schema.
    const claim = JSON.parse(kv.store.get(migrationClaimKey(ANON))!) as MigrationClaim;
    expect(claim.subject).toBe(SUBJECT); // original claim untouched
    const otherKeys = [...bucket.store.keys()].filter((k) => k.includes(otherSubject));
    expect(otherKeys).toEqual([]);
  });

  it("fails loud on a KV outage during the claim read (never proceeds as unclaimed)", async () => {
    // rule 5: the claim read is the security-critical claim-once gate. A
    // swallowed KV outage here would read as "no existing claim" and let a
    // SECOND subject migrate into a namespace another subject already owns.
    seedAnonProject(bucket, "portfolio");
    const outage = new Error("KV read failed");
    // SAFETY: createMockKV's get function is a Vitest spy; this test replaces
    // its implementation to inject the deliberate KV failure.
    const getMock = kv.get as ReturnType<typeof vi.fn>;
    getMock.mockImplementation(async (key: string) => {
      if (key === migrationClaimKey(ANON)) throw outage;
      return null;
    });

    await expect(run()).rejects.toThrow("KV read failed");

    // The guard was NOT bypassed: nothing was copied into the subject namespace.
    const subjectKeys = [...bucket.store.keys()].filter((k) => k.includes(SUBJECT));
    expect(subjectKeys).toEqual([]);
  });

  it("refuses non-anonymous ids (never migrates a subject namespace)", async () => {
    const result = await run({ anonUserId: canonicalTestSubject("non-anonymous-id") });
    expect(result.status).toBe("refused");
    expect(kv.store.size).toBe(0);
  });

  it("completes with nothing-to-migrate when the anonymous namespace is empty", async () => {
    kv.store.set("session:anon-session-id", JSON.stringify({ id: ANON, createdAt: "2026-01-01T00:00:00.000Z" }));
    const result = await run();

    expect(result.status).toBe("nothing-to-migrate");
    // SAFETY: The empty migration records completion using the MigrationClaim schema.
    const claim = JSON.parse(kv.store.get(migrationClaimKey(ANON))!) as MigrationClaim;
    expect(claim.status).toBe("complete");
    expect(kv.store.has("session:anon-session-id")).toBe(false);
  });

  /**
   * SS-54 regression rig: run `inject()` right after the nth bucket.list call
   * with exactly `triggerPrefix`. The injected keys are added AFTER the list
   * result is computed, so the listing that triggered the injection does not
   * see them — simulating a direct file-API write racing the migration.
   */
  function injectAfterList(triggerPrefix: string, nth: number, inject: () => void) {
    const original = bucket.list.bind(bucket);
    let count = 0;
    bucket.list = vi.fn(async (options: R2ListOptions = {}) => {
      const result = await original(options);
      if (options?.prefix === triggerPrefix && ++count === nth) {
        inject();
      }
      return result;
    });
  }

  it("SS-54: a file written into the anon namespace during the copy sweep is migrated, not deleted", async () => {
    seedAnonProject(bucket, "portfolio");

    // The first list of `projects/<anon>/portfolio/` is the first sweep's
    // copy loop enumerating the project's files. A write landing right after
    // it was, before this fix, invisible to the (single) copy pass yet still
    // caught by the delete pass — silently lost.
    injectAfterList(`projects/${ANON}/portfolio/`, 1, () => {
      bucket.store.set(`projects/${ANON}/portfolio/late-edit.html`, {
        data: "<h1>written mid-migration</h1>"
      });
    });

    const result = await run();
    expect(result.status).toBe("migrated");

    // The mid-run write survived into the subject namespace...
    expect(textOf(bucket.store.get(`projects/${SUBJECT}/portfolio/late-edit.html`))).toContain(
      "written mid-migration"
    );
    // ...and the anon original is gone.
    const anonKeys = [...bucket.store.keys()].filter((k) => k.startsWith(`projects/${ANON}/`));
    expect(anonKeys).toEqual([]);
  });

  it("SS-54: a brand-new anon project created during the copy sweep is migrated", async () => {
    seedAnonProject(bucket, "portfolio");

    // Lists of `projects/<anon>/` (exact prefix): #1 is the inventory, #2 is
    // the first sweep's plan listing. A project created right after #2 was,
    // before this fix, never planned or copied yet still deleted.
    injectAfterList(`projects/${ANON}/`, 2, () => {
      bucket.store.set(`projects/${ANON}/newproj/.metadata.json`, { data: metadataFor("newproj") });
      bucket.store.set(`projects/${ANON}/newproj/index.html`, { data: "<h1>newproj (anon)</h1>" });
    });

    const result = await run();
    expect(result.status).toBe("migrated");
    expect(result.projects).toEqual({ portfolio: "portfolio", newproj: "newproj" });

    // The mid-run project survived into the subject namespace...
    const meta = JSON.parse(bucket.store.get(`projects/${SUBJECT}/newproj/.metadata.json`)!.data);
    expect(meta.importedFrom).toBe(ANON);
    expect(textOf(bucket.store.get(`projects/${SUBJECT}/newproj/index.html`))).toContain("newproj (anon)");
    // ...and the anon originals are gone.
    const anonKeys = [...bucket.store.keys()].filter((k) => k.startsWith(`projects/${ANON}/`));
    expect(anonKeys).toEqual([]);
  });

  it("SS-54: the second sweep does not disturb what the first sweep copied", async () => {
    // Subject already owns "site", so the incoming project is suffixed; the
    // second sweep must resolve the SAME anon project to the SAME subject id
    // (via the importedFrom stamp) instead of re-suffixing, and must not
    // overwrite the metadata or files the first sweep wrote.
    bucket.store.set(`projects/${SUBJECT}/site/.metadata.json`, { data: metadataFor("site") });
    bucket.store.set(`projects/${SUBJECT}/site/index.html`, { data: "<h1>subject original</h1>" });
    seedAnonProject(bucket, "site");

    const result = await run();
    expect(result.status).toBe("migrated");
    expect(result.projects).toEqual({ site: "site-imported" });

    // Exactly one imported copy — no site-imported-2 from the second sweep.
    const importedIds = new Set(
      [...bucket.store.keys()]
        .filter((k) => k.startsWith(`projects/${SUBJECT}/`))
        .map((k) => k.slice(`projects/${SUBJECT}/`.length).split("/")[0])
    );
    expect([...importedIds].sort()).toEqual(["site", "site-imported"]);
    expect(bucket.store.get(`projects/${SUBJECT}/site/index.html`)!.data).toBe("<h1>subject original</h1>");
  });

  it("resumes after partial source deletion without duplicating imported projects", async () => {
    bucket.store.set(`projects/${SUBJECT}/site/.metadata.json`, {
      data: metadataFor("site", { published: true, slug: "site" })
    });
    bucket.store.set(`projects/${SUBJECT}/site/index.html`, {
      data: "<h1>subject site</h1>"
    });
    seedAnonProject(bucket, "site", { published: true, slug: "site" });
    seedAnonProject(bucket, "notes", { published: true, slug: "notes" });

    const originalDelete = bucket.delete.bind(bucket);
    let interrupted = false;
    // SAFETY: This replacement preserves the R2 delete signature while
    // injecting the deliberate interruption for retry coverage.
    bucket.delete = vi.fn(async (key: string) => {
      if (!interrupted && key === `projects/${ANON}/notes/.metadata.json`) {
        interrupted = true;
        throw new Error("injected delete interruption");
      }
      return originalDelete(key);
    });

    await expect(run()).rejects.toThrow("injected delete interruption");
    expect(bucket.store.has(`projects/${SUBJECT}/site-imported/.metadata.json`)).toBe(true);
    expect(bucket.store.has(`projects/${SUBJECT}/notes/.metadata.json`)).toBe(true);
    expect(bucket.store.has(`projects/${ANON}/site/.metadata.json`)).toBe(false);
    expect(bucket.store.has(`projects/${ANON}/notes/.metadata.json`)).toBe(true);

    await expect(run()).resolves.toMatchObject({ status: "migrated" });
    const subjectProjectIds = new Set(
      [...bucket.store.keys()]
        .filter((key) => key.startsWith(`projects/${SUBJECT}/`))
        .map((key) => key.slice(`projects/${SUBJECT}/`.length).split("/")[0])
    );
    expect([...subjectProjectIds].sort()).toEqual(["notes", "site", "site-imported"]);
    expect([...bucket.store.keys()].filter((key) => key.startsWith(`projects/${ANON}/`))).toEqual([]);
  });

  it("fails closed when chat history export is unavailable", async () => {
    seedAnonHandle(bucket);
    seedAnonProject(bucket, "portfolio", {
      published: true,
      slug: "portfolio",
    });
    kv.store.set("session:anon-session-id", JSON.stringify({ id: ANON }));
    const porter: ChatHistoryPorter = {
      port: async () => {
        throw new Error("anonymous chat export unavailable");
      }
    };

    await expect(run({ porter })).rejects.toThrow("Chat history migration failed");

    // File copies may precede the chat call, but the source remains available
    // because no completion claim was written.
    expect(bucket.store.get(`projects/${SUBJECT}/portfolio/index.html`)).toBeTruthy();
    expect(bucket.store.get(`projects/${ANON}/portfolio/index.html`)).toBeTruthy();
    expect(JSON.parse(kv.store.get(migrationClaimKey(ANON))!)).toMatchObject({
      subject: SUBJECT,
      status: "pending",
    });
    expect(kv.store.has("session:anon-session-id")).toBe(true);
    expect(kv.store.get(migrationPendingKey(SUBJECT))).toBe(ANON);
    // Handle ownership and the old published namespace remain authoritative
    // until chat history can be imported on a retry.
    expect(JSON.parse(bucket.store.get(`handles/jane-rivera.json`)!.data).ownerId).toBe(ANON);
    expect(bucket.store.has(`userhandles/${ANON}.json`)).toBe(true);
    expect(bucket.store.has(`userhandles/${SUBJECT}.json`)).toBe(false);
  });

  it("retains the anonymous source when snapshot metadata is invalid", async () => {
    seedAnonProject(bucket, "portfolio");
    bucket.store.set(`snapshots/${ANON}/portfolio/snap1.zip`, { data: "zipbytes" });
    bucket.store.set(`snapshots/${ANON}/portfolio/snap1.json`, {
      data: JSON.stringify({
        id: "snap1",
        createdAt: "2026-01-02T00:00:00.000Z",
        projectId: "portfolio",
        trigger: "manual",
        fileCount: "not-a-number",
      }),
    });

    await expect(run()).rejects.toThrow("snapshot metadata is invalid");

    // The strict snapshot schema must fail before migration reaches source
    // deletion. Both the archive and its invalid record remain recoverable.
    expect(bucket.store.has(`snapshots/${ANON}/portfolio/snap1.zip`)).toBe(true);
    expect(bucket.store.has(`snapshots/${ANON}/portfolio/snap1.json`)).toBe(true);
    expect(JSON.parse(kv.store.get(migrationClaimKey(ANON))!)).toMatchObject({
      subject: SUBJECT,
      status: "pending",
    });
  });

  it("fails closed on chat import failure and retries the pending claim", async () => {
    seedAnonHandle(bucket);
    seedAnonProject(bucket, "portfolio", {
      published: true,
      slug: "portfolio",
    });
    let attempts = 0;
    const porter: ChatHistoryPorter = {
      port: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("subject chat import unavailable");
        }
      }
    };

    await expect(run({ porter })).rejects.toThrow("Chat history migration failed");
    expect(bucket.store.get(`projects/${ANON}/portfolio/index.html`)).toBeTruthy();
    expect(JSON.parse(kv.store.get(migrationClaimKey(ANON))!)).toMatchObject({
      subject: SUBJECT,
      status: "pending",
    });
    expect(JSON.parse(bucket.store.get(`handles/jane-rivera.json`)!.data).ownerId).toBe(ANON);
    expect(bucket.store.has(`userhandles/${ANON}.json`)).toBe(true);
    expect(bucket.store.has(`userhandles/${SUBJECT}.json`)).toBe(false);

    const retry = await run({ porter });
    expect(retry.status).toBe("migrated");
    expect(attempts).toBe(2);
    expect(bucket.store.get(`projects/${SUBJECT}/portfolio/index.html`)).toBeTruthy();
    expect(bucket.store.get(`projects/${ANON}/portfolio/index.html`)).toBeUndefined();
    expect([...bucket.store.keys()].some((key) => key.startsWith(`projects/${ANON}/`))).toBe(false);
    expect(JSON.parse(kv.store.get(migrationClaimKey(ANON))!)).toMatchObject({
      subject: SUBJECT,
      status: "complete",
    });
    expect(JSON.parse(bucket.store.get(`handles/jane-rivera.json`)!.data).ownerId).toBe(SUBJECT);
    expect(bucket.store.has(`userhandles/${ANON}.json`)).toBe(true);
    expect(JSON.parse(bucket.store.get(`userhandles/${ANON}.json`)!.data)).toMatchObject({
      handle: "jane-rivera",
      claimedAt: "1970-01-01T00:00:00.000Z",
    });
    expect(JSON.parse(bucket.store.get(`userhandles/${SUBJECT}.json`)!.data).handle).toBe("jane-rivera");
  });

  it("retries after forward handle ownership commits before the subject reverse record", async () => {
    seedAnonHandle(bucket);
    seedAnonProject(bucket, "portfolio", {
      published: true,
      slug: "portfolio",
    });

    const originalPut = bucket.put;
    let failSubjectReverse = true;
    // SAFETY: This replacement preserves the R2 put signature while injecting
    // the first subject reverse-write failure.
    bucket.put = vi.fn(async (key: string, data: string, options?: R2PutOptions) => {
      if (key === `userhandles/${SUBJECT}.json` && failSubjectReverse) {
        failSubjectReverse = false;
        throw new Error("injected subject reverse failure");
      }
      return originalPut(key, data, options);
    });

    await expect(run()).rejects.toThrow("injected subject reverse failure");
    expect(JSON.parse(bucket.store.get(`handles/jane-rivera.json`)!.data).ownerId).toBe(SUBJECT);
    expect(bucket.store.has(`userhandles/${ANON}.json`)).toBe(true);
    expect(bucket.store.has(`userhandles/${SUBJECT}.json`)).toBe(false);

    await expect(run()).resolves.toMatchObject({ status: "migrated" });
    expect(bucket.store.has(`projects/${ANON}/portfolio/index.html`)).toBe(false);
    expect(JSON.parse(bucket.store.get(`userhandles/${SUBJECT}.json`)!.data).handle).toBe("jane-rivera");
  });

  it("retries after subject reverse commit before anonymous reverse cleanup", async () => {
    seedAnonHandle(bucket);
    seedAnonProject(bucket, "portfolio");

    const originalPut = bucket.put;
    let failAnonReverseRetirement = true;
    // SAFETY: This replacement preserves the R2 put signature while injecting
    // the anonymous reverse-retirement failure.
    bucket.put = vi.fn(async (key: string, data: string, options?: R2PutOptions) => {
      if (
        key === `userhandles/${ANON}.json`
        && testConditional(options)?.etagMatches
        && failAnonReverseRetirement
      ) {
        failAnonReverseRetirement = false;
        throw new Error("injected anonymous reverse cleanup failure");
      }
      return originalPut(key, data, options);
    });

    // Cleanup is part of the migration boundary. If retiring the anonymous
    // reverse record fails, the run must stay pending so the source remains
    // available for a complete retry.
    await expect(run()).rejects.toThrow("injected anonymous reverse cleanup failure");
    expect(JSON.parse(bucket.store.get(`handles/jane-rivera.json`)!.data).ownerId).toBe(SUBJECT);
    expect(JSON.parse(bucket.store.get(`userhandles/${SUBJECT}.json`)!.data).handle).toBe("jane-rivera");
    expect(bucket.store.has(`userhandles/${ANON}.json`)).toBe(true);

    await expect(run()).resolves.toMatchObject({ status: "migrated" });
    expect(bucket.store.has(`projects/${ANON}/portfolio/index.html`)).toBe(false);
    // The cleanup failure is intentionally best-effort; the stale reverse
    // record is not authoritative because its forward record points at the
    // subject, and normal handle repair can reap it later.
    expect(bucket.store.has(`userhandles/${ANON}.json`)).toBe(true);
    expect(await getUserHandle(bucket, ANON)).toBeNull();
  });
});

describe("handle re-homing through migration", () => {
  let bucket: ReturnType<typeof createMockBucket>;
  let kv: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    bucket = createMockBucket();
    kv = createMockKV();
  });

  function seedHandle(ownerId: string, handle: string) {
    const claimedAt = "2026-01-01T00:00:00.000Z";
    bucket.store.set(`handles/${handle}.json`, { data: JSON.stringify({ ownerId, claimedAt }) });
    bucket.store.set(`userhandles/${ownerId}.json`, { data: JSON.stringify({ handle, claimedAt }) });
  }

  it("moves the anon handle to a subject with none without storing a publication URL", async () => {
    seedHandle(ANON, "jane-rivera");
    seedAnonProject(
      bucket,
      "portfolio",
      {
        published: true,
        slug: "portfolio",
        publishedAt: "2026-01-02T00:00:00.000Z"
      },
      "<h1>site</h1>"
    );
    const legacyMetadataKey = `projects/${ANON}/portfolio/.metadata.json`;
    const legacyMetadata = z.object({
      id: z.string(),
      name: z.string(),
      createdAt: z.string(),
      updatedAt: z.string(),
      published: z.boolean(),
      publishedAt: z.string().optional(),
      slug: z.string().optional(),
      publishedUrl: z.string().optional(),
    }).parse(JSON.parse(bucket.store.get(legacyMetadataKey)!.data));
    legacyMetadata.publishedUrl = "https://old.example/u/jane-rivera/portfolio/";
    bucket.store.set(legacyMetadataKey, { data: JSON.stringify(legacyMetadata) });

    await migrateAnonymousData({
      bucket,
      kv,
      anonUserId: ANON,
      subject: SUBJECT,
    });

    // Handle re-homed: record points at subject, reverse record moved.
    expect(JSON.parse(bucket.store.get(`handles/jane-rivera.json`)!.data).ownerId).toBe(SUBJECT);
    expect(JSON.parse(bucket.store.get(`userhandles/${SUBJECT}.json`)!.data).handle).toBe("jane-rivera");
    expect(JSON.parse(bucket.store.get(`userhandles/${ANON}.json`)!.data)).toMatchObject({
      handle: "jane-rivera",
      claimedAt: "1970-01-01T00:00:00.000Z",
    });

    // Publication addresses are derived from the current base and are not
    // copied into project metadata during migration.
    const meta = JSON.parse(bucket.store.get(`projects/${SUBJECT}/portfolio/.metadata.json`)!.data);
    expect(meta.publishedUrl).toBeUndefined();
    expect(JSON.stringify(meta)).not.toContain("old.example");
  });

  it("keeps the subject's primary handle but re-points the anon handle as an alias", async () => {
    seedHandle(SUBJECT, "primary");
    seedHandle(ANON, "anon-alias");
    seedAnonProject(bucket, "portfolio", { published: true, slug: "portfolio" });

    await migrateAnonymousData({
      bucket,
      kv,
      anonUserId: ANON,
      subject: SUBJECT,
    });

    // Subject keeps its own primary.
    expect(JSON.parse(bucket.store.get(`userhandles/${SUBJECT}.json`)!.data).handle).toBe("primary");
    // Anon handle survives as an alias pointing at the subject.
    expect(JSON.parse(bucket.store.get(`handles/anon-alias.json`)!.data).ownerId).toBe(SUBJECT);
    expect(JSON.parse(bucket.store.get(`userhandles/${ANON}.json`)!.data)).toMatchObject({
      handle: "anon-alias",
      claimedAt: "1970-01-01T00:00:00.000Z",
    });
  });
});
