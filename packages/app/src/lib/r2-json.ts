/**
 * Minimal JSON-over-R2 read/write helpers shared by the handle store
 * (lib/handles.ts) and the migration flow (lib/migration.ts), which each
 * carried a byte-identical private copy.
 *
 * `readR2Json` is deliberately lenient on PARSE (a corrupt/non-JSON object
 * reads as null, same as a missing one) — its callers layer their own shape
 * validation on top (e.g. resolveHandleOwner checks ownerId is a non-empty
 * string). It does NOT swallow the underlying `bucket.get` I/O error: a storage
 * outage propagates so callers on a security/identity path can fail loud
 * (mirrors the migration claim-read posture, rule 5).
 */
export async function readR2Json<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  try {
    return JSON.parse(await object.text()) as T;
  } catch {
    return null;
  }
}

/** Write `value` as pretty-free JSON with an application/json content type. */
export async function putR2Json(bucket: R2Bucket, key: string, value: unknown): Promise<void> {
  await bucket.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json" }
  });
}
