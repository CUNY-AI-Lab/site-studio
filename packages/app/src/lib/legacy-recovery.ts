import { z } from "zod";
import {
  handleRecordKey,
  resolveHandleOwner,
  validateHandle,
} from "./handles";
import { legacyRecoveryManifestSchema, type LegacyRecoveryManifest } from "./recovery-contract";

const canonicalSubject = /^cail-[a-f0-9]{32}$/;
const recoveryMetadataSchema = z.object({
  id: z.string(),
  published: z.boolean(),
  slug: z.string().optional(),
  importedFrom: z.string().optional(),
  importedOriginalId: z.string().optional(),
  creatingOperationId: z.string().optional(),
}).passthrough();
const handleOwnerSchema = z.object({ ownerId: z.string() }).passthrough();
const authorizationSchema = z.object({
  version: z.literal(1),
  recoveryId: z.string().uuid(),
  sourceOwner: z.string(),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  targetSubject: z.string().regex(canonicalSubject),
  idempotencyKey: z.string().uuid(),
  status: z.enum(["pending", "complete"]),
  projectCount: z.number().int().positive(),
  fileCount: z.number().int().positive(),
  byteCount: z.number().int().nonnegative(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  projectMap: z.record(z.string(), z.string()).optional(),
  recoveryHandle: z.string().optional(),
}).strict();

export type LegacyRecoveryAuthorization = z.infer<typeof authorizationSchema>;

const aliasSchema = z.object({
  version: z.literal(1),
  recoveryId: z.string().uuid(),
  sourceOwner: z.string(),
  sourceSlug: z.string(),
  sourceProjectId: z.string(),
  targetSubject: z.string().regex(canonicalSubject),
  targetProjectId: z.string(),
  recoveryHandle: z.string().optional(),
}).strict();

export type LegacyRecoveryAlias = z.infer<typeof aliasSchema>;

export class LegacyRecoveryError extends Error {
  constructor(readonly code: "invalid" | "conflict" | "unavailable") {
    super(code);
    this.name = "LegacyRecoveryError";
  }
}

export function recoveryManifestKey(recoveryId: string): string {
  return `recoveries/${recoveryId}/manifest.json`;
}

export function recoveryAuthorizationKey(recoveryId: string): string {
  return `recoveries/${recoveryId}/authorization.json`;
}

function aliasKey(sourceOwner: string, sourceSlug: string): string {
  return `recovery-aliases/${sourceOwner}/${sourceSlug}.json`;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function listKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

export async function loadRecoveryManifest(
  bucket: R2Bucket,
  recoveryId: string,
): Promise<{ manifest: LegacyRecoveryManifest; sha256: string }> {
  const object = await bucket.get(recoveryManifestKey(recoveryId));
  if (!object) throw new LegacyRecoveryError("invalid");
  const bytes = await object.arrayBuffer();
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new LegacyRecoveryError("invalid");
  }
  const parsed = legacyRecoveryManifestSchema.safeParse(payload);
  if (!parsed.success || parsed.data.recoveryId !== recoveryId) {
    throw new LegacyRecoveryError("invalid");
  }
  return { manifest: parsed.data, sha256: await sha256Hex(bytes) };
}

/** Validate the entire disposable source before any destination copy starts. */
export async function validateStagedRecovery(
  bucket: R2Bucket,
  manifest: LegacyRecoveryManifest,
  options: { allowMissing?: boolean } = {},
): Promise<void> {
  const expected = new Map(
    manifest.objects.map((object) => [
      `${manifest.source.prefix}${object.projectId}/${object.path}`,
      object,
    ]),
  );
  const actual = await listKeys(bucket, manifest.source.prefix);
  if (
    actual.some((key) => !expected.has(key)) ||
    (!options.allowMissing && actual.length !== expected.size)
  ) {
    throw new LegacyRecoveryError("invalid");
  }
  for (const [key, declaration] of expected) {
    const object = await bucket.get(key);
    if (!object) {
      if (options.allowMissing) continue;
      throw new LegacyRecoveryError("invalid");
    }
    if (object.size !== declaration.size) throw new LegacyRecoveryError("invalid");
    const bytes = await object.arrayBuffer();
    if (await sha256Hex(bytes) !== declaration.sha256) {
      throw new LegacyRecoveryError("invalid");
    }
    if (declaration.path === ".metadata.json") {
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new LegacyRecoveryError("invalid");
      }
      const metadata = recoveryMetadataSchema.safeParse(payload);
      const project = manifest.projects.find((candidate) => candidate.id === declaration.projectId);
      if (
        !project || !metadata.success || metadata.data.id !== project.id ||
        metadata.data.published !== project.published ||
        metadata.data.slug !== project.slug
      ) {
        throw new LegacyRecoveryError("invalid");
      }
    }
  }
  for (const prefix of [`snapshots/${manifest.source.owner}/`, `uploads/${manifest.source.owner}/`]) {
    if ((await listKeys(bucket, prefix)).length > 0) throw new LegacyRecoveryError("invalid");
  }
}

