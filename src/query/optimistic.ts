/**
 * Optimistic update helpers for predictable-post-state mutations.
 *
 * Per Decision D2, only mutations where the post-state is fully predictable
 * from the request get optimistic UI treatment:
 *   - create-folder
 *   - single-key delete
 *   - single-key rename (copy-to-new-key + delete-source)
 *
 * All other mutations wait for the authoritative `objects:updated` backend
 * event before reflecting state.
 *
 * Each helper:
 * 1. Cancels any in-flight queries for the affected prefix (prevents race).
 * 2. Snapshots the current cache state.
 * 3. Mutates the cache optimistically.
 * 4. Returns `{ rollback, optimisticState }` so the caller can rollback on
 *    error and pass `optimisticState` to the `onMutate` context if needed.
 *
 * On backend success the `objects:updated` Tauri event fires, which triggers
 * `queryClient.invalidateQueries` — Rust state wins on reconciliation.
 *
 * OCP: adding a new optimistic mutation = one new helper function here.
 *      Adding a new excluded mutation = one new constant in EXCLUDED_FROM_OPTIMISM.
 */

import type { QueryClient } from "@tanstack/react-query";
import type { ListPage, ObjectEntry } from "@/api/objects";
import { keys } from "./keys";

// ---------------------------------------------------------------------------
// EXCLUDED_FROM_OPTIMISM
//
// Mutations that are explicitly NOT safe for optimistic UI in v1.
// This list is the safety net: any future mutation must be consciously
// classified as either "safe for optimism" (add a helper) or "excluded" (add
// an entry here).
//
// The regression test in optimistic.test.ts asserts that no helper exists
// for these identifiers.
// ---------------------------------------------------------------------------

export const EXCLUDED_FROM_OPTIMISM = [
  "storage_class",
  "batch_delete_mixed",
  "cross_account",
  "metadata",
] as const;

export type ExcludedFromOptimism = (typeof EXCLUDED_FROM_OPTIMISM)[number];

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Derive the parent prefix of a full S3 key.
 *
 * `"photos/2024/img.jpg"` → `"photos/2024/"`
 * `"img.jpg"` → `""`
 * `"photos/"` → `""` (the folder itself lives at root)
 * `"photos/sub/"` → `"photos/"`
 */
export function parentPrefix(key: string): string {
  const stripped = key.endsWith("/") ? key.slice(0, -1) : key;
  const idx = stripped.lastIndexOf("/");
  if (idx === -1) return "";
  return stripped.slice(0, idx + 1);
}

// ---------------------------------------------------------------------------
// OptimisticResult
// ---------------------------------------------------------------------------

export interface OptimisticResult {
  /** Reverts the cache to the snapshot taken before the optimistic update. */
  rollback(): void;
  /** The optimistic state that was staged. */
  optimisticState: ObjectEntry[] | undefined;
}

// ---------------------------------------------------------------------------
// optimisticCreateFolder
// ---------------------------------------------------------------------------

/**
 * Push a virtual `is_prefix=true` entry into the cached listing for
 * `parent_prefix(prefix)` immediately, before the Rust command fires.
 *
 * @param queryClient  - TanStack Query client.
 * @param profileId    - Profile whose cache to update.
 * @param bucket       - Bucket name.
 * @param prefix       - The new folder's full key including trailing slash,
 *                       e.g. `"photos/2024/"`.
 */
export async function optimisticCreateFolder(
  queryClient: QueryClient,
  profileId: string,
  bucket: string,
  prefix: string,
): Promise<OptimisticResult> {
  const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  const parent = parentPrefix(normalizedPrefix);
  const queryKey = keys.objects(profileId, bucket, parent);

  await queryClient.cancelQueries({ queryKey });

  const snapshot = queryClient.getQueryData<ListPage>(queryKey);

  const newEntry: ObjectEntry = {
    key: normalizedPrefix,
    size: 0,
    isPrefix: true,
  };

  queryClient.setQueryData<ListPage>(queryKey, (old) => {
    if (!old) {
      return {
        entries: [newEntry],
        commonPrefixes: [normalizedPrefix],
        isTruncated: false,
        prefix: parent,
        delimiter: "/",
      };
    }
    // Avoid duplicate entries.
    const exists = old.entries.some((e) => e.key === normalizedPrefix);
    if (exists) return old;
    return {
      ...old,
      entries: [...old.entries, newEntry],
      commonPrefixes: [...old.commonPrefixes, normalizedPrefix],
    };
  });

  const optimisticState = queryClient.getQueryData<ListPage>(queryKey)?.entries;

  return {
    rollback() {
      queryClient.setQueryData<ListPage>(queryKey, snapshot);
    },
    optimisticState,
  };
}

