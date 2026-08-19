import { vi } from "vitest";
import { CSRF_HEADER_NAME, getOrMintCsrfToken } from "./csrf";
import { OwnerMutationService, type MutationJournalStore, type OwnerMutationResult } from "./owner-mutations";
import type { MigrationResult } from "./migration";
import type { OwnerMutation } from "./owner-mutations";

/**
 * Shared test helpers (vitest only picks up *.test.ts, so this file never runs
 * as a suite). Centralizes the KV mock and the CSRF session/token setup so
 * mutation-route tests stay readable.
 */

export type MockKV = KVNamespace & { store: Map<string, string> };

// SAFETY: The Workers type package exposes this nominal brand as a string
// literal; the test runtime does not provide the `Rpc` namespace value.
const durableObjectBrand = "__DURABLE_OBJECT_BRAND" as typeof Rpc.__DURABLE_OBJECT_BRAND;
export const DURABLE_OBJECT_BRAND = durableObjectBrand;

export function createTestR2Object(
  key: string,
  etag = `${key}:etag`,
  size = 0,
  options: { httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string>; uploaded?: Date } = {},
): R2Object {
  const object = {
    key,
    version: "test-version",
    size,
    etag,
    httpEtag: `"${etag}"`,
    checksums: {},
    uploaded: options.uploaded || new Date(0),
    httpMetadata: options.httpMetadata || {},
    customMetadata: options.customMetadata || {},
    storageClass: "Standard",
    writeHttpMetadata: (_headers: Headers) => undefined,
  };
  // SAFETY: Test boundaries inspect the stable key/etag fields; the remaining
  // metadata is inert and production R2 supplies the full object implementation.
  return object as R2Object;
}

/** In-memory KV mock matching the house mock conventions. */
export function createMockKV(): MockKV {
  const store = new Map<string, string>();
  // SAFETY: The fixture handles the single-key text/json overloads used by
  // these tests; unsupported KV overloads are outside this boundary.
  const get = (async (key: string, type?: string) => {
    const value = store.get(key);
    if (value === undefined) {
      return null;
    }
    return type === "json" ? JSON.parse(value) : value;
  }) as KVNamespace["get"];

  // SAFETY: KV put accepts strings in these fixtures; the binding accepts the
  // wider binary value union at runtime, which this test boundary does not use.
  const put = (async (key: string, value: string) => {
    store.set(key, value);
  }) as KVNamespace["put"];
  // SAFETY: KV delete is exercised with a single key by these route fixtures.
  const remove = (async (key: string) => {
    store.delete(key);
  }) as KVNamespace["delete"];
  // SAFETY: No test reads KV metadata; this deterministic empty result matches
  // the binding envelope for an absent key.
  const getWithMetadata = async <Metadata = never>(
    _key: string,
  ): Promise<KVNamespaceGetWithMetadataResult<string, Metadata>> => ({ value: null, metadata: null, cacheStatus: null });
  // SAFETY: No test lists KV keys; this deterministic empty page is sufficient.
  const list = (async () => ({ keys: [], list_complete: true, cacheStatus: null })) as KVNamespace["list"];
  // SAFETY: All binding methods are provided above with the real KV contract;
  // the extra map is test-only state used for assertions.
  const fixture = {
    store,
    get,
    put,
    delete: remove,
    getWithMetadata,
    list
  } as MockKV;
  vi.spyOn(fixture, "get");
  vi.spyOn(fixture, "put");
  return fixture;
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
export type TestMutationCoordinator = {
  newUniqueId: () => DurableObjectId;
  idFromName: (name: string) => DurableObjectId;
  idFromString: (name: string) => DurableObjectId;
  get: () => {
    execute: (ownerId: string, operation: OwnerMutation) => Promise<OwnerMutationResult>;
    migrateAnonymous: (anonUserId: string, subject: string, anonSessionId?: string) => Promise<MigrationResult>;
    fetch: (request: Request) => Promise<Response>;
    readonly id: DurableObjectId;
    [Rpc.__DURABLE_OBJECT_BRAND]: never;
  };
  getByName: (name: string) => {
    execute: (ownerId: string, operation: OwnerMutation) => Promise<OwnerMutationResult>;
    migrateAnonymous: (anonUserId: string, subject: string, anonSessionId?: string) => Promise<MigrationResult>;
    fetch: (request: Request) => Promise<Response>;
    readonly id: DurableObjectId;
    [Rpc.__DURABLE_OBJECT_BRAND]: never;
  };
  jurisdiction: () => TestMutationCoordinator;
};

export function createTestNamespace<T extends Rpc.DurableObjectBranded | undefined, M = {}>(methods: M): DurableObjectNamespace<T> {
  const namespace = Object.assign(Object.create(null), methods);
  // SAFETY: Cloudflare's namespace/stub types carry a nominal RPC brand that
  // has no runtime representation; this helper preserves the supplied methods
  // while adapting the in-memory binding to the platform boundary.
  return namespace as DurableObjectNamespace<T>;
}

export function createMockMutationCoordinator(bucket: R2Bucket): TestMutationCoordinator {
  const journals = new Map<string, unknown>();
  const store: MutationJournalStore = {
    async get<T>(key: string) {
      // SAFETY: OwnerMutationService writes and reads each journal key through
      // its generic store contract, so this fixture preserves that typed value.
      return journals.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T) { journals.set(key, value); },
    async delete(key: string) { return journals.delete(key); }
  };
  const service = new OwnerMutationService(bucket, store);
  const idFor = (name: string): DurableObjectId => {
    // SAFETY: The fixture's object id carries the name/equals behavior used by
    // the route RPC boundary; Cloudflare supplies the opaque implementation.
    return {
      name,
      toString: () => name,
      equals: (other: DurableObjectId) => other.toString() === name,
    } as DurableObjectId;
  };
  const rpc = {
    id: idFor("rpc"),
    execute: (ownerId: string, operation: any) => service.execute(ownerId, operation),
    // SAFETY: The fallback migration RPC returns the documented result shape.
    migrateAnonymous: async () => ({ status: "nothing-to-migrate", projects: {} }) as MigrationResult,
    fetch: async (_request: Request) => new Response(null, { status: 404 }),
    // SAFETY: Cloudflare's RPC brand is nominal type metadata; this in-memory
    // stub implements the corresponding RPC surface above.
    [DURABLE_OBJECT_BRAND]: undefined as never,
  };
  const namespace: TestMutationCoordinator = {
    newUniqueId: () => idFor("new"),
    idFromName: idFor,
    idFromString: idFor,
    get: () => rpc,
    getByName: () => rpc,
    jurisdiction: () => namespace,
  };
  return namespace;
}
