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
export async function readR2Json<T>(
  bucket: R2Bucket,
  key: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  const text = await object.text();
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
import { z } from "zod";
