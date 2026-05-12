/**
 * useValidatedProfile — single gate for profile-gated data fetching.
 *
 * Any hook that fetches buckets, objects, or inspector data MUST call this
 * first and set `enabled: false` when `isValidated` is false.
 *
 * Design: "validated" means the backend has a non-null `validatedAt` on the
 * profile summary. We do not apply a client-side staleness threshold here —
 * the backend's own session-scoped guard is the authoritative gate; this hook
 * is defense-in-depth at the render layer (round-1 finding #9).
 *
 * OCP: Adding a new gate (e.g. "frozen profile", "trial expired") = one
 * additional boolean field derived here, consumed by one new condition in
 * the relevant hooks.
 */

import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { type BucketSummary, bucketsList } from "@/api/buckets";
import { objectsList } from "@/api/objects";
import type { ProfileSummary } from "@/api/profiles";
import { profilesList, profileValidate } from "@/api/profiles";
import { isAppError } from "@/lib/errors";
import { keys } from "@/query/keys";
import { useValidationStore } from "@/store/validation";

// ---------------------------------------------------------------------------
// Small wrapper around the profiles list query
// ---------------------------------------------------------------------------

/**
 * Thin hook so any component can access the profiles list without repeating
 * the query key and fetch function.
 */
export function useProfilesList(): {
  profiles: ProfileSummary[];
  isLoading: boolean;
} {
  const { data = [], isLoading } = useQuery({
    queryKey: keys.profiles(),
    queryFn: profilesList,
  });
  return { profiles: data, isLoading };
}

// ---------------------------------------------------------------------------
// useValidatedProfile
// ---------------------------------------------------------------------------

export type ProfileId = string;

interface UseValidatedProfileResult {
  isValidated: boolean;
  profile: ProfileSummary | null;
  isLoading: boolean;
}

/**
 * Look up a profile and return whether it has been validated this session.
 *
 * As a side-effect, fires a lazy `profile_validate` once per session for
 * any profile that has not yet been validated (and is not already being
 * validated). Subsequent renders see `validatedAt` populated and skip
 * the gate without the user ever clicking a "Validate" button.
 *
 * The validation status (idle / validating / ok / error) lives in
 * `useValidationStore` so the sidebar dot + any future "needs auth" UI
 * can render a unified state.
 *
 * Returns `isValidated = false` and `profile = null` when:
 * - `profileId` is null / undefined
 * - the profiles list is still loading
 * - the profile is not found in the list
 * - `profile.validatedAt` is null / undefined
 */
export function useValidatedProfile(
  profileId: ProfileId | null | undefined,
): UseValidatedProfileResult {
  const { profiles, isLoading } = useProfilesList();
  const queryClient = useQueryClient();
  const startValidating = useValidationStore((s) => s.startValidating);
  const markOk = useValidationStore((s) => s.markOk);
  const markError = useValidationStore((s) => s.markError);
  // Per-render ref: which profile ids THIS hook instance already kicked off.
  // Combined with the store-level status check this prevents duplicates
  // from a single mount and from cross-component races.
  const firedFor = useRef<Set<string>>(new Set());

  const profile = profileId
    ? (profiles.find((p) => p.id === profileId) ?? null)
    : null;
  const validatedAt = profile?.validatedAt ?? null;

  // Lazy auto-validate: when a real profile shows up that hasn't been
  // validated this session, fire validation in the background.
  useEffect(() => {
    if (!profileId || !profile) return;
    if (validatedAt != null) return;
    if (firedFor.current.has(profileId)) return;
    const status =
      useValidationStore.getState().statuses.get(profileId) ?? "idle";
    if (status === "validating" || status === "error") return;

    firedFor.current.add(profileId);
    startValidating(profileId);
    void profileValidate(profileId)
      .then(async (report) => {
        // Refresh the profiles list so `validatedAt` propagates. The
        // backend already set the session-scoped flag inside the report.
        await queryClient.invalidateQueries({ queryKey: keys.profiles() });
        if (report.ok) {
          markOk(profileId);
        } else if (report.error) {
          markError(profileId, report.error);
        } else {
          // Backend returned ok=false with no error — treat as a generic
          // failure so the UI surfaces something clickable.
          markError(profileId, {
            kind: "Internal",
            message: "Validation failed",
            retryable: false,
            details: { traceId: "validation_no_error" },
          });
        }
      })
      .catch((err: unknown) => {
        markError(
          profileId,
          isAppError(err)
            ? err
            : {
                kind: "Internal",
                message: err instanceof Error ? err.message : String(err),
                retryable: false,
                details: { traceId: "validation_throw" },
              },
        );
      });
  }, [
    profileId,
    validatedAt,
    profile,
    startValidating,
    markOk,
    markError,
    queryClient,
  ]);

  if (!profileId || isLoading) {
    return { isValidated: false, profile: null, isLoading };
  }

  const isValidated = validatedAt != null;
  return { isValidated, profile, isLoading: false };
}

// ---------------------------------------------------------------------------
// Gated data hooks
// ---------------------------------------------------------------------------

