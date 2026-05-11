/**
 * API module for bucket listing commands.
 *
 * Each function wraps exactly one Rust command. Types mirror the Rust serde
 * shapes (camelCase). Adding a new backend command = one function here.
 *
 * OCP: BucketSummary may gain `tags`, `labels`, or `accessPoint` in a later
 * task — the interface is additive; existing call sites are unaffected.
 */

import { invoke } from "@/lib/tauri";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Lightweight bucket view returned over the Tauri IPC boundary.
 * Mirrors `src-tauri/src/s3/list.rs` BucketSummary.
 */
export interface BucketSummary {
  /** Bucket name as returned by S3. */
  name: string;
  /**
   * Unix timestamp (milliseconds) of bucket creation, if available.
   * Absent when the S3 API did not return creation metadata.
   */
  creationDate?: number;
  /**
   * AWS region discovered via GetBucketLocation.
   * Absent when background discovery has not finished yet.
   */
  region?: string;
  /** The profile this bucket belongs to. */
  profileId: string;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * List all buckets for the given profile.
 *
 * Applies the validation gate and SWR cache logic on the Rust side.
 * Emits `buckets:updated { profileId }` after every revalidation.
 *
 * @param profileId - The profile whose buckets to list.
 * @param force     - When `true`, bypass the cache and fetch from S3.
 */
export function bucketsList(
  profileId: string,
  force?: boolean,
): Promise<BucketSummary[]> {
  return invoke<BucketSummary[]>("buckets_list", {
    profileId,
    force: force ?? null,
  });
}

/**
 * Return the cached region for a bucket, resolving it lazily on cache miss.
 *
 * If the region is not yet known, the Rust side calls GetBucketLocation
 * synchronously and caches the result before returning.
 *
 * @param profileId - The profile the bucket belongs to.
 * @param bucket    - The bucket name.
 */
export function bucketRegionGet(
  profileId: string,
  bucket: string,
): Promise<string> {
  return invoke<string>("bucket_region_get", { profileId, bucket });
}
