/**
 * Canonical query-key factory.
 *
 * All TanStack Query keys in the application are minted here and nowhere else.
 * Adding a new data domain = adding one function. Refactoring a key shape =
 * one edit here; all consumers update automatically.
 *
 * Each function returns a `readonly` tuple with stable structure so
 * `queryClient.invalidateQueries({ queryKey: keys.buckets(id) })` matches
 * all sub-keys of that prefix when Tauri events fire.
 */

export const keys = {
  /** All profiles — used for list invalidation. */
  profiles(): readonly ["profiles"] {
    return ["profiles"] as const;
  },

  /** Single profile by id. */
  profile(id: string): readonly ["profiles", string] {
    return ["profiles", id] as const;
  },

  /** Bucket list for a profile. */
  buckets(profileId: string): readonly ["buckets", string] {
    return ["buckets", profileId] as const;
  },

  /**
   * Object listing at a prefix (hierarchical, delimiter-based).
   * `prefix` should end with `/` for directory-like scopes.
   */
  objects(
    profileId: string,
    bucket: string,
    prefix: string,
  ): readonly ["objects", string, string, string] {
    return ["objects", profileId, bucket, prefix] as const;
  },

  /**
   * Flat (no-delimiter) object listing for the same scope.
   * Used by FlatKeyView and search — separate key so it doesn't collide with
   * hierarchical listings.
   */
  objectsFlat(
    profileId: string,
    bucket: string,
    prefix: string,
  ): readonly ["objects", string, string, string, "flat"] {
    return ["objects", profileId, bucket, prefix, "flat"] as const;
  },

  /**
   * Single object HEAD metadata.
   *
   * `versionId` defaults to `null` so the key is stable across calls where
   * versioning is irrelevant.
   */
  objectHead(
    profileId: string,
    bucket: string,
    key: string,
    versionId?: string,
  ): readonly ["object", string, string, string, string | null] {
    return ["object", profileId, bucket, key, versionId ?? null] as const;
  },

  /**
   * Inspector panel data.
   *
   * `key` is optional — when absent the inspector shows bucket-level info.
   */
  inspector(
    profileId: string,
    bucket: string,
    key?: string,
  ): readonly ["inspector", string, string, string | null] {
    return ["inspector", profileId, bucket, key ?? null] as const;
  },

  /** Transfer manager list. */
  transfers(): readonly ["transfers"] {
    return ["transfers"] as const;
  },

  /** In-app notification log. */
  notifications(): readonly ["notifications"] {
    return ["notifications"] as const;
  },

  /** Application settings. */
  settings(): readonly ["settings"] {
    return ["settings"] as const;
  },

  /** Media server URLs (invalidated on `media:revoked`). */
  media(): readonly ["media"] {
    return ["media"] as const;
  },

  /** Sidebar bookmarks list. */
  bookmarks(): readonly ["bookmarks"] {
    return ["bookmarks"] as const;
  },

  /** Recent locations list. */
  recents(): readonly ["recents"] {
    return ["recents"] as const;
  },
} as const;
