/**
 * API module for object listing and mutation commands.
 *
 * Each function wraps exactly one Rust command. Types mirror the Rust serde
 * shapes (camelCase). Adding a new backend command = one function here.
 *
 * OCP: ObjectEntry and ListPage may gain `versions`, `owner`, or `checksum`
 * in a later task — the interface is additive; existing call sites are unaffected.
 *
 * Mutation commands (objectCopy, objectMove, objectCreateFolder) follow the
 * same pattern: they take typed input, return typed output, and the backend
 * emits `objects:updated` so TanStack Query adapters can invalidate caches.
 */

import { invoke } from "@/lib/tauri";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single entry returned by object listing commands.
 *
 * Both real objects and virtual-folder prefixes (`CommonPrefixes`) are
 * represented by this type. `isPrefix = true` marks virtual folders so the
 * frontend handles one flat array instead of two separate lists.
 *
 * Mirrors `src-tauri/src/s3/list.rs` ObjectEntry.
 */
export interface ObjectEntry {
  /** Full S3 key for objects; the common-prefix string for virtual folders. */
  key: string;
  /** Object size in bytes. Always `0` for virtual-folder prefix entries. */
  size: number;
  /**
   * Last-modified Unix timestamp in milliseconds.
   * Absent for virtual-folder prefix entries.
   */
  lastModified?: number;
  /**
   * S3 ETag string (usually an MD5 hex or multipart hash).
   * Absent for prefix entries and objects where S3 did not return an ETag.
   */
  etag?: string;
  /**
   * S3 storage class (`STANDARD`, `GLACIER`, …).
   * Absent for virtual-folder prefix entries.
   */
  storageClass?: string;
  /** `true` when this entry represents a `CommonPrefixes` virtual folder. */
  isPrefix: boolean;
}

/**
 * One page of `ListObjectsV2` results.
 *
 * The frontend drives infinite scroll by passing `nextContinuationToken`
 * back as `continuationToken` on the next call.
 *
 * Mirrors `src-tauri/src/s3/list.rs` ListPage.
 */
