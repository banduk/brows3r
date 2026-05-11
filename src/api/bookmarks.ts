/**
 * API module for bookmarks and recent locations commands.
 *
 * Each function wraps exactly one Rust command.  Types mirror the Rust serde
 * shapes (camelCase).
 *
 * OCP: adding a new bookmark field = one new optional key in `Bookmark` /
 * `BookmarkPatch`.  Existing callers are unaffected.
 */

import { invoke } from "@/lib/tauri";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A persisted sidebar bookmark.
 *
 * Mirrors `src-tauri/src/bookmarks.rs` Bookmark.
 */
export interface Bookmark {
  /** UUID v4. */
  id: string;
  /** Credential profile this bookmark belongs to. */
  profileId: string;
  /** S3 bucket name. */
  bucket: string;
  /** S3 prefix.  Empty string = bucket root. */
  prefix: string;
  /** Human-readable label.  Falls back to `prefix` in the UI when absent. */
  label?: string;
  /** Unix epoch milliseconds of creation time. */
  createdAt: number;
}

/** Mutable fields accepted by `bookmarkUpdate`. */
export interface BookmarkPatch {
  label?: string;
}

/**
 * A recent S3 location.
 *
 * Mirrors `src-tauri/src/bookmarks.rs` RecentLocation.
 */
export interface RecentLocation {
  profileId: string;
  bucket: string;
  prefix: string;
  /** Unix epoch milliseconds of last visit. */
  visitedAt: number;
}

// ---------------------------------------------------------------------------
// bookmarksList
// ---------------------------------------------------------------------------

/** Fetch all persisted bookmarks (newest-to-oldest by creation time). */
export function bookmarksList(): Promise<Bookmark[]> {
  return invoke<Bookmark[]>("bookmarks_list");
}

// ---------------------------------------------------------------------------
// bookmarkAdd
// ---------------------------------------------------------------------------

/** Add a new bookmark. Returns the created record. */
export function bookmarkAdd(
  profileId: string,
  bucket: string,
  prefix: string,
  label?: string,
): Promise<Bookmark> {
  return invoke<Bookmark>("bookmark_add", {
    profileId,
    bucket,
    prefix,
    label: label ?? null,
  });
}

// ---------------------------------------------------------------------------
// bookmarkRemove
// ---------------------------------------------------------------------------

/** Remove a bookmark by id. */
export function bookmarkRemove(id: string): Promise<void> {
  return invoke<void>("bookmark_remove", { id });
}

// ---------------------------------------------------------------------------
// bookmarkUpdate
// ---------------------------------------------------------------------------

/** Update mutable fields of a bookmark. Returns the updated record. */
export function bookmarkUpdate(
  id: string,
  patch: BookmarkPatch,
): Promise<Bookmark> {
  return invoke<Bookmark>("bookmark_update", { id, patch });
}

// ---------------------------------------------------------------------------
// recentsList
// ---------------------------------------------------------------------------

/** Fetch recent locations, newest first. */
export function recentsList(): Promise<RecentLocation[]> {
  return invoke<RecentLocation[]>("recents_list");
}

// ---------------------------------------------------------------------------
// recentTrack
// ---------------------------------------------------------------------------

/** Record a navigation. Called after every pane location change. */
export function recentTrack(
  profileId: string,
  bucket: string,
  prefix: string,
): Promise<void> {
  return invoke<void>("recent_track", { profileId, bucket, prefix });
}

// ---------------------------------------------------------------------------
// recentsClear
// ---------------------------------------------------------------------------

/** Clear all recent locations. */
export function recentsClear(): Promise<void> {
  return invoke<void>("recents_clear");
}
