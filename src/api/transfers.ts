/**
 * API module for transfer (download/upload) commands and event types.
 *
 * Each function wraps exactly one Rust command. Types mirror the Rust serde
 * shapes (camelCase). Adding a new backend command = one function here.
 *
 * OCP: Transfer may gain `checksum`, `priority`, `retries` in a later task —
 * the interface is additive; existing call sites are unaffected.
 */

import { invoke } from "@/lib/tauri";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Lifecycle state of a transfer.
 *
 * Mirrors `TransferState` in `src-tauri/src/transfers/mod.rs`.
 */
export type TransferState =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "canceled";

/**
 * Discriminates between download and upload transfers.
 *
 * Mirrors `TransferKind` in `src-tauri/src/transfers/mod.rs`.
 */
export type TransferKind = "download" | "upload";

/**
 * Full state record for one download or upload transfer.
 *
 * Mirrors `Transfer` in `src-tauri/src/transfers/mod.rs`.
 *
 * OCP: `checksum`, `priority`, `retries` may be added here later without
 * breaking existing consumers.
 */
export interface Transfer {
  /** UUID v4 request identifier. */
  id: string;
  /**
   * Optional group identifier. Every Transfer kicked off by the same
   * user gesture (one click on Download, one drag-drop, one bulk
   * Upload) shares the same `batchId`, so the Transfer Manager can
   * render them under a single collapsible parent row instead of as
   * dozens of flat rows.
   *
   * Frontend-only — generated client-side and never round-tripped to
   * the backend.
   */
  batchId?: string;
  kind: TransferKind;
  profileId: string;
  bucket: string;
  /** S3 object key. */
  key: string;
  /** Source local path for uploads. Absent for downloads. */
  sourcePath?: string;
  /** Destination local path for downloads. Absent for uploads. */
  destPath?: string;
  /** Total bytes, if known before the transfer starts. */
  totalBytes?: number;
  /** Bytes transferred so far. */
  transferredBytes: number;
  /** Multipart parts completed so far. */
  partsDone: number;
  /** Total multipart parts, if applicable. */
  partsTotal: number;
  state: TransferState;
  /** Unix timestamp (milliseconds) when the transfer was registered. */
  startedAt: number;
  /** Unix timestamp (milliseconds) when the transfer reached a terminal state. */
  finishedAt?: number;
  /** AppError details when `state` is `"failed"`. Hydrated from the
   *  `transfer:state` event payload (or `transfer_list` snapshot) and used
   *  by TransferRow to render the failure reason. */
  error?: import("@/lib/errors").AppError;
}

/**
 * Filter for `transferList`.
 *
 * Mirrors `TransferFilter` in `src-tauri/src/transfers/mod.rs`.
 * OCP: new filter values are additive.
 */
export type TransferFilter = "active" | "completed" | "failed" | "all";

/**
 * Input for a single upload entry in `transferUploadMany`.
 *
 * Mirrors `TransferUploadSpec` in `src-tauri/src/commands/transfers_cmd.rs`.
 */
export interface TransferUploadSpec {
  profileId: string;
  bucket: string;
  key: string;
  sourcePath: string;
}

/**
 * Input for a single download entry in `transferDownloadMany`.
 *
 * Mirrors `TransferDownloadSpec` in `src-tauri/src/commands/transfers_cmd.rs`.
 */
export interface TransferDownloadSpec {
  profileId: string;
  bucket: string;
  key: string;
  destPath: string;
}

/**
 * Payload for the `transfer:progress` event.
 *
 * Subscribe via Tauri's `listen("transfer:progress", handler)`.
 */
export interface TransferProgressPayload {
  requestId: string;
  bytesDone: number;
  bytesTotal?: number;
  partsDone: number;
  partsTotal: number;
}

/**
 * Payload for the `transfer:state` event.
 *
 * Subscribe via Tauri's `listen("transfer:state", handler)`.
 */
