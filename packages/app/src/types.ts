import type { SiteBuilderAgent } from "./agents/site-builder";

export interface Env {
  APP_PUBLIC_DOMAIN?: string;
  LEGACY_PUBLIC_DOMAIN?: string;
  R2_PUBLIC_DOMAIN?: string;
  PUBLISHED_BASE_URL?: string;
  LOADER: WorkerLoader;
  // ---- CAIL backbone (docs/INTEGRATION.md) ----
  // Model calls + key management: the one public base URL of the CAIL model
  // proxy. Placeholder until launch (cail-gateway docs/LAUNCH_CHECKLIST.md).
  CAIL_API_BASE?: string;
  // Model id, expressed for AI Gateway's OpenAI-compatible path. See the
  // model-availability flag: confirm the gateway-supported id at launch.
  CAIL_MODEL?: string;
  // Shared HS256 secret used to verify X-CAIL-Identity-JWT. Wrangler secret;
  // ops-managed. Unset => identity disabled (every request anonymous).
  CAIL_IDENTITY_JWT_SECRET?: string;
  // "true" makes protected routes reject anonymous requests (401). Flip in
  // lockstep with the gateway's CAIL_SSO_MODE=enforce.
  CAIL_REQUIRE_IDENTITY?: string;
  SESSION_KV: KVNamespace;
  SITE_STUDIO_BUCKET: R2Bucket;
  SITE_BUILDER_AGENT: DurableObjectNamespace<SiteBuilderAgent>;
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
