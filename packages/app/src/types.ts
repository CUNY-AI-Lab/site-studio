import type { SiteBuilderAgent } from "./agents/site-builder";
import type { MigrationCoordinator } from "./agents/migration-coordinator";
import type { MutationCoordinator } from "./agents/mutation-coordinator";
import type {
  CailAnalyticsEngineDataset,
  CailLogEnvironment,
} from "@cuny-ai-lab/cail-log";

export interface Env {
  // Cloudflare Version Metadata binding. It is unavailable in local/test
  // runtimes, so the health response treats it as optional.
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  // Source-ready fleet projection. The live Analytics Engine dataset/binding
  // is provisioned separately; without it Workers structured logs continue.
  CAIL_FLEET_EVENTS?: CailAnalyticsEngineDataset;
  CAIL_LOG_ENV?: CailLogEnvironment;
  APP_PUBLIC_DOMAIN?: string;
  PUBLISHED_BASE_URL?: string;
  LOADER: WorkerLoader;
  // ---- CAIL model gateway (cail-gateway docs/gateway-contract.md) ----
  // The public base URL of the CAIL model proxy. The checked-in value is source
  // configuration, not proof of the live deployment; verify operations state
  // against the Gateway runtime contract.
  CAIL_API_BASE?: string;
  // Workers AI model id for the gateway's OpenAI-compatible path (`@cf/...`
  // only under current CAIL policy).
  CAIL_MODEL?: string;
  // Text-to-image model id (Workers AI native path). CAIL policy: `@cf/...`
  // only. Default @cf/black-forest-labs/flux-2-klein-4b; budget alternative
  // @cf/black-forest-labs/flux-1-schnell.
  CAIL_IMAGE_MODEL?: string;
  // Vision model used as the REQUIRED image moderation gate (no dedicated NSFW
  // classifier exists in Workers AI). Must be a vision-capable curated-catalog
  // id. Default @cf/moonshotai/kimi-k2.6; the catalog's other vision model is
  // @cf/meta/llama-4-scout-17b-16e-instruct.
  CAIL_IMAGE_CLASSIFIER?: string;
  // Static public JWKS used to verify RS256 X-CAIL-Identity-JWT tokens for the
  // cail:site-studio audience. Stored as a JSON Wrangler secret.
  CAIL_IDENTITY_JWKS?: string;
  // Exact CAIL issuer assigned to this deployment. It cannot define a new
  // trust root; runtime verification accepts CAIL's canonical issuer only.
  CAIL_IDENTITY_ISSUER?: string;
  SITE_STUDIO_MAX_PROJECT_BYTES?: string;
  SITE_STUDIO_MAX_OWNER_BYTES?: string;
  SITE_STUDIO_UPLOADS_PER_MINUTE?: string;
  // Path scope for the anti-CSRF delivery cookie (cail_csrf_sitestudio).
  // Production is mounted at /site-studio on a shared origin alongside
  // sibling tools and untrusted published content. Runtime validation rejects a
  // missing value or any value other than "/site-studio".
  CSRF_COOKIE_PATH?: string;
  SESSION_KV: KVNamespace;
  SITE_STUDIO_BUCKET: R2Bucket;
  SITE_BUILDER_AGENT: DurableObjectNamespace<SiteBuilderAgent>;
  // SS-3: atomic first-gate for anonymous→subject migration claims, keyed by
  // idFromName(anonId). See agents/migration-coordinator.ts and lib/session.ts.
  MIGRATION_COORDINATOR: DurableObjectNamespace<MigrationCoordinator>;
  // Optional in the type so isolated tests can construct partial bindings;
  // every runtime mutation path checks it and fails closed when absent.
  MUTATION_COORDINATOR?: DurableObjectNamespace<MutationCoordinator>;
  ASSETS?: Fetcher;
}

export interface User {
  /**
   * Durable owner key. When the request carried a verified CAIL identity this
   * is the CAIL subject ("cail-<hex>"); otherwise it is an anonymous
   * "user_<hex>" id (pre-SSO-rollout behavior). Everything the tool owns —
   * projects, snapshots, workspaces, agent instances — is keyed by this value,
   * never by email.
   */
  id: string;
  createdAt: string;
  /** True when `id` is a verified CAIL subject rather than an anonymous id. */
  cail?: boolean;
  /** Non-durable profile attributes from the identity JWT (display only). */
  email?: string;
  name?: string;
  /** Verified `log_sub` from the identity boundary; separate salt, never derived from `id`. Logging only. */
  operationalSubject?: string;
}

/**
 * Props passed to the SiteBuilderAgent Durable Object at connection time
 * (see routes/agents.ts). `identityJwt` is the verified caller JWT captured on
 * the request that established the connection; the agent forwards it to the CAIL
 * model proxy. Before each user-driven model frame, the authenticated HTTP
 * refresh route replaces this connection-local value without exposing it to
 * the browser. The model adapter still checks token expiry before each
 * gateway POST.
 */
export interface SiteBuilderAgentProps {
  userId: string;
  projectId: string;
  identityJwt?: string;
  /** Verified CAIL `log_sub`; logging only, never derived from `userId`. */
  operationalSubject?: string;
  // Props are serialized to the `x-partykit-props` header by the agents SDK.
  // All values in this channel are scalar strings, so the index signature is
  // concrete while remaining assignable to the SDK's Record<string, unknown>.
  [key: string]: string | undefined;
}

export interface LegacySessionRecord {
  user: User;
  expiresAt: string;
}

export interface ProjectMetadata {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  published: boolean;
  publishedAt?: string;
  unpublishedAt?: string;
  thumbnailUrl?: string;
  slug?: string;
  /**
   * Set on projects copied in by the anonymous-data migration
   * (lib/migration.ts): the anonymous user id the project came from and its
   * id in that namespace. Lets retried/concurrent migration runs recognize
   * their own copies instead of treating them as collisions.
   */
  importedFrom?: string;
  importedOriginalId?: string;
  /**
   * Internal owner-mutation claim. While present, the project is reserved but
   * not visible to normal reads; recovery deletes it only when the journal
   * carries the same operation id.
   */
  creatingOperationId?: string;
}

export type ProjectSnapshotTrigger = "agent" | "manual" | "restore";

export interface ProjectSnapshot {
  id: string;
  createdAt: string;
  projectId: string;
  trigger: ProjectSnapshotTrigger;
  label?: string;
  fileCount: number;
  restoredFromSnapshotId?: string;
}

/**
 * SS-28: `createSnapshot` returns a skip signal instead of a `ProjectSnapshot`
 * when the project's total uncompressed size exceeds MAX_SNAPSHOT_BYTES. The
 * skip is non-fatal — the caller proceeds with its mutation — but must be made
 * visible (never silent). `skipped` is the discriminant so callers can branch.
 */
export interface SnapshotSkipped {
  skipped: true;
  reason: "too-large";
  totalBytes: number;
  limitBytes: number;
}

export type SnapshotResult = ProjectSnapshot | SnapshotSkipped;

export function isSnapshotSkipped(result: SnapshotResult): result is SnapshotSkipped {
  return "skipped" in result && result.skipped === true;
}

export interface StorageFile {
  path: string;
  name: string;
  size: number;
  lastModified: string;
  isDirectory: boolean;
  contentType?: string;
  isText?: boolean;
}

export interface ProjectTreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  contentType?: string;
  isText?: boolean;
  children?: ProjectTreeNode[];
}
