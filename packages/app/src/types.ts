import type { SiteBuilderAgent } from "./agents/site-builder";
import type { MigrationCoordinator } from "./agents/migration-coordinator";
import type { MutationCoordinator } from "./agents/mutation-coordinator";
import type {
  CailAnalyticsEngineDataset,
  CailLogEnvironment,
} from "@cuny-ai-lab/cail-log";

export interface Env {
  // Source-ready fleet projection. The live Analytics Engine dataset/binding
  // is provisioned separately; without it Workers structured logs continue.
  CAIL_FLEET_EVENTS?: CailAnalyticsEngineDataset;
  CAIL_LOG_ENV?: CailLogEnvironment;
  APP_PUBLIC_DOMAIN?: string;
  PUBLISHED_BASE_URL?: string;
  LOADER: WorkerLoader;
  // ---- CAIL backbone (docs/INTEGRATION.md) ----
  // The public base URL of the CAIL model proxy. The checked-in value is source
  // configuration, not proof of the live deployment; verify operations state
  // against the gateway integration contract.
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
  // Exactly one case-sensitive CAIL issuer for this deployment. Production
  // and staging must never be combined into one trust namespace.
  CAIL_IDENTITY_ISSUER?: string;
  // "true" makes protected routes reject anonymous requests (401). Flip in
  // lockstep with the gateway's CAIL_SSO_MODE=enforce.
  CAIL_REQUIRE_IDENTITY?: string;
  // Required when identity enforcement is enabled. These ISO instants bound
  // the temporary legacy-account import window; runtime validation also
  // requires end >= start and a duration no longer than 30 days.
  CAIL_SSO_SWITCHED_AT?: string;
  CAIL_ACCOUNT_IMPORT_UNTIL?: string;
  SITE_STUDIO_MAX_PROJECT_BYTES?: string;
  SITE_STUDIO_MAX_OWNER_BYTES?: string;
  SITE_STUDIO_UPLOADS_PER_MINUTE?: string;
  // Path scope for the anti-CSRF delivery cookie (cail_csrf_sitestudio).
  // Production is mounted at /site-studio on a shared origin alongside
  // sibling tools and untrusted /sites/ content. Runtime validation rejects a
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
}

/**
 * Props passed to the SiteBuilderAgent Durable Object at connection time
 * (see routes/agents.ts). `identityJwt` is the verified caller JWT captured on
 * the request that established the connection; the agent forwards it to the CAIL
 * model proxy. The browser refreshes old sockets and the model adapter checks
 * token expiry before every gateway POST.
 */
export interface SiteBuilderAgentProps {
  userId: string;
  projectId: string;
  identityJwt?: string;
  // Props are serialized to the `x-partykit-props` header by the agents SDK,
  // whose type requires an index signature (Props extends Record<string, unknown>).
  [key: string]: unknown;
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
  publishedUrl?: string;
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
  return (result as SnapshotSkipped).skipped === true;
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
