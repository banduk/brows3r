/**
 * API module for bucket inspection and capability cache commands.
 *
 * Types mirror `src-tauri/src/s3/inspector.rs` and
 * `src-tauri/src/commands/inspector_cmd.rs` (camelCase via serde).
 */

import { invoke } from "@/lib/tauri";

// ---------------------------------------------------------------------------
// SectionResult — discriminated outcome for each inspector section
// ---------------------------------------------------------------------------

/** The API succeeded and returned a value. */
export interface SectionResultValue<T> {
  kind: "value";
  value: T;
}

/** IAM policy denied this section. */
export interface SectionResultDenied {
  kind: "denied";
  iamAction: string;
}

/** The provider does not implement this API. */
export interface SectionResultUnsupported {
  kind: "unsupported";
  reason: string;
}

/** Intentionally absent in v1 (design non-goal). */
export interface SectionResultDeferred {
  kind: "deferred";
  reason: string;
}

/**
 * Discriminated union representing one bucket property section outcome.
 *
 * Use `section.kind` to narrow the type:
 *   - `"value"` → `section.value`
 *   - `"denied"` → `section.iamAction`
 *   - `"unsupported"` → `section.reason`
 *   - `"deferred"` → `section.reason`
 */
export type SectionResult<T> =
  | SectionResultValue<T>
  | SectionResultDenied
  | SectionResultUnsupported
  | SectionResultDeferred;

// ---------------------------------------------------------------------------
// Section value types
// ---------------------------------------------------------------------------

/** Bucket versioning state. */
export type VersioningStatus = "enabled" | "suspended" | "disabled";

/** Server-side encryption configuration summary (read-only in v1). */
export interface EncryptionConfig {
  sseAlgorithm: string | null;
  kmsMasterKeyId: string | null;
}

/** A single lifecycle rule summary. */
export interface LifecycleRule {
  id: string | null;
  status: string;
  prefix: string | null;
}

/** Object-lock configuration summary. */
export interface ObjectLockConfig {
  objectLockEnabled: boolean;
  defaultRetentionMode: string | null;
  defaultRetentionDays: number | null;
  defaultRetentionYears: number | null;
}

/** Public access block configuration. */
export interface PublicAccessBlockConfig {
  blockPublicAcls: boolean;
  ignorePublicAcls: boolean;
  blockPublicPolicy: boolean;
  restrictPublicBuckets: boolean;
}

/** A single CORS rule summary. */
export interface CorsRule {
  allowedOrigins: string[];
  allowedMethods: string[];
  allowedHeaders: string[];
  exposeHeaders: string[];
  maxAgeSeconds: number | null;
}

/** Replication configuration summary. */
export interface ReplicationConfig {
  role: string;
  destinationBuckets: string[];
}

/** Bucket access logging configuration. */
export interface LoggingConfig {
  targetBucket: string | null;
  targetPrefix: string | null;
}

/** Static website hosting configuration. */
export interface WebsiteConfig {
  indexDocument: string | null;
  errorDocument: string | null;
  redirectAllRequestsTo: string | null;
}

/**
 * S3 event notification configuration summary.
 *
 * These are S3-side event notifications (Lambda, SQS, SNS), not the
 * application's own notification system.
 */
export interface NotificationConfig {
  lambdaCount: number;
  queueCount: number;
  topicCount: number;
}

/** Bucket ownership controls. */
export interface OwnershipControls {
  rule: string;
}

// ---------------------------------------------------------------------------
// BucketInspectorReport — the aggregated report
// ---------------------------------------------------------------------------

/**
 * Aggregated read-only bucket properties returned by `bucketInspect`.
 *
 * Each section uses `SectionResult<T>`. `bucketPolicy` is always `deferred`
 * in v1 (design non-goal — no viewer or editor).
 */