/** The staged source must never have participated in the public handle map. */
export async function assertNoSourceHandleExposure(
  bucket: R2Bucket,
  sourceOwner: string,
): Promise<void> {
  if (await bucket.get(`userhandles/${sourceOwner}.json`)) {
    throw new LegacyRecoveryError("conflict");
  }
  for (const key of await listKeys(bucket, "handles/")) {
    const object = await bucket.get(key);
    if (!object) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(await object.text());
    } catch {
      throw new LegacyRecoveryError("unavailable");
    }
    const record = handleOwnerSchema.safeParse(payload);
    if (!record.success) throw new LegacyRecoveryError("unavailable");
    if (record.data.ownerId === sourceOwner) throw new LegacyRecoveryError("conflict");
  }
}

export async function readRecoveryAuthorization(
  bucket: R2Bucket,
  recoveryId: string,
): Promise<{ value: LegacyRecoveryAuthorization; etag: string } | null> {
  const object = await bucket.get(recoveryAuthorizationKey(recoveryId));
  if (!object) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(await object.text());
  } catch {
    throw new LegacyRecoveryError("unavailable");
  }
  const parsed = authorizationSchema.safeParse(payload);
  if (!parsed.success) throw new LegacyRecoveryError("unavailable");
  return { value: parsed.data, etag: object.etag };
}