// ---------------------------------------------------------------------------
// optimisticDeleteSingle
// ---------------------------------------------------------------------------

/**
 * Remove a single entry from the cached listing for its parent prefix.
 *
 * @param queryClient  - TanStack Query client.
 * @param profileId    - Profile whose cache to update.
 * @param bucket       - Bucket name.
 * @param key          - Full S3 key of the entry to remove.
 */
export async function optimisticDeleteSingle(
  queryClient: QueryClient,
  profileId: string,
  bucket: string,
  key: string,
): Promise<OptimisticResult> {
  const parent = parentPrefix(key);
  const queryKey = keys.objects(profileId, bucket, parent);

  await queryClient.cancelQueries({ queryKey });

  const snapshot = queryClient.getQueryData<ListPage>(queryKey);

  queryClient.setQueryData<ListPage>(queryKey, (old) => {
    if (!old) return old;
    return {
      ...old,
      entries: old.entries.filter((e) => e.key !== key),
      commonPrefixes: old.commonPrefixes.filter((p) => p !== key),
    };
  });

  const optimisticState = queryClient.getQueryData<ListPage>(queryKey)?.entries;

  return {
    rollback() {
      queryClient.setQueryData<ListPage>(queryKey, snapshot);
    },
    optimisticState,
  };
}

// ---------------------------------------------------------------------------
// optimisticRenameSingle
// ---------------------------------------------------------------------------

/**
 * Update a single entry's key in the cached listing.
 *
 * Rename is a copy-to-new-key + delete-source operation on S3. The optimistic
 * update swaps the key in place so the user sees the new name immediately.
 *
 * Only works when source and destination share the same parent prefix.
 * Cross-prefix renames (i.e. moves) are not covered here — use the transfer
 * queue path instead.
 *
 * @param queryClient  - TanStack Query client.
 * @param profileId    - Profile whose cache to update.
 * @param bucket       - Bucket name.
 * @param sourceKey    - Full S3 key of the entry to rename.
 * @param destKey      - New full S3 key (must share the same parent prefix).
 */
export async function optimisticRenameSingle(
  queryClient: QueryClient,
  profileId: string,
  bucket: string,
  sourceKey: string,
  destKey: string,
): Promise<OptimisticResult> {
  const parent = parentPrefix(sourceKey);
  const queryKey = keys.objects(profileId, bucket, parent);

  await queryClient.cancelQueries({ queryKey });

  const snapshot = queryClient.getQueryData<ListPage>(queryKey);

  queryClient.setQueryData<ListPage>(queryKey, (old) => {
    if (!old) return old;
    return {
      ...old,
      entries: old.entries.map((e) =>
        e.key === sourceKey ? { ...e, key: destKey } : e,
      ),
      commonPrefixes: old.commonPrefixes.map((p) =>
        p === sourceKey ? destKey : p,
      ),
    };
  });

  const optimisticState = queryClient.getQueryData<ListPage>(queryKey)?.entries;

  return {
    rollback() {
      queryClient.setQueryData<ListPage>(queryKey, snapshot);
    },
    optimisticState,
  };
}

// ---------------------------------------------------------------------------
// OPTIMISTIC_HELPERS_MAP
//
// Used by the regression test to assert that excluded mutations do NOT have
// entries here. Keys are human-readable mutation identifiers — NOT command ids.
// ---------------------------------------------------------------------------

export const OPTIMISTIC_HELPERS_MAP = {
  create_folder: optimisticCreateFolder,
  delete_single: optimisticDeleteSingle,
  rename_single: optimisticRenameSingle,
} as const;

export type OptimisticHelperName = keyof typeof OPTIMISTIC_HELPERS_MAP;