/**
 * Re-export BucketSummary from the buckets API so consumers can import it
 * from the same module as the hook.
 */
export type { BucketSummary };

/**
 * useBuckets — gated by useValidatedProfile.
 *
 * Returns `{ data: undefined, isLoading: false, isGated: true }` when the
 * profile has not been validated; callers render an "unvalidated" state.
 */
export function useBuckets(profileId: ProfileId | null | undefined): {
  data: BucketSummary[] | undefined;
  isLoading: boolean;
  isGated: boolean;
  error: Error | null;
} {
  const { isValidated, isLoading: profileLoading } =
    useValidatedProfile(profileId);

  const {
    data,
    isLoading: bucketsLoading,
    error,
  } = useQuery({
    queryKey: profileId
      ? keys.buckets(profileId)
      : (["buckets", null] as const),
    queryFn: (): Promise<BucketSummary[]> => bucketsList(profileId as string),
    enabled: Boolean(profileId) && isValidated,
  });

  if (!isValidated) {
    return {
      data: undefined,
      isLoading: profileLoading,
      isGated: true,
      error: null,
    };
  }

  return { data, isLoading: bucketsLoading, isGated: false, error };
}

/**
 * Re-export ObjectEntry from the objects API for backward-compat with any
 * consumer that imported from this module.
 */
export type { ObjectEntry } from "@/api/objects";

/**
 * useObjects — gated, paginated infinite listing.
 *
 * Wraps the cancellable, continuation-token paginated `objects_list`
 * command in `useInfiniteQuery`. The returned `data` is the flattened
 * array of every loaded page's entries; callers that subscribe via
 * `<Virtualized onEndReached>` get auto-pagination on scroll.
 *
 * Gating: returns `{ data: undefined, isLoading, isGated: true }` when
 * the profile has not been validated this session.
 *
 * Backwards-compatible signature: existing callers that only read
 * `data` / `isLoading` / `isGated` continue to work without changes.
 */
export function useObjects(
  profileId: ProfileId | null | undefined,
  bucket: string | null | undefined,
  prefix: string,
): {
  data: import("@/api/objects").ObjectEntry[] | undefined;
  isLoading: boolean;
  isGated: boolean;
  /** Server reports more pages available (regardless of whether they are loaded). */
  hasNextPage: boolean;
  /** A fetchNextPage() call is currently in flight. */
  isFetchingNextPage: boolean;
  /** Any fetch is in flight (refresh + first-page + next-page). */
  isFetching: boolean;
  /** Trigger the next page load. Safe to call when hasNextPage is false. */
  fetchNextPage: () => void;
  /** Total number of pages loaded so far (≥1 once initial fetch resolves). */
  loadedPages: number;
  /** Unix-ms when the most recent successful fetch resolved. */
  dataUpdatedAt: number;
} {
  const { isValidated, isLoading: profileLoading } =
    useValidatedProfile(profileId);

  const enabled = Boolean(profileId) && Boolean(bucket) && isValidated;

  const query = useInfiniteQuery({
    queryKey:
      profileId && bucket
        ? keys.objects(profileId, bucket, prefix)
        : (["objects", null] as const),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      objectsList(profileId as string, bucket as string, prefix, {
        continuationToken: pageParam,
      }),
    getNextPageParam: (last) => last.nextContinuationToken,
    enabled,
  });

  // Accept both shapes:
  // - InfiniteData<ListPage> with .pages   (normal useInfiniteQuery result)
  // - ListPage with .entries directly      (legacy writes from optimistic.ts
  //                                          before it learnt the infinite shape)
  // Defensive: when an optimistic mutation writes a flat ListPage into the
  // same query key, we still render its entries instead of falling through
  // to an empty list ("This prefix is empty").
  const data = useMemo(() => {
    const raw = query.data as unknown;
    if (!raw || typeof raw !== "object") return undefined;
    const maybeInfinite = raw as {
      pages?: Array<{ entries?: import("@/api/objects").ObjectEntry[] }>;
    };
    if (Array.isArray(maybeInfinite.pages)) {
      return maybeInfinite.pages.flatMap((p) => p.entries ?? []);
    }
    const maybeLegacy = raw as {
      entries?: import("@/api/objects").ObjectEntry[];
    };
    if (Array.isArray(maybeLegacy.entries)) {
      return maybeLegacy.entries;
    }
    return undefined;
  }, [query.data]);

  if (!isValidated) {
    return {
      data: undefined,
      isLoading: profileLoading,
      isGated: true,
      hasNextPage: false,
      isFetchingNextPage: false,
      isFetching: false,
      fetchNextPage: () => undefined,
      loadedPages: 0,
      dataUpdatedAt: 0,
    };
  }

  return {
    data,
    isLoading: query.isLoading,
    isGated: false,
    hasNextPage: query.hasNextPage ?? false,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetching: query.isFetching,
    fetchNextPage: () => {
      void query.fetchNextPage();
    },
    loadedPages: query.data?.pages?.length ?? 0,
    dataUpdatedAt: query.dataUpdatedAt,
  };
}
