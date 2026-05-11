/**
 * API module for search commands.
 *
 * Each function wraps exactly one Rust command.  Types mirror the Rust serde
 * shapes (camelCase).
 *
 * Two search modes:
 * - Local filter: synchronous, cache-only, no S3 call.
 * - Prefix search: paginated, streaming results via `search:page` events.
 *
 * OCP: adding a new search mode = one new function here.  Existing callers
 * are unaffected.
 */

import { invoke } from "@/lib/tauri";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single search result entry.
 *
 * Mirrors `src-tauri/src/search/mod.rs` EntryRef.
 *
 * Intentionally thinner than `ObjectEntry` — only the fields needed to render
 * a result row.  Extending with `etag` or `storageClass` is additive.
 */
export interface EntryRef {
  /** Full S3 key (or common-prefix string for virtual folders). */
  key: string;
  /** Object size in bytes.  Always `0` for prefix entries. */
  size: number;
  /**
   * Last-modified Unix timestamp in milliseconds.
   * Absent for prefix entries.
   */
  lastModified?: number;
  /** `true` when this entry represents a virtual-folder prefix. */
  isPrefix: boolean;
}

/**
 * One page of search results emitted as a `search:page` event.
 *
 * Mirrors `src-tauri/src/search/mod.rs` SearchPage.
 *
 * The frontend accumulates pages until `isFinal = true`.
 */
export interface SearchPage {
  /** Echoed from the originating `searchPrefix` call. */
  requestId: string;
  /** Zero-based page counter. */
  pageIndex: number;
  /** Matching entries for this page. */
  results: EntryRef[];
  /** `true` on the last page (end of listing or cancelled). */
  isFinal: boolean;
}

// ---------------------------------------------------------------------------
// searchLocalFilter
// ---------------------------------------------------------------------------

/**
 * Filter `entries` by `query` (case-insensitive substring on `key`).
 *
 * Pure, synchronous on the Rust side — no S3 calls.
 * An empty `query` returns all entries unchanged.
 */
export async function searchLocalFilter(
  paneId: string,
  query: string,
  entries: EntryRef[],
): Promise<EntryRef[]> {
  return invoke<EntryRef[]>("search_local_filter", {
    paneId,
    query,
    entries,
  });
}

// ---------------------------------------------------------------------------
// searchPrefix
// ---------------------------------------------------------------------------

/**
 * Begin a paginated, cancellable prefix search.
 *
 * Returns `requestId` immediately.  Results stream in as `search:page`
 * events (see `TauriEventMap` in `@/lib/tauri`).  Call `searchCancel` to
 * stop the walk early.
 */
export async function searchPrefix(
  profileId: string,
  bucket: string,
  prefix: string,
  query: string,
  requestId: string,
): Promise<string> {
  return invoke<string>("search_prefix", {
    profileId,
    bucket,
    prefix,
    query,
    requestId,
  });
}

// ---------------------------------------------------------------------------
// searchCancel
// ---------------------------------------------------------------------------

/**
 * Cancel an in-flight prefix search identified by `requestId`.
 *
 * Safe to call after the search has already completed — the backend ignores
 * cancellation of unknown request ids.
 */
export async function searchCancel(requestId: string): Promise<void> {
  await invoke<void>("search_cancel", { requestId });
}
