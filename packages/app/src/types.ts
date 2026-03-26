import type { SiteBuilderAgent } from "./agents/site-builder";

export interface Env {
  APP_PUBLIC_DOMAIN?: string;
  LEGACY_PUBLIC_DOMAIN?: string;
  LOADER: WorkerLoader;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  SESSION_KV: KVNamespace;
  SITE_STUDIO_BUCKET: R2Bucket;
  SITE_BUILDER_AGENT: DurableObjectNamespace<SiteBuilderAgent>;
  ASSETS?: Fetcher;
}

export interface User {
  id: string;
  createdAt: string;
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