export async function createPendingRecovery(
  bucket: R2Bucket,
  value: LegacyRecoveryAuthorization,
): Promise<LegacyRecoveryAuthorization> {
  const wrote = await bucket.put(recoveryAuthorizationKey(value.recoveryId), JSON.stringify(value), {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (wrote) return value;
  const existing = await readRecoveryAuthorization(bucket, value.recoveryId);
  if (!existing) throw new LegacyRecoveryError("unavailable");
  return existing.value;
}

export function assertSameRecovery(
  state: LegacyRecoveryAuthorization,
  input: { targetSubject: string; idempotencyKey: string },
  manifestSha256: string,
  sourceOwner: string,
): void {
  if (
    state.targetSubject !== input.targetSubject ||
    state.idempotencyKey !== input.idempotencyKey ||
    state.manifestSha256 !== manifestSha256 ||
    state.sourceOwner !== sourceOwner
  ) {
    throw new LegacyRecoveryError("conflict");
  }
}

export async function verifyRecoveredDestination(options: {
  bucket: R2Bucket;
  manifest: LegacyRecoveryManifest;
  targetSubject: string;
  projectMap: Record<string, string>;
}): Promise<void> {
  const { bucket, manifest, targetSubject, projectMap } = options;
  for (const project of manifest.projects) {
    if (!projectMap[project.id]) throw new LegacyRecoveryError("unavailable");
  }
  for (const declaration of manifest.objects) {
    const targetProjectId = projectMap[declaration.projectId];
    const key = `projects/${targetSubject}/${targetProjectId}/${declaration.path}`;
    const object = await bucket.get(key);
    if (!object) throw new LegacyRecoveryError("unavailable");
    if (declaration.path === ".metadata.json") {
      let payload: unknown;
      try {
        payload = JSON.parse(await object.text());
      } catch {
        throw new LegacyRecoveryError("unavailable");
      }
      const metadata = recoveryMetadataSchema.safeParse(payload);
      const project = manifest.projects.find((candidate) => candidate.id === declaration.projectId);
      if (
        !project || !metadata.success || metadata.data.id !== targetProjectId ||
        metadata.data.importedFrom !== manifest.source.owner ||
        metadata.data.importedOriginalId !== declaration.projectId ||
        metadata.data.published !== project.published
      ) {
        throw new LegacyRecoveryError("unavailable");
      }
      continue;
    }
    if (object.size !== declaration.size || await sha256Hex(await object.arrayBuffer()) !== declaration.sha256) {
      throw new LegacyRecoveryError("unavailable");
    }
  }
}

export async function writeRecoveryAliases(options: {
  bucket: R2Bucket;
  manifest: LegacyRecoveryManifest;
  targetSubject: string;
  projectMap: Record<string, string>;
  recoveryHandle?: string;
}): Promise<void> {
  const { bucket, manifest, targetSubject, projectMap } = options;
  for (const project of manifest.projects) {
    if (!project.published || !project.slug) continue;
    const alias: LegacyRecoveryAlias = {
      version: 1,
      recoveryId: manifest.recoveryId,
      sourceOwner: manifest.source.owner,
      sourceSlug: project.slug,
      sourceProjectId: project.id,
      targetSubject,
      targetProjectId: projectMap[project.id],
      recoveryHandle: options.recoveryHandle,
    };
    const key = aliasKey(manifest.source.owner, project.slug);
    const serialized = JSON.stringify(alias);
    const wrote = await bucket.put(key, serialized, {
      httpMetadata: { contentType: "application/json" },
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (wrote) continue;
    const existing = await bucket.get(key);
    if (!existing || await existing.text() !== serialized) throw new LegacyRecoveryError("conflict");
  }
}

export async function markRecoveryComplete(
  bucket: R2Bucket,
  current: { value: LegacyRecoveryAuthorization; etag: string },
  projectMap: Record<string, string>,
  recoveryHandle?: string,
  now = () => new Date().toISOString(),
): Promise<LegacyRecoveryAuthorization> {
  const complete: LegacyRecoveryAuthorization = {
    ...current.value,
    status: "complete",
    completedAt: current.value.completedAt ?? now(),
    projectMap,
    recoveryHandle,
  };
  const wrote = await bucket.put(recoveryAuthorizationKey(current.value.recoveryId), JSON.stringify(complete), {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagMatches: current.etag },
  });
  if (wrote) return complete;
  const existing = await readRecoveryAuthorization(bucket, current.value.recoveryId);
  if (!existing || existing.value.status !== "complete") throw new LegacyRecoveryError("unavailable");
  return existing.value;
}

export function recoveryHandleForSource(sourceOwner: string): string {
  const suffix = sourceOwner.match(/^user_([a-f0-9]{32})$/)?.[1];
  if (!suffix) throw new LegacyRecoveryError("invalid");
  const candidate = `legacy-${suffix.slice(0, 25)}`;
  const validation = validateHandle(candidate);
  if (!validation.valid) throw new LegacyRecoveryError("invalid");
  return validation.handle;
}

/**
 * Reserve a forward-only public recovery handle. It intentionally leaves the
 * subject's primary `userhandles/` slot free for a later user choice.
 */
export async function claimRecoveryHandle(
  bucket: R2Bucket,
  sourceOwner: string,
  targetSubject: string,
  claimedAt: string,
): Promise<string> {
  const handle = recoveryHandleForSource(sourceOwner);
  const wrote = await bucket.put(
    handleRecordKey(handle),
    JSON.stringify({ ownerId: targetSubject, claimedAt }),
    {
      httpMetadata: { contentType: "application/json" },
      onlyIf: { etagDoesNotMatch: "*" },
    },
  );
  if (!wrote && await resolveHandleOwner(bucket, handle) !== targetSubject) {
    throw new LegacyRecoveryError("conflict");
  }
  return handle;
}

/** Read an alias only after its exact recovery receipt is complete. */
export async function resolveCompletedRecoveryAlias(
  bucket: R2Bucket,
  sourceOwner: string,
  sourceSlug: string,
): Promise<LegacyRecoveryAlias | null> {
  const object = await bucket.get(aliasKey(sourceOwner, sourceSlug));
  if (!object) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(await object.text());
  } catch {
    return null;
  }
  const parsed = aliasSchema.safeParse(payload);
  if (!parsed.success || parsed.data.sourceOwner !== sourceOwner || parsed.data.sourceSlug !== sourceSlug) return null;
  const recovery = await readRecoveryAuthorization(bucket, parsed.data.recoveryId).catch(() => null);
  if (!recovery || recovery.value.status !== "complete") return null;
  if (recovery.value.targetSubject !== parsed.data.targetSubject) return null;
  if (recovery.value.projectMap?.[parsed.data.sourceProjectId] !== parsed.data.targetProjectId) return null;
  return parsed.data;
}

export async function findCompletedRecoveryAliasForTarget(
  bucket: R2Bucket,
  sourceOwner: string,
  targetSubject: string,
  targetProjectId: string,
): Promise<LegacyRecoveryAlias | null> {
  for (const key of await listKeys(bucket, `recovery-aliases/${sourceOwner}/`)) {
    const object = await bucket.get(key);
    if (!object) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(await object.text());
    } catch {
      continue;
    }
    const parsed = aliasSchema.safeParse(payload);
    if (parsed.success && parsed.data.targetSubject === targetSubject) {
      const completed = await resolveCompletedRecoveryAlias(
        bucket,
        parsed.data.sourceOwner,
        parsed.data.sourceSlug,
      );
      if (
        completed &&
        await findCurrentImportedProjectId(bucket, completed) === targetProjectId
      ) {
        return completed;
      }
    }
  }
  return null;
}

export async function findCurrentImportedProjectId(
  bucket: R2Bucket,
  alias: LegacyRecoveryAlias,
): Promise<string | null> {
  let matched: string | null = null;
  for (const key of await listKeys(bucket, `projects/${alias.targetSubject}/`)) {
    if (!key.endsWith("/.metadata.json")) continue;
    const object = await bucket.get(key);
    if (!object) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(await object.text());
    } catch {
      continue;
    }
    const metadata = recoveryMetadataSchema.safeParse(payload);
    if (
      !metadata.success || metadata.data.importedFrom !== alias.sourceOwner ||
      metadata.data.importedOriginalId !== alias.sourceProjectId ||
      metadata.data.creatingOperationId
    ) {
      continue;
    }
    if (matched !== null) return null;
    matched = metadata.data.id;
  }
  return matched;
}
