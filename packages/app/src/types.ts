import type { SiteBuilderAgent } from "./agents/site-builder";
import type { MigrationCoordinator } from "./agents/migration-coordinator";

export interface Env {
  APP_PUBLIC_DOMAIN?: string;
  PUBLISHED_BASE_URL?: string;
  LOADER: WorkerLoader;
  // ---- CAIL backbone (docs/INTEGRATION.md) ----
  // Model calls + key management: the one public base URL of the CAIL model
  // proxy. Placeholder until launch (cail-gateway docs/LAUNCH_CHECKLIST.md).
  CAIL_API_BASE?: string;
  // Model id, expressed for AI Gateway's OpenAI-compatible path. See the
  // model-availability flag: confirm the gateway-supported id at launch.
  CAIL_MODEL?: string;
  // Text-to-image model id (Workers AI native path). CAIL policy: `@cf/...`
  // only. Default @cf/black-forest-labs/flux-2-klein-4b; budget alternative
  // @cf/black-forest-labs/flux-1-schnell.
  CAIL_IMAGE_MODEL?: string;
  // Vision model used as the REQUIRED image moderation gate (no dedicated NSFW
  // classifier exists in Workers AI). `@cf/...` only. Default
  // @cf/google/gemma-4-26b-a4b-it; fallback @cf/meta/llama-3.2-11b-vision-instruct.
  CAIL_IMAGE_CLASSIFIER?: string;
  // Shared HS256 secret used to verify X-CAIL-Identity-JWT. Wrangler secret;
  // ops-managed. Unset => identity disabled (every request anonymous).
  CAIL_IDENTITY_JWT_SECRET?: string;
  // "true" makes protected routes reject anonymous requests (401). Flip in
  // lockstep with the gateway's CAIL_SSO_MODE=enforce.
  CAIL_REQUIRE_IDENTITY?: string;
  // Path scope for the anti-CSRF delivery cookie (cail_csrf_sitestudio).
  // Default "/". At a shared-host launch — this tool mounted under a path
  // prefix like /site-studio alongside sibling tools and /sites/ user content —
  // this MUST be set to the tool's own path prefix so sibling tools and
  // published-site JS cannot read the cookie (browsers only expose a cookie to
  // pages under its Path). On a dedicated hostname the tool owns the whole
  // origin, so "/" is safe. See lib/csrf.ts setCsrfCookie().
  CSRF_COOKIE_PATH?: string;
  SESSION_KV: KVNamespace;
  SITE_STUDIO_BUCKET: R2Bucket;
  SITE_BUILDER_AGENT: DurableObjectNamespace<SiteBuilderAgent>;
  // SS-3: atomic first-gate for anonymous→subject migration claims, keyed by
  // idFromName(anonId). See agents/migration-coordinator.ts and lib/session.ts.
  MIGRATION_COORDINATOR: DurableObjectNamespace<MigrationCoordinator>;
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
 * model proxy. Note: the browser opens the agent over a long-lived WebSocket, so
 * this JWT is captured once at upgrade and can go stale — see the
 * websocket/JWT-TTL flag in the PR.
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
