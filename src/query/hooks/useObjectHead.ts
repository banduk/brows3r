/**
 * useObjectHead — TanStack Query wrapper for `objectHead`.
 *
 * Fetches HEAD-only metadata (content-length, content-type, …) for a single
 * S3 object. Used by the preview pane for size-limit checks and MIME routing.
 *
 * Gated by profile validation (AC-8 / round-1 finding #9): the query is
 * disabled until the profile is validated so cached data is never exposed for
 * unvalidated profiles.
 *
 * OCP: adding a `versionId` overload is one optional parameter — no callers
 * change.
 */

import { useQuery } from "@tanstack/react-query";
import type { ObjectHead } from "@/api/objects";
import { objectHead } from "@/api/objects";
import { keys } from "@/query/keys";
import { useValidatedProfile } from "./useValidatedProfile";

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseObjectHeadResult {
  data: ObjectHead | undefined;
  isLoading: boolean;
  isError: boolean;
  /** `true` when the profile has not been validated — query is suppressed. */
  isGated: boolean;
  /**
   * Unix ms timestamp of when the data was last fetched from S3.
   * `0` when no fetch has completed yet. Used by the status bar to render
   * a "fetched Xs ago" indicator so the user knows the head may be stale.
   */
  dataUpdatedAt: number;
}

/**
 * Load HEAD metadata for `profileId/bucket/key`.
 *
 * Returns `isGated = true` (and no data) when the profile is not validated.
 *
 * @param profileId - The profile ID (may be null/undefined when nothing is selected).
 * @param bucket    - The bucket name (may be null/undefined).
 * @param key       - The full S3 object key (may be null/undefined).
 * @param versionId - Optional version ID for versioned buckets.
 */
export function useObjectHead(
  profileId: string | null | undefined,
  bucket: string | null | undefined,
  key: string | null | undefined,
  versionId?: string,
): UseObjectHeadResult {
  const { isValidated, isLoading: profileLoading } =
    useValidatedProfile(profileId);

  const enabled =
    Boolean(profileId) && Boolean(bucket) && Boolean(key) && isValidated;

  const { data, isLoading, isError, dataUpdatedAt } = useQuery({
    queryKey:
      profileId && bucket && key
        ? keys.objectHead(profileId, bucket, key, versionId)
        : (["object", null, null, null, null] as const),
    queryFn: (): Promise<ObjectHead> =>
      objectHead(
        profileId as string,
        bucket as string,
        key as string,
        versionId,
      ),
    enabled,
  });

  if (!isValidated) {
    return {
      data: undefined,
      isLoading: profileLoading,
      isError: false,
      isGated: true,
      dataUpdatedAt: 0,
    };
  }

  return {
    data,
    isLoading,
    isError,
    isGated: false,
    dataUpdatedAt,
  };
}