export interface BucketInspectorReport {
  region: SectionResult<string>;
  versioning: SectionResult<VersioningStatus>;
  encryption: SectionResult<EncryptionConfig>;
  lifecycle: SectionResult<LifecycleRule[]>;
  objectLock: SectionResult<ObjectLockConfig>;
  publicAccessBlock: SectionResult<PublicAccessBlockConfig>;
  cors: SectionResult<CorsRule[]>;
  tags: SectionResult<Record<string, string>>;
  replication: SectionResult<ReplicationConfig>;
  logging: SectionResult<LoggingConfig>;
  website: SectionResult<WebsiteConfig>;
  notifications: SectionResult<NotificationConfig>;
  ownershipControls: SectionResult<OwnershipControls>;
  requesterPays: SectionResult<boolean>;
  /** Always `{ kind: "deferred", reason: "Deferred from v1" }`. */
  bucketPolicy: SectionResultDeferred;
}

// ---------------------------------------------------------------------------
// Types (capability cache — pre-existing)
// ---------------------------------------------------------------------------

/** IAM-denied capability. */
export interface CapabilityClassDenied {
  class: "denied";
  iamAction: string | null;
}

/** Provider does not implement the operation. */
export interface CapabilityClassUnsupported {
  class: "unsupported";
  provider: string | null;
}

/** Object storage class blocks the operation. */
export interface CapabilityClassStorageClassBlocked {
  class: "storageClassBlocked";
  storageClass: string;
}

/** Operation is permitted. */
export interface CapabilityClassAllowed {
  class: "allowed";
}

/** Discriminated union of all capability classifications. */
export type CapabilityClass =
  | CapabilityClassAllowed
  | CapabilityClassDenied
  | CapabilityClassUnsupported
  | CapabilityClassStorageClassBlocked;

/** A single cached capability record. */
export interface CapabilityRecord {
  class: CapabilityClass;
  /** Unix timestamp (seconds) when this record was written. */
  learnedAt: number;
}

/**
 * All known capabilities for a profile, keyed by `"<bucket>/<op>"`.
 *
 * The bucket part is empty (`"/<op>"`) for profile-level operations such as
 * `ListBuckets`.
 */
export type CapabilityMap = Record<string, CapabilityRecord>;

// ---------------------------------------------------------------------------
// Scope types
// ---------------------------------------------------------------------------

/** Scope selector for `capabilityGet`. */
export type CapabilityScope =
  | { kind: "all" }
  | { kind: "bucket"; bucketId: string }
  | { kind: "op"; op: string };

/**
 * Scope selector for `capabilityClear`.
 *
 * When `undefined` the backend defaults to `All`.
 */
export type ClearScope =
  | { kind: "all" }
  | { kind: "bucket"; bucketId: string }
  | { kind: "op"; op: string };

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Return the cached capability map for `profileId`, optionally filtered by
 * `scope`.
 *
 * Keys in the returned map are `"<bucket>/<op>"` where `<bucket>` is empty
 * for profile-level operations.
 */
export function capabilityGet(
  profileId: string,
  scope: CapabilityScope = { kind: "all" },
): Promise<CapabilityMap> {
  return invoke<CapabilityMap>("capability_get", {
    profileId,
    scope,
  });
}

/**
 * Manually clear cached capabilities for `profileId`.
 *
 * When `scope` is omitted all entries for the profile are removed.
 */
export function capabilityClear(
  profileId: string,
  scope?: ClearScope,
): Promise<void> {
  return invoke<void>("capability_clear", {
    profileId,
    scope: scope ?? null,
  });
}

// ---------------------------------------------------------------------------
// Object inspector types
// ---------------------------------------------------------------------------

/**
 * All properties returned by HeadObject for a single S3 object.
 *
 * User-defined metadata (`x-amz-meta-*`) is surfaced in `metadata` with keys
 * stripped of the prefix.
 */
