import { vi } from "vitest";
import { CSRF_HEADER_NAME, getOrMintCsrfToken } from "./csrf";
import { OwnerMutationService, type MutationJournalStore } from "./owner-mutations";

/**
 * Shared test helpers (vitest only picks up *.test.ts, so this file never runs
 * as a suite). Centralizes the KV mock and the CSRF session/token setup so
 * mutation-route tests stay readable.
 */

export type MockKV = KVNamespace & { store: Map<string, string> };

/** In-memory KV mock matching the house mock conventions. */
export function createMockKV(): MockKV {
  const store = new Map<string, string>();

  return {
    store,
    get: vi.fn(async (key: string, type?: string) => {
      const value = store.get(key);
      if (value === undefined) {
        return null;
      }
      return type === "json" ? JSON.parse(value) : value;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    })
  } as unknown as MockKV;
}

export type CsrfSession = {
  token: string;
  /** Headers a first-party browser mutation carries: token + same-origin posture. */
  headers: Record<string, string>;
};

/**
 * Mint (and persist in the mock R2 bucket) the CSRF token for a user, returning the
 * headers a compliant first-party request would send.
 */
export async function mintCsrfSession(bucket: R2Bucket, userId: string): Promise<CsrfSession> {
  const token = await getOrMintCsrfToken(bucket, userId);
  return {
    token,
    headers: {
      [CSRF_HEADER_NAME]: token,
      "Sec-Fetch-Site": "same-origin"
    }
  };
}

/** In-memory RPC-shaped coordinator used by route tests. */
export function createMockMutationCoordinator(bucket: R2Bucket): DurableObjectNamespace<any> {
  const journals = new Map<string, unknown>();
  const store: MutationJournalStore = {
    async get<T>(key: string) { return journals.get(key) as T | undefined; },
    async put<T>(key: string, value: T) { journals.set(key, value); },
    async delete(key: string) { return journals.delete(key); }
  };
  const service = new OwnerMutationService(bucket, store);
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: () => ({ execute: (ownerId: string, operation: any) => service.execute(ownerId, operation) })
  } as unknown as DurableObjectNamespace<any>;
}
