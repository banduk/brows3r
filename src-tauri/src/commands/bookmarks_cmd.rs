//! Tauri commands for bookmarks and recent locations.
//!
//! # Commands
//!
//! - [`bookmarks_list`]    — list all bookmarks for the caller.
//! - [`bookmark_add`]      — add a new bookmark; returns the created record.
//! - [`bookmark_remove`]   — remove a bookmark by id.
//! - [`bookmark_update`]   — rename a bookmark.
//! - [`recents_list`]      — list recent locations (newest first).
//! - [`recent_track`]      — record a navigation (called after every pane move).
//! - [`recents_clear`]     — clear all recent locations.
//!
//! # Validation gate
//!
//! `bookmarks_list` and `recents_list` return the full unfiltered list.  The
//! **frontend** validation gate (per round-1 finding #9) is applied in the
//! `<Bookmarks>` and `<Recents>` React components via `useValidatedProfile`.
//! This keeps the data layer transport-agnostic and lets the UI render a
//! disabled state for unvalidated profiles without an extra round-trip.
//!
//! # OCP
//!
//! Adding a new bookmark field = one new arm in `BookmarkPatch` + one line in
//! `bookmark_update`.  No existing commands change.

use tauri::State;

use crate::{
    bookmarks::{BookmarkInput, BookmarkPatch, BookmarkStoreHandle, RecentsHandle},
    error::AppError,
    ids::{BucketId, ProfileId},
};

// ---------------------------------------------------------------------------
// bookmarks_list
// ---------------------------------------------------------------------------

/// Return all persisted bookmarks in insertion order.
#[tauri::command]
pub async fn bookmarks_list(
    store: State<'_, BookmarkStoreHandle>,
) -> Result<Vec<crate::bookmarks::Bookmark>, AppError> {
    let guard = store.read().await;
    Ok(guard.store.list())
}

// ---------------------------------------------------------------------------
// bookmark_add
// ---------------------------------------------------------------------------

/// Add a new bookmark.  Returns the created record.
#[tauri::command]
pub async fn bookmark_add(
    profile_id: ProfileId,
    bucket: BucketId,
    prefix: String,
    label: Option<String>,
    store: State<'_, BookmarkStoreHandle>,
) -> Result<crate::bookmarks::Bookmark, AppError> {
    let mut guard = store.write().await;
    let path = guard.path.clone();
    guard.store.add(
        BookmarkInput {
            profile_id,
            bucket,
            prefix,
            label,
        },
        &path,
    )
}

// ---------------------------------------------------------------------------
// bookmark_remove
// ---------------------------------------------------------------------------

/// Remove a bookmark by `id`.
///
/// Returns `Ok(())` even when the id is not found — this matches the pattern
/// established by `search_cancel` and avoids frontend races.
#[tauri::command]
pub async fn bookmark_remove(
    id: String,
    store: State<'_, BookmarkStoreHandle>,
) -> Result<(), AppError> {
    let mut guard = store.write().await;
    let path = guard.path.clone();
    guard.store.remove(&id, &path)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// bookmark_update
// ---------------------------------------------------------------------------

/// Update mutable fields of a bookmark.
///
/// Returns `NotFound` when `id` does not match any stored bookmark.
#[tauri::command]
pub async fn bookmark_update(
    id: String,
    patch: BookmarkPatch,
    store: State<'_, BookmarkStoreHandle>,
) -> Result<crate::bookmarks::Bookmark, AppError> {
    let mut guard = store.write().await;
    let path = guard.path.clone();
    guard.store.update(&id, patch, &path)
}

// ---------------------------------------------------------------------------
// recents_list
// ---------------------------------------------------------------------------

/// Return recent locations, newest first.
#[tauri::command]
pub async fn recents_list(
    handle: State<'_, RecentsHandle>,
) -> Result<Vec<crate::bookmarks::RecentLocation>, AppError> {
    let guard = handle.read().await;
    Ok(guard.list())
}

// ---------------------------------------------------------------------------
// recent_track
// ---------------------------------------------------------------------------

/// Record a navigation.  Called after every pane location change.
///
/// Always returns `Ok(())` — tracking failures must never surface to the user.
#[tauri::command]
pub async fn recent_track(
    profile_id: ProfileId,
    bucket: BucketId,
    prefix: String,
    handle: State<'_, RecentsHandle>,
) -> Result<(), AppError> {
    let mut guard = handle.write().await;
    guard.track(profile_id, bucket, prefix);
    Ok(())
}

// ---------------------------------------------------------------------------
// recents_clear
// ---------------------------------------------------------------------------

/// Clear all recent locations and flush the empty list to disk.
#[tauri::command]
pub async fn recents_clear(handle: State<'_, RecentsHandle>) -> Result<(), AppError> {
    let mut guard = handle.write().await;
    guard.clear();
    guard.flush();
    Ok(())
}