export interface TransferStatePayload {
  requestId: string;
  state: TransferState;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Initiate a streaming download of `key` from `bucket` to `destPath`.
 *
 * Returns the `requestId` (UUID v4) immediately.  The actual download runs
 * in a background Rust task.  Listen for progress and state updates via:
 *
 * ```ts
 * const unlisten = await listen<TransferProgressPayload>(
 *   "transfer:progress",
 *   (event) => {
 *     if (event.payload.requestId === requestId) { ... }
 *   }
 * );
 * ```
 *
 * @param profileId - The profile whose credentials to use.
 * @param bucket    - The bucket name.
 * @param key       - The S3 object key to download.
 * @param destPath  - Local filesystem path where the file should be written.
 * @returns The `requestId` to correlate progress/state events.
 */
export function transferDownload(
  profileId: string,
  bucket: string,
  key: string,
  destPath: string,
): Promise<string> {
  return invoke<string>("transfer_download", {
    profileId,
    bucket,
    key,
    destPath,
  });
}

/**
 * Initiate an upload of a local file to `bucket/key`.
 *
 * Returns the `requestId` (UUID v4) immediately.  The actual upload runs in
 * a background Rust task.  Listen for progress and state updates via:
 *
 * ```ts
 * const unlisten = await listen<TransferProgressPayload>(
 *   "transfer:progress",
 *   (event) => {
 *     if (event.payload.requestId === requestId) { ... }
 *   }
 * );
 * ```
 *
 * On success the backend also emits `objects:updated { profileId, bucket, prefix }`
 * so the frontend can invalidate the adapter cache for the affected prefix.
 *
 * @param profileId  - The profile whose credentials to use.
 * @param bucket     - The destination bucket name.
 * @param key        - The S3 object key to create or replace.
 * @param sourcePath - Local filesystem path of the file to upload.
 * @returns The `requestId` to correlate progress/state events.
 */
export function transferUpload(
  profileId: string,
  bucket: string,
  key: string,
  sourcePath: string,
): Promise<string> {
  return invoke<string>("transfer_upload", {
    profileId,
    bucket,
    key,
    sourcePath,
  });
}

/**
 * List transfers, optionally filtered by state.
 *
 * @param filter - `"active"` | `"completed"` | `"failed"` | `"all"` | `null`
 *                 (null = all).
 * @returns Array of Transfer records.
 */
export function transferList(
  filter?: TransferFilter | null,
): Promise<Transfer[]> {
  return invoke<Transfer[]>("transfer_list", { filter: filter ?? null });
}

/**
 * Cancel an in-flight transfer.
 *
 * Idempotent: canceling an already-terminal transfer returns without error.
 *
 * @param requestId - The UUID v4 request ID returned by `transferDownload` or
 *                    `transferUpload`.
 */
export function transferCancel(requestId: string): Promise<void> {
  return invoke<void>("transfer_cancel", { requestId });
}

/**
 * Re-enqueue a failed or canceled transfer from the beginning.
 *
 * A new request ID is returned; the original transfer record is unchanged.
 * Retries are not resumable in v1 (per AC-14).
 *
 * @param requestId - The UUID v4 request ID of the failed/canceled transfer.
 * @returns A new `requestId` for the re-started transfer.
 */
export function transferRetry(requestId: string): Promise<string> {
  return invoke<string>("transfer_retry", { requestId });
}

/**
 * Bulk-enqueue multiple uploads.
 *
 * Returns a list of request IDs in the same order as `specs`. The backend
 * now fails-fast on the first un-enqueable spec — the call rejects with
 * the underlying `AppError`. Callers should surface the rejection via
 * `surfaceUnknownError` (see `Toolbar.handleUpload`).
 *
 * @param specs - Array of upload specs.
 * @returns Array of request IDs.
 */
export function transferUploadMany(
  specs: TransferUploadSpec[],
): Promise<string[]> {
  return invoke<string[]>("transfer_upload_many", { specs });
}

/**
 * Bulk-enqueue multiple downloads.
 *
 * Returns a list of request IDs in the same order as `specs`. The backend
 * now fails-fast on the first un-enqueable spec — see `transferUploadMany`
 * for the full rationale.
 *
 * @param specs - Array of download specs.
 * @returns Array of request IDs.
 */
export function transferDownloadMany(
  specs: TransferDownloadSpec[],
): Promise<string[]> {
  return invoke<string[]>("transfer_download_many", { specs });
}

// ---------------------------------------------------------------------------
// Multipart cleanup scanner types and commands
// ---------------------------------------------------------------------------

/**
 * Discriminates the origin of an in-progress multipart upload.
 *
 * Mirrors `MultipartSource` in `src-tauri/src/s3/multipart.rs`.
 *
 * OCP: Binary in v1. Adding `remoteAgent` is one new variant.
 */
export type MultipartSource = "brows3r" | "unknown";

/**
 * One in-progress multipart upload as returned by the cleanup scanner.
 *
 * Mirrors `MultipartUpload` in `src-tauri/src/s3/multipart.rs`.
 */
export interface MultipartUpload {
  /** AWS multipart upload ID. */
  uploadId: string;
  /** S3 object key. */
  key: string;
  /** Unix timestamp (seconds) when the upload was initiated, if known. */
  initiated?: number;
  /** Whether this upload was started by brows3r or an external tool. */
  source: MultipartSource;
  /** Bucket in which the upload is in-progress. */
  bucket: string;
}

/**
 * List all in-progress multipart uploads for `bucket`, classified as
 * `"brows3r"` (tracked by this app) or `"unknown"` (foreign).
 *
 * Optionally filter out uploads younger than `olderThanSecs` seconds so the
 * scanner can be used for "auto-cleanup uploads older than 24h" jobs.
 *
 * @param profileId    - The profile whose credentials to use.
 * @param bucket       - The bucket to scan.
 * @param olderThanSecs - When set, uploads initiated less than this many
 *                        seconds ago are excluded from the result.
 * @returns Array of in-progress multipart uploads.
 */
export function multipartScan(
  profileId: string,
  bucket: string,
  olderThanSecs?: number,
): Promise<MultipartUpload[]> {
  return invoke<MultipartUpload[]>("multipart_scan", {
    profileId,
    bucket,
    olderThanSecs: olderThanSecs ?? null,
  });
}

/**
 * Abort a single in-progress multipart upload.
 *
 * If `source` is `"unknown"` and `confirmedUnknown` is not `true`, the
 * backend returns a `Validation` error — the frontend must show an explicit
 * confirmation dialog before calling this again with `confirmedUnknown: true`.
 *
 * @param profileId        - The profile whose credentials to use.
 * @param bucket           - The bucket containing the upload.
 * @param uploadId         - The AWS multipart upload ID to abort.
 * @param key              - The S3 object key.
 * @param source           - Whether this upload was started by brows3r.
 * @param confirmedUnknown - Must be `true` when `source` is `"unknown"`.
 */
export function multipartAbort(
  profileId: string,
  bucket: string,
  uploadId: string,
  key: string,
  source: MultipartSource,
  confirmedUnknown?: boolean,
): Promise<void> {
  return invoke<void>("multipart_abort", {
    profileId,
    bucket,
    uploadId,
    key,
    source,
    confirmedUnknown: confirmedUnknown ?? null,
  });
}