export interface ListPage {
  /**
   * All entries for this page — objects and virtual-folder prefixes
   * interleaved. Prefix entries carry `isPrefix = true`.
   */
  entries: ObjectEntry[];
  /** Raw common-prefix strings preserved from the S3 response. */
  commonPrefixes: string[];
  /**
   * Continuation token for the next page.
   * Absent when this is the last page.
   */
  nextContinuationToken?: string;
  /** Whether S3 indicated the listing was truncated. */
  isTruncated: boolean;
  /** The prefix used for this listing request. */
  prefix: string;
  /**
   * The delimiter used for this listing request.
   * Absent for flat listings.
   */
  delimiter?: string;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ObjectsListOpts {
  /** Continuation token from a previous page's `nextContinuationToken`. */
  continuationToken?: string;
  /** When `true`, bypass the Rust-side cache and fetch from S3. */
  force?: boolean;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * List objects under `prefix` in `bucket` with `delimiter="/"`.
 *
 * Returns virtual-folder prefixes (CommonPrefixes) as entries with
 * `isPrefix = true`.  First-page results are cached on the Rust side;
 * subsequent pages always hit S3.
 *
 * @param profileId - The profile whose credentials to use.
 * @param bucket    - The bucket name.
 * @param prefix    - The prefix to list under (e.g. `"photos/"` or `""`).
 * @param opts      - Optional continuation token and cache-bypass flag.
 */
export function objectsList(
  profileId: string,
  bucket: string,
  prefix: string,
  opts?: ObjectsListOpts,
): Promise<ListPage> {
  return invoke<ListPage>("objects_list", {
    profileId,
    bucket,
    prefix,
    continuationToken: opts?.continuationToken ?? null,
    force: opts?.force ?? null,
  });
}

/**
 * List all objects under `prefix` in `bucket` without a delimiter.
 *
 * Returns the full key tree — no virtual folders.  Useful for search,
 * bulk selection, or computing prefix sizes.  First-page results are
 * cached on the Rust side using a separate cache key from `objectsList`.
 *
 * @param profileId - The profile whose credentials to use.
 * @param bucket    - The bucket name.
 * @param prefix    - The prefix to list under.
 * @param opts      - Optional continuation token and cache-bypass flag.
 */
export function objectsListFlat(
  profileId: string,
  bucket: string,
  prefix: string,
  opts?: ObjectsListOpts,
): Promise<ListPage> {
  return invoke<ListPage>("objects_list_flat", {
    profileId,
    bucket,
    prefix,
    continuationToken: opts?.continuationToken ?? null,
    force: opts?.force ?? null,
  });
}

// ---------------------------------------------------------------------------
// Mutation types
// ---------------------------------------------------------------------------

/**
 * Reference to a single S3 object: bucket + full key.
 *
 * Mirrors `src-tauri/src/commands/objects_cmd.rs` ObjectRef.
 *
 * OCP: `versionId` can be added later without breaking existing callers.
 */
export interface ObjectRef {
  bucket: string;
  key: string;
}

/**
 * Metadata / tagging directive for CopyObject.
 *
 * `"COPY"` (default) preserves the source values.
 * `"REPLACE"` uses the values supplied in the request.
 */
export type MetadataDirective = "COPY" | "REPLACE";

/**
 * Options passed to the Rust `object_copy` and `object_move` commands.
 *
 * OCP: new directives (checksum, object-lock) can be added as optional fields
 * without breaking existing call sites.
 *
 * Mirrors `src-tauri/src/s3/object.rs` CopyOptions.
 */
export interface CopyOptions {
  metadataDirective?: MetadataDirective;
  taggingDirective?: MetadataDirective;
  storageClass?: string;
  acl?: string;
  serverSideEncryption?: string;
}

/**
 * ETag + last-modified from the `CopyObjectResult` response element.
 *
 * Mirrors `src-tauri/src/s3/object.rs` CopyObjectResultDetail.
 */
export interface CopyObjectResultDetail {
  etag?: string;
  /** Unix timestamp in milliseconds. */
  lastModified?: number;
}

/**
 * Result returned by `objectCopy`.
 *
 * Mirrors `src-tauri/src/s3/object.rs` CopyResult.
 */
export interface CopyResult {
  copyObjectResult: CopyObjectResultDetail;
}

/**
 * Discriminated result returned by `objectCopy`.
 *
 * `type === "serverSideCopy"` — the S3 server-side CopyObject API succeeded.
 * `type === "fallbackUsed"`   — cross-account detected; download+upload fallback was used.
 *
 * OCP: new variants (`asyncTransferQueued`, …) may be added without breaking
 * existing call sites that switch on `type`.
 *
 * Mirrors `src-tauri/src/s3/object.rs` CopyOutcome.
 */
export type CopyOutcome =
  | { type: "serverSideCopy"; result: CopyResult }
  | {
      type: "fallbackUsed";
      /** Byte size of the source object transferred via fallback. */
      sourceSize: number;
      result: CopyResult;
    };

/**
 * Result returned by `objectMove`.
 *
 * Wraps `CopyResult` so the frontend can distinguish move vs copy results.
 *
 * Mirrors `src-tauri/src/s3/object.rs` MoveResult.
 */
export interface MoveResult {
  copyResult: CopyResult;
}

// ---------------------------------------------------------------------------
// Mutation commands
// ---------------------------------------------------------------------------

/**
 * Copy `source` to `destination` with automatic cross-account fallback.
 *
 * The backend attempts a server-side `CopyObject` first.  On `AccessDenied`
 * (cross-account signal) it falls back to download+upload when the source is
 * ≤ 100 MiB.  For larger files an explicit `confirmedToken` (obtained via
 * `crossAccountConfirm`) is required.
 *
 * The backend acquires locks on both source and destination prefixes,
 * performs the copy, invalidates the destination prefix cache, and emits
 * `objects:updated { profileId, bucket, prefix }` for the destination.
 *
 * @param profileId      - The profile whose credentials to use.
 * @param source         - Source bucket + key.
 * @param destination    - Destination bucket + key (may be a different bucket).
 * @param options        - Copy directives (defaults to Copy/Copy if omitted).
 * @param confirmedToken - One-time token from `crossAccountConfirm` for large
 *                         cross-account copies.
 */
export function objectCopy(
  profileId: string,
  source: ObjectRef,
  destination: ObjectRef,
  options?: CopyOptions,
  confirmedToken?: string,
): Promise<CopyOutcome> {
  return invoke<CopyOutcome>("object_copy", {
    profileId,
    source,
    destination,
    options: options ?? {},
    confirmedToken: confirmedToken ?? null,
  });
}

/**
 * Mint a one-time confirmation token for a large cross-account copy.
 *
 * Call this after `objectCopy` returns `AppError { kind: "Validation",
 * details.field: "confirmed_token" }`.  The returned token is bound to the
 * given (profileId, source, destination) scope and expires after 5 minutes.
 * Pass it back to `objectCopy` as `confirmedToken`.
 *
 * @param profileId   - The profile whose credentials to use.
 * @param source      - Source bucket + key (must match the failed copy call).
 * @param destination - Destination bucket + key (must match the failed copy call).
 * @returns           - A single-use confirmation token string (UUID v4).
 */
export function crossAccountConfirm(
  profileId: string,
  source: ObjectRef,
  destination: ObjectRef,
): Promise<string> {
  return invoke<string>("cross_account_confirm", {
    profileId,
    source,
    destination,
  });
}

/**
 * Move `source` to `destination`: server-side copy then delete source.
 *
 * On success the backend emits `objects:updated` for both source and
 * destination prefixes so the frontend can invalidate both listings.
 *
 * @param profileId   - The profile whose credentials to use.
 * @param source      - Source bucket + key.
 * @param destination - Destination bucket + key.
 * @param options     - Copy directives (defaults to Copy/Copy if omitted).
 */
export function objectMove(
  profileId: string,
  source: ObjectRef,
  destination: ObjectRef,
  options?: CopyOptions,
): Promise<MoveResult> {
  return invoke<MoveResult>("object_move", {
    profileId,
    source,
    destination,
    options: options ?? {},
  });
}

/**
 * Create a virtual folder placeholder at `bucket/prefix/`.
 *
 * Issues a zero-byte `PutObject` with key `prefix/` (trailing slash added
 * automatically if missing). Idempotent — overwriting an existing placeholder
 * is harmless.
 *
 * On success the backend emits `objects:updated { profileId, bucket, prefix }`
 * for the parent prefix so the listing refreshes.
 *
 * @param profileId - The profile whose credentials to use.
 * @param bucket    - The bucket name.
 * @param prefix    - The new folder name/path (trailing slash is optional).
 */
export function objectCreateFolder(
  profileId: string,
  bucket: string,
  prefix: string,
): Promise<void> {
  return invoke<void>("object_create_folder", { profileId, bucket, prefix });
}

// ---------------------------------------------------------------------------
// Batch delete types
// ---------------------------------------------------------------------------

/**
 * One key (with optional version ID) in a batch delete request.
 *
 * Mirrors `src-tauri/src/commands/objects_cmd.rs` DeleteKey.
 *
 * OCP: `bypassGovernanceRetention?: boolean` can be added later for
 * object-lock support without breaking existing callers.
 */
export interface DeleteKey {
  key: string;
  versionId?: string;
}

/**
 * One successfully deleted entry in a `DeleteReport`.
 *
 * Mirrors `src-tauri/src/s3/object.rs` DeletedObject.
 */
export interface DeletedObject {
  key: string;
  versionId?: string;
  /** `true` when a delete marker was created (versioned bucket, no versionId supplied). */
  deleteMarker?: boolean;
  deleteMarkerVersionId?: string;
}

/**
 * One entry that failed to delete in a `DeleteReport`.
 *
 * Mirrors `src-tauri/src/s3/object.rs` DeleteFailure.
 */
export interface DeleteFailure {
  key: string;
  versionId?: string;
  /** S3 error code (e.g. `"AccessDenied"`, `"NoSuchVersion"`). */
  code: string;
  message: string;
}

/**
 * Result of `objectDeleteBatch`.
 *
 * Both `deleted` and `failed` may be non-empty for the same request —
 * the backend does NOT fail the whole batch on per-key errors (AC-4).
 * The frontend should surface "N deleted, M failed" rather than all-or-nothing.
 *
 * Mirrors `src-tauri/src/s3/object.rs` DeleteReport.
 */
export interface DeleteReport {
  deleted: DeletedObject[];
  failed: DeleteFailure[];
}

// ---------------------------------------------------------------------------
// Metadata / tag types
// ---------------------------------------------------------------------------

/**
 * Key-value map for user-defined S3 metadata.
 *
 * Mirrors the `HashMap<String, String>` accepted by `object_set_metadata`.
 * All keys and values must be US-ASCII printable characters (S3 constraint).
 */
export type MetadataMap = Record<string, string>;

/**
 * Key-value map for S3 object tags.
 *
 * Mirrors the `HashMap<String, String>` accepted by `object_set_tags`.
 * An empty map triggers tag removal (`DeleteObjectTagging`).
 */
export type TagsMap = Record<string, string>;

/**
 * Result returned by `objectSetMetadata` and `objectSetTags`.
 *
 * Mirrors `src-tauri/src/s3/metadata.rs` PutResult.
 *
 * OCP: `checksum` and `sseKmsKeyId` can be added as optional fields in a
 * future task without breaking existing call sites.
 */
export interface PutResult {
  /** ETag of the object after the operation, stripped of surrounding quotes. */
  etag?: string;
  /** Unix timestamp in milliseconds of the last-modified time after the op. */
  lastModified?: number;
  /** Version ID when the bucket has versioning enabled. */
  versionId?: string;
}

// ---------------------------------------------------------------------------
// Batch delete command
// ---------------------------------------------------------------------------

/**
 * Delete a batch of objects from `bucket`.
 *
 * - Each entry in `keys` may carry an optional `versionId` to target a
 *   specific version (versioned buckets); omitting it inserts a delete marker.
 * - The backend batches at most 1 000 keys per AWS `DeleteObjects` call
 *   internally — callers may pass any number of keys.
 * - Per-key failures are returned in `DeleteReport.failed` rather than
 *   throwing. Check both arrays to determine what actually happened.
 *
 * On success the backend emits `objects:updated { profileId, bucket, prefix }`
 * once per unique parent prefix of each successfully deleted key.
 *
 * @param profileId - The profile whose credentials to use.
 * @param bucket    - The bucket name.
 * @param keys      - The keys (and optional version IDs) to delete.
 */
export function objectDeleteBatch(
  profileId: string,
  bucket: string,
  keys: DeleteKey[],
): Promise<DeleteReport> {
  return invoke<DeleteReport>("object_delete_batch", {
    profileId,
    bucket,
    keys,
  });
}

// ---------------------------------------------------------------------------
// Metadata + tag mutation commands
// ---------------------------------------------------------------------------

/**
 * Replace the user-defined metadata on `bucket/key`.
 *
 * Uses a server-side `CopyObject` self-overwrite with `MetadataDirective: Replace`
 * so the object body is preserved without re-uploading.
 *
 * When `ifMatchEtag` is supplied the backend enforces an ETag precondition.
 * A mismatch rejects with `AppError { kind: "Conflict" }`.
 *
 * On success the backend emits `objects:updated { profileId, bucket, prefix }`
 * for the parent prefix of `key`.
 *
 * @param profileId    - The profile whose credentials to use.
 * @param bucket       - The bucket name.
 * @param key          - The full S3 key of the object.
 * @param metadata     - New metadata map (replaces all existing metadata).
 * @param ifMatchEtag  - Optional ETag precondition.
 */
export function objectSetMetadata(
  profileId: string,
  bucket: string,
  key: string,
  metadata: MetadataMap,
  ifMatchEtag?: string,
): Promise<PutResult> {
  return invoke<PutResult>("object_set_metadata", {
    profileId,
    bucket,
    key,
    metadata,
    ifMatchEtag: ifMatchEtag ?? null,
  });
}

/**
 * Set (or clear) the tags on `bucket/key`.
 *
 * An empty `tags` map removes all tags via `DeleteObjectTagging`.
 *
 * When `ifMatchEtag` is supplied the backend performs an explicit
 * `HeadObject` precondition check before `PutObjectTagging` (TOCTOU-limited,
 * but the best AWS allows for tag-only updates).
 *
 * On success the backend emits `objects:updated { profileId, bucket, prefix }`
 * for the parent prefix of `key`.
 *
 * @param profileId    - The profile whose credentials to use.
 * @param bucket       - The bucket name.
 * @param key          - The full S3 key of the object.
 * @param tags         - New tags map. Empty map removes all tags.
 * @param ifMatchEtag  - Optional ETag precondition.
 */
export function objectSetTags(
  profileId: string,
  bucket: string,
  key: string,
  tags: TagsMap,
  ifMatchEtag?: string,
): Promise<PutResult> {
  return invoke<PutResult>("object_set_tags", {
    profileId,
    bucket,
    key,
    tags,
    ifMatchEtag: ifMatchEtag ?? null,
  });
}

// ---------------------------------------------------------------------------
// Presigned URL types
// ---------------------------------------------------------------------------

/**
 * Result returned by `objectPresign`.
 *
 * The `url` field contains a fully-formed presigned `GetObject` URL that
 * embeds AWS SigV4 credentials in the query string.  The frontend should
 * write it to the clipboard — no further auth is required to access it.
 *
 * Mirrors `src-tauri/src/s3/presign.rs` PresignedUrl.
 *
 * OCP: `expiresInSecs` and `method` may be added as optional fields in a
 * future task without breaking existing call sites.
 */
export interface PresignedUrl {
  /** The fully-formed presigned URL string. */
  url: string;
  /** Unix timestamp in milliseconds when the URL expires. */
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Presigned URL command
// ---------------------------------------------------------------------------

/**
 * Generate a presigned `GetObject` URL for `bucket/key`.
 *
 * The URL is generated entirely in Rust — AWS credentials never cross the
 * IPC boundary.  The returned URL is valid for `expiresSec` seconds
 * (default: 3 600 s / 1 hour) and may be shared or copied to the clipboard.
 *
 * The backend validates the expiry range `[60, 604_800]` and returns
 * `AppError { kind: "Validation" }` for out-of-range values.
 *
 * @param profileId  - The profile whose credentials to use.
 * @param bucket     - The bucket name.
 * @param key        - The full S3 key of the object.
 * @param expiresSec - URL lifetime in seconds.  Must be in `[60, 604_800]`.
 *                     Defaults to `3_600` (1 hour) when omitted.
 */
export function objectPresign(
  profileId: string,
  bucket: string,
  key: string,
  expiresSec?: number,
): Promise<PresignedUrl> {
  return invoke<PresignedUrl>("object_presign", {
    profileId,
    bucket,
    key,
    expiresSec: expiresSec ?? null,
  });
}

// ---------------------------------------------------------------------------
// Object HEAD
// ---------------------------------------------------------------------------

/**
 * Lightweight HEAD-only metadata for a single S3 object.
 *
 * Mirrors `src-tauri/src/s3/inspector.rs` ObjectHead (same struct reused by
 * task 44 inspector).  Used by the preview pane for size-limit checks and
 * MIME-type routing without pulling the full inspector report.
 *
 * OCP: new optional fields (e.g. checksums, object-lock) can be added without
 * breaking existing callers.
 */
export interface ObjectHead {
  /** Object size in bytes. Absent for providers that omit Content-Length. */
  contentLength: number | null;
  /** MIME type, e.g. `"image/png"`. Absent when the object has no Content-Type. */
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
  /** `Content-Encoding` header value. */
  contentEncoding: string | null;
  /** `Content-Disposition` header value. */
  contentDisposition: string | null;
  /** `Cache-Control` header value. */
  cacheControl: string | null;
  /** `Expires` header as Unix epoch (seconds), if present. */
  expires: number | null;
  /** User-defined metadata (keys stripped of `x-amz-meta-` prefix). */
  metadata: Record<string, string>;
}

/**
 * Fetch HEAD metadata for a single S3 object.
 *
 * Lighter than `object_inspect` — only calls `HeadObject`, no tag/ACL fetches.
 * Used by the preview pane for size-limit checks and MIME routing.
 *
 * @param profileId - The profile whose credentials to use.
 * @param bucket    - The bucket name.
 * @param key       - The full S3 object key.
 * @param versionId - Optional version ID for versioned buckets.
 */
export function objectHead(
  profileId: string,
  bucket: string,
  key: string,
  versionId?: string,
): Promise<ObjectHead> {
  return invoke<ObjectHead>("object_head", {
    profileId,
    bucket,
    key,
    versionId: versionId ?? null,
  });
}

// ---------------------------------------------------------------------------
// Storage class mutation
// ---------------------------------------------------------------------------

/**
 * Change the storage class of one or more objects.
 *
 * Requires a `confirmedDiffId` from `diffPreviewCreate` that has not been
 * cancelled, expired, or already consumed.  The backend validates the diff
 * atomically before calling S3.
 *
 * On success the backend emits `objects:updated { profileId, bucket, prefix }`
 * for each affected object's parent prefix.
 *
 * # Decision D2 (optimistic boundary)
 *
 * This mutation is NOT subject to optimistic updates.  The caller must wait for
 * the `objects:updated` event to refresh the listing.
 * `EXCLUDED_FROM_OPTIMISM` in `src/query/optimistic.ts` contains
 * `"storage_class"` to enforce this.
 *
 * # Error cases
 *
 * - `AppError { kind: "Validation", details.field: "confirmed_diff_id" }` —
 *   diff was cancelled, expired, already consumed, or payload mismatch.
 *
 * @param profileId         - The profile whose credentials to use.
 * @param targets           - The objects to update.
 * @param newStorageClass   - The target storage class (e.g. `"GLACIER"`).
 * @param confirmedDiffId   - The `DiffId` from `diffPreviewCreate`.
 */
export function objectSetStorageClass(
  profileId: string,
  targets: ObjectRef[],
  newStorageClass: string,
  confirmedDiffId: string,
): Promise<PutResult[]> {
  return invoke<PutResult[]>("object_set_storage_class", {
    profileId,
    targets,
    newStorageClass,
    confirmedDiffId,
  });
}

// ---------------------------------------------------------------------------
// Text content types
// ---------------------------------------------------------------------------

/**
 * Payload returned by `objectGetText`.
 *
 * Mirrors `src-tauri/src/commands/objects_cmd.rs` TextPayload.
 *
 * OCP: `contentType` and `versionId` can be added as optional fields later.
 */
export interface TextPayload {
  /** UTF-8 text body (invalid bytes replaced with the replacement character). */
  body: string;
  /** Total object size in bytes on S3 (before truncation). */
  contentLength: number;
  /** HTTP ETag string from S3. */
  etag: string | null;
  /** `true` when the returned body was truncated at `maxBytes`. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// objectGetText
// ---------------------------------------------------------------------------

/**
 * Fetch the first `maxBytes` bytes of an S3 object as a UTF-8 string.
 *
 * The backend reads the body using a range request, decodes with lossy UTF-8
 * (invalid bytes → U+FFFD), and returns a `TextPayload`.
 *
 * @param profileId - The profile whose credentials to use.
 * @param bucket    - The bucket name.
 * @param key       - The full S3 key of the object.
 * @param maxBytes  - Maximum bytes to return. Defaults to 1 MB on the backend.
 */
export function objectGetText(
  profileId: string,
  bucket: string,
  key: string,
  maxBytes?: number,
): Promise<TextPayload> {
  return invoke<TextPayload>("object_get_text", {
    profileId,
    bucket,
    key,
    maxBytes: maxBytes ?? null,
  });
}

// ---------------------------------------------------------------------------
// objectGetBytes
// ---------------------------------------------------------------------------

/**
 * Payload returned by `objectGetBytes`.
 *
 * Mirrors `src-tauri/src/s3/object.rs` BytesPayload.
 *
 * OCP: `contentType` can be added as an optional field later.
 */
export interface BytesPayload {
  /** Base64-encoded raw bytes, at most `maxBytes` in length. */
  body: string;
  /** Total object size in bytes on S3 (before truncation). */
  contentLength: number;
  /** HTTP ETag string from S3. */
  etag?: string;
  /** `true` when the returned body was truncated at `maxBytes`. */
  truncated: boolean;
}

/**
 * Fetch the first `maxBytes` bytes of an S3 object as base64-encoded binary.
 *
 * The frontend decodes with:
 *   `Uint8Array.from(atob(payload.body), c => c.charCodeAt(0))`
 *
 * @param profileId - The profile whose credentials to use.
 * @param bucket    - The bucket name.
 * @param key       - The full S3 key of the object.
 * @param maxBytes  - Maximum bytes to return. Defaults to 1 MB on the backend.
 */
export function objectGetBytes(
  profileId: string,
  bucket: string,
  key: string,
  maxBytes?: number,
): Promise<BytesPayload> {
  return invoke<BytesPayload>("object_get_bytes", {
    profileId,
    bucket,
    key,
    maxBytes: maxBytes ?? null,
  });
}

// ---------------------------------------------------------------------------
// objectPutText
// ---------------------------------------------------------------------------

/**
 * Write a UTF-8 text body to `bucket/key`.
 *
 * When `ifMatchEtag` is supplied the backend sets the S3 `If-Match` header so
 * the write is rejected with `AppError { kind: "Conflict" }` if the object was
 * modified since the editor loaded it (HTTP 412).
 *
 * Omit `ifMatchEtag` (or pass `undefined`) for an unconditional "save anyway"
 * after a conflict.
 *
 * On success the backend emits `objects:updated { profileId, bucket, prefix }`
 * for the parent prefix of `key` so the listing refreshes.
 *
 * OCP: additional options (content-type, metadata) can be added as optional
 * fields without breaking existing call sites.
 *
 * @param profileId    - The profile whose credentials to use.
 * @param bucket       - The bucket name.
 * @param key          - The full S3 key of the object.
 * @param body         - UTF-8 text content to write.
 * @param ifMatchEtag  - Optional ETag precondition from `objectGetText`.
 */
export function objectPutText(
  profileId: string,
  bucket: string,
  key: string,
  body: string,
  ifMatchEtag?: string,
): Promise<PutResult> {
  return invoke<PutResult>("object_put_text", {
    profileId,
    bucket,
    key,
    body,
    ifMatchEtag: ifMatchEtag ?? null,
  });
}