export interface ObjectHead {
  /** Object size in bytes. */
  contentLength: number | null;
  /** MIME type, e.g. `"application/octet-stream"`. */
  contentType: string | null;
  /** Unix epoch (seconds) of last modification. */
  lastModified: number | null;
  /** HTTP ETag string (including surrounding quotes from S3). */
  etag: string | null;
  /** Version ID when bucket versioning is enabled. */
  versionId: string | null;
  /** S3 storage class, e.g. `"STANDARD"`, `"GLACIER"`. */
  storageClass: string | null;
  /** SSE algorithm, e.g. `"aws:kms"` or `"AES256"`. */
  serverSideEncryption: string | null;
  /** KMS key ID when SSE-KMS is active. */
  sseKmsKeyId: string | null;
  /** `Content-Encoding` header value, e.g. `"gzip"`. */
  contentEncoding: string | null;
  /** `Content-Disposition` header value. */
  contentDisposition: string | null;
  /** `Cache-Control` header value. */
  cacheControl: string | null;
  /** `Expires` header as Unix epoch (seconds), if present. */
  expires: number | null;
  /** User-defined metadata keys (stripped of `x-amz-meta-` prefix). */
  metadata: Record<string, string>;
}

/** ACL summary: owner display name + total grant count. */
export interface AclSummary {
  /** Owner display name when available. */
  ownerDisplayName: string | null;
  /** Total number of individual grants. */
  grantsCount: number;
}

/**
 * Glacier / Deep Archive restore status.
 *
 * `ongoing: true` while a restore job is in progress.
 * `expirySecs` is set to the Unix epoch when the restored copy will expire.
 */
export interface RestoreStatus {
  /** `true` while a Glacier restore job is in progress. */
  ongoing: boolean;
  /** Unix epoch (seconds) when the restored copy expires, once complete. */
  expirySecs: number | null;
}

/**
 * Aggregated read-only properties for a single S3 object.
 *
 * `restoreStatus` is `{ kind: "value", value: null }` for non-Glacier objects.
 */
export interface ObjectInspectorReport {
  /** Properties from `HeadObject`. */
  head: ObjectHead;
  /** Object tags from `GetObjectTagging`. */
  tags: SectionResult<Record<string, string>>;
  /** ACL summary from `GetObjectAcl`. */
  aclSummary: SectionResult<AclSummary>;
  /**
   * Glacier/Deep Archive restore status.
   *
   * `Value(null)` means the object is in a non-Glacier class.
   * `Value(RestoreStatus)` carries the parsed status.
   */
  restoreStatus: SectionResult<RestoreStatus | null>;
  /** Version ID (also on `head.versionId`). */
  versionId: string | null;
  /** SHA-256 checksum if returned by S3. */
  checksumSha256: string | null;
  /** MD5 / ETag (from non-multipart uploads). */
  checksumMd5: string | null;
  /** CRC-32 checksum if returned by S3. */
  checksumCrc32: string | null;
}

// ---------------------------------------------------------------------------
// Bucket inspector
// ---------------------------------------------------------------------------

/**
 * Inspect a bucket and return an aggregated `BucketInspectorReport`.
 *
 * Each section in the report has a `kind` discriminator:
 * - `"value"` — the API succeeded.
 * - `"denied"` — IAM policy blocked this section; `iamAction` names the
 *   required permission (e.g. `"s3:GetBucketVersioning"`).
 * - `"unsupported"` — the provider does not implement this API.
 * - `"deferred"` — intentionally absent in v1 (currently only `bucketPolicy`).
 *
 * `AccessDenied` outcomes are automatically cached on the Rust side so the UI
 * can render disabled reasons on subsequent renders without re-fetching.
 */
export function bucketInspect(
  profileId: string,
  bucket: string,
): Promise<BucketInspectorReport> {
  return invoke<BucketInspectorReport>("bucket_inspect", { profileId, bucket });
}

// ---------------------------------------------------------------------------
// Object inspector
// ---------------------------------------------------------------------------

/**
 * Inspect a single S3 object and return an aggregated `ObjectInspectorReport`.
 *
 * `versionId` is optional; omit to inspect the latest version.
 *
 * `AccessDenied` on tags or ACL degrades to `{ kind: "denied", iamAction }`
 * rather than a hard error. The denial is automatically cached on the Rust
 * side so the UI shows disabled reasons without re-fetching.
 */
export function objectInspect(
  profileId: string,
  bucket: string,
  key: string,
  versionId?: string,
): Promise<ObjectInspectorReport> {
  return invoke<ObjectInspectorReport>("object_inspect", {
    profileId,
    bucket,
    key,
    versionId: versionId ?? null,
  });
}
