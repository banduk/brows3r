//! Bookmarks and recent locations for the sidebar.
//!
//! # Bookmarks
//!
//! `BookmarkStore` persists to `${app_config_dir}/bookmarks.json`.  Writes are
//! atomic (write-to-tmp, rename) so a crash cannot corrupt the file.
//!
//! # Recents
//!
//! `RecentsStore` is an in-memory ring buffer (cap 50) that de-duplicates
//! consecutive identical locations.  The snapshot is written to
//! `${app_config_dir}/recents.json` on explicit flush (called from commands).
//!
//! # OCP
//!
//! - `Bookmark` and `RecentLocation` are open for new optional fields (tags,
//!   color, …) via serde `skip_serializing_if`.
//! - The validation gate is not in this module — it lives in the command layer
//!   (`bookmarks_cmd.rs`) so the store stays transport-agnostic.

use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::{
    error::AppError,
    ids::{BucketId, ProfileId},
};

// ---------------------------------------------------------------------------
// Bookmark
// ---------------------------------------------------------------------------

/// A persisted sidebar bookmark.
///
/// `label` is optional so callers can store bookmarks without naming them;
/// the UI falls back to the `prefix` as the display string.
///
/// Additional fields (tags, color, …) may be added as `Option` fields
/// without a breaking schema change.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    /// UUID v4 minted at creation time.
    pub id: String,
    /// The AWS credential profile this bookmark belongs to.
    pub profile_id: ProfileId,
    /// The S3 bucket.
    pub bucket: BucketId,
    /// The S3 prefix (empty string = bucket root).
    pub prefix: String,
    /// Human-readable label.  `None` means use `prefix` as the display name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Unix epoch in milliseconds at the time the bookmark was created.
    pub created_at: i64,
}

/// Patch accepted by `BookmarkStore::update`.
///
/// All fields are optional — passing `None` for a field leaves it unchanged.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkPatch {
    pub label: Option<String>,
}

/// Input for `BookmarkStore::add`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkInput {
    pub profile_id: ProfileId,
    pub bucket: BucketId,
    pub prefix: String,
    pub label: Option<String>,
}

// ---------------------------------------------------------------------------
// BookmarkStore
// ---------------------------------------------------------------------------

/// Persisted list of bookmarks.
///
/// All mutations call `save_to` synchronously (blocking I/O) because they
/// happen inside a `RwLock` write guard already held by the command.  The
/// bookmarks file is small (KBs at most), so blocking is acceptable.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkStore {
    bookmarks: Vec<Bookmark>,
}

impl BookmarkStore {
    /// Load from `path`.  Returns an empty store if the file does not exist.
    pub fn load(path: &Path) -> Result<Self, AppError> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let raw = std::fs::read_to_string(path).map_err(|e| AppError::Internal {
            trace_id: format!("bookmarks_load_read: {e}"),
        })?;
        serde_json::from_str(&raw).map_err(|e| AppError::Internal {
            trace_id: format!("bookmarks_load_parse: {e}"),
        })
    }

    /// Persist to `path` atomically.
    fn save_to(&self, path: &Path) -> Result<(), AppError> {
        let json = serde_json::to_string_pretty(self).map_err(|e| AppError::Internal {
            trace_id: format!("bookmarks_save_serialize: {e}"),
        })?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| AppError::Internal {
                trace_id: format!("bookmarks_save_mkdir: {e}"),
            })?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json.as_bytes()).map_err(|e| AppError::Internal {
            trace_id: format!("bookmarks_save_write: {e}"),
        })?;
        std::fs::rename(&tmp, path).map_err(|e| AppError::Internal {
            trace_id: format!("bookmarks_save_rename: {e}"),
        })?;
        Ok(())
    }

    /// Return all bookmarks in insertion order.
    pub fn list(&self) -> Vec<Bookmark> {
        self.bookmarks.clone()
    }

    /// Add a new bookmark and persist.  Returns the created `Bookmark`.
    pub fn add(&mut self, input: BookmarkInput, path: &Path) -> Result<Bookmark, AppError> {
        let bookmark = Bookmark {
            id: Uuid::new_v4().to_string(),
            profile_id: input.profile_id,
            bucket: input.bucket,
            prefix: input.prefix,
            label: input.label,
            created_at: unix_ms_now(),
        };
        self.bookmarks.push(bookmark.clone());
        self.save_to(path)?;
        Ok(bookmark)
    }

    /// Remove a bookmark by id.  Returns `true` if found and removed.
    pub fn remove(&mut self, id: &str, path: &Path) -> Result<bool, AppError> {
        let before = self.bookmarks.len();
        self.bookmarks.retain(|b| b.id != id);
        let removed = self.bookmarks.len() < before;
        if removed {
            self.save_to(path)?;
        }
        Ok(removed)
    }

    /// Update a bookmark's mutable fields.  Returns the updated `Bookmark` or
    /// `NotFound` when no bookmark with `id` exists.
    pub fn update(
        &mut self,
        id: &str,
        patch: BookmarkPatch,
        path: &Path,
    ) -> Result<Bookmark, AppError> {
        let bm = self
            .bookmarks
            .iter_mut()
            .find(|b| b.id == id)
            .ok_or_else(|| AppError::NotFound {
                resource: format!("bookmark:{id}"),
            })?;

        if let Some(label) = patch.label {
            bm.label = Some(label);
        }

        let result = bm.clone();
        self.save_to(path)?;
        Ok(result)
    }
}

/// Shared handle for `BookmarkStore`.
pub type BookmarkStoreHandle = Arc<RwLock<BookmarkStoreState>>;

/// Wrapper that bundles the store with its backing file path.
pub struct BookmarkStoreState {
    pub store: BookmarkStore,
    pub path: PathBuf,
}

impl BookmarkStoreState {
    pub fn new(store: BookmarkStore, path: PathBuf) -> Self {
        Self { store, path }
    }
}

// ---------------------------------------------------------------------------
// RecentLocation
// ---------------------------------------------------------------------------

/// One visited S3 location recorded for the recents list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentLocation {
    pub profile_id: ProfileId,
    pub bucket: BucketId,
    pub prefix: String,
    /// Unix epoch milliseconds of the visit.
    pub visited_at: i64,
}

// ---------------------------------------------------------------------------
// RecentsStore
// ---------------------------------------------------------------------------

/// Ring buffer (cap 50) of recent locations.
///
/// De-duplicates consecutive identical `(profile_id, bucket, prefix)` triples
/// so rapid re-navigation to the same folder does not pollute the list.
///
/// Persisted as `${app_config_dir}/recents.json`.
pub struct RecentsStore {
    buffer: VecDeque<RecentLocation>,
    /// Maximum number of entries.  Kept as a field so tests can override.
    cap: usize,
    pub path: PathBuf,
}

impl RecentsStore {
    const DEFAULT_CAP: usize = 50;

    pub fn new(path: PathBuf) -> Self {
        Self {
            buffer: VecDeque::new(),
            cap: Self::DEFAULT_CAP,
            path,
        }
    }

    /// Load from `path`.  Returns an empty store if the file does not exist.
    pub fn load(path: PathBuf) -> Self {
        let buffer = if path.exists() {
            std::fs::read_to_string(&path)
                .ok()
                .and_then(|raw| serde_json::from_str::<Vec<RecentLocation>>(&raw).ok())
                .map(|v| v.into_iter().collect::<VecDeque<_>>())
                .unwrap_or_default()
        } else {
            VecDeque::new()
        };
        // Clamp to cap in case the file was written by a future version with a
        // larger cap.
        let mut store = Self {
            buffer,
            cap: Self::DEFAULT_CAP,
            path,
        };
        store.clamp();
        store
    }

    fn clamp(&mut self) {
        while self.buffer.len() > self.cap {
            self.buffer.pop_back();
        }
    }

    /// Record a navigation.  De-duplicates consecutive identical locations
    /// (same profile, bucket, prefix).  Evicts the oldest entry when at cap.
    pub fn track(&mut self, profile_id: ProfileId, bucket: BucketId, prefix: String) {
        // De-duplicate: if the front is identical, just bump its timestamp.
        if let Some(front) = self.buffer.front_mut() {
            if front.profile_id == profile_id && front.bucket == bucket && front.prefix == prefix {
                front.visited_at = unix_ms_now();
                return;
            }
        }

        // Also remove any older entry for the same location so it surfaces at
        // the top without creating a duplicate.
        self.buffer
            .retain(|r| !(r.profile_id == profile_id && r.bucket == bucket && r.prefix == prefix));

        if self.buffer.len() >= self.cap {
            self.buffer.pop_back();
        }
        self.buffer.push_front(RecentLocation {
            profile_id,
            bucket,
            prefix,
            visited_at: unix_ms_now(),
        });
    }

    /// Return all recent locations (newest first).
    pub fn list(&self) -> Vec<RecentLocation> {
        self.buffer.iter().cloned().collect()
    }

    /// Clear all entries.
    pub fn clear(&mut self) {
        self.buffer.clear();
    }

    /// Flush to disk (best-effort; errors are non-fatal).
    pub fn flush(&self) {
        let entries: Vec<&RecentLocation> = self.buffer.iter().collect();
        if let Ok(json) = serde_json::to_string_pretty(&entries) {
            if let Some(parent) = self.path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let tmp = self.path.with_extension("json.tmp");
            if std::fs::write(&tmp, json.as_bytes()).is_ok() {
                let _ = std::fs::rename(&tmp, &self.path);
            }
        }
    }
}

/// Shared handle for `RecentsStore`.
pub type RecentsHandle = Arc<RwLock<RecentsStore>>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn unix_ms_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn pid(s: &str) -> ProfileId {
        ProfileId::new(s)
    }
    fn bid(s: &str) -> BucketId {
        BucketId::new(s)
    }

    // -----------------------------------------------------------------------
    // BookmarkStore
    // -----------------------------------------------------------------------

    #[test]
    fn bookmark_add_and_list() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("bookmarks.json");
        let mut store = BookmarkStore::load(&path).unwrap();

        let bm = store
            .add(
                BookmarkInput {
                    profile_id: pid("p1"),
                    bucket: bid("bucket-a"),
                    prefix: "folder/".to_string(),
                    label: Some("My folder".to_string()),
                },
                &path,
            )
            .unwrap();

        assert!(!bm.id.is_empty());
        assert_eq!(bm.profile_id.as_str(), "p1");
        assert_eq!(bm.bucket.as_str(), "bucket-a");
        assert_eq!(bm.prefix, "folder/");
        assert_eq!(bm.label.as_deref(), Some("My folder"));

        let list = store.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, bm.id);
    }

    #[test]
    fn bookmark_remove_returns_true_on_success() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("bookmarks.json");
        let mut store = BookmarkStore::load(&path).unwrap();

        let bm = store
            .add(
                BookmarkInput {
                    profile_id: pid("p1"),
                    bucket: bid("b"),
                    prefix: "".to_string(),
                    label: None,
                },
                &path,
            )
            .unwrap();

        let removed = store.remove(&bm.id, &path).unwrap();
        assert!(removed);
        assert!(store.list().is_empty());
    }

    #[test]
    fn bookmark_remove_missing_id_returns_false() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("bookmarks.json");
        let mut store = BookmarkStore::load(&path).unwrap();
        let removed = store.remove("no-such-id", &path).unwrap();
        assert!(!removed);
    }

    #[test]
    fn bookmark_update_label() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("bookmarks.json");
        let mut store = BookmarkStore::load(&path).unwrap();

        let bm = store
            .add(
                BookmarkInput {
                    profile_id: pid("p1"),
                    bucket: bid("b"),
                    prefix: "".to_string(),
                    label: Some("old".to_string()),
                },
                &path,
            )
            .unwrap();

        let updated = store
            .update(
                &bm.id,
                BookmarkPatch {
                    label: Some("new label".to_string()),
                },
                &path,
            )
            .unwrap();

        assert_eq!(updated.label.as_deref(), Some("new label"));
        // Verify list reflects the change.
        let list = store.list();
        assert_eq!(list[0].label.as_deref(), Some("new label"));
    }

    #[test]
    fn bookmark_update_missing_returns_not_found() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("bookmarks.json");
        let mut store = BookmarkStore::load(&path).unwrap();
        let err = store
            .update("bad-id", BookmarkPatch::default(), &path)
            .unwrap_err();
        assert!(matches!(err, AppError::NotFound { .. }));
    }

    #[test]
    fn bookmark_persistence_round_trip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("bookmarks.json");
        {
            let mut store = BookmarkStore::load(&path).unwrap();
            store
                .add(
                    BookmarkInput {
                        profile_id: pid("p1"),
                        bucket: bid("b"),
                        prefix: "x/".to_string(),
                        label: Some("X".to_string()),
                    },
                    &path,
                )
                .unwrap();
        }
        // Re-load from disk.
        let store2 = BookmarkStore::load(&path).unwrap();
        let list = store2.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].prefix, "x/");
        assert_eq!(list[0].label.as_deref(), Some("X"));
    }

    // -----------------------------------------------------------------------
    // RecentsStore
    // -----------------------------------------------------------------------

    #[test]
    fn recents_track_and_list() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("recents.json");
        let mut store = RecentsStore::new(path);

        store.track(pid("p1"), bid("b"), "a/".to_string());
        store.track(pid("p1"), bid("b"), "b/".to_string());

        let list = store.list();
        assert_eq!(list.len(), 2);
        // Newest first.
        assert_eq!(list[0].prefix, "b/");
        assert_eq!(list[1].prefix, "a/");
    }

    #[test]
    fn recents_dedup_consecutive_identical() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("recents.json");
        let mut store = RecentsStore::new(path);

        store.track(pid("p1"), bid("b"), "x/".to_string());
        store.track(pid("p1"), bid("b"), "x/".to_string());
        store.track(pid("p1"), bid("b"), "x/".to_string());

        let list = store.list();
        assert_eq!(list.len(), 1, "consecutive identical locations must dedup");
    }

    #[test]
    fn recents_ring_buffer_eviction_at_cap() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("recents.json");
        let mut store = RecentsStore {
            buffer: VecDeque::new(),
            cap: 3,
            path,
        };

        for i in 0..5_u32 {
            store.track(pid("p"), bid("b"), format!("{i}/"));
        }

        let list = store.list();
        assert_eq!(list.len(), 3, "must not exceed cap");
        // The newest three (4/, 3/, 2/) should be retained.
        assert_eq!(list[0].prefix, "4/");
        assert_eq!(list[1].prefix, "3/");
        assert_eq!(list[2].prefix, "2/");
    }

    #[test]
    fn recents_clear_empties_list() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("recents.json");
        let mut store = RecentsStore::new(path);
        store.track(pid("p"), bid("b"), "x/".to_string());
        store.clear();
        assert!(store.list().is_empty());
    }

    #[test]
    fn recents_persistence_round_trip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("recents.json");
        {
            let mut store = RecentsStore::new(path.clone());
            store.track(pid("p1"), bid("b"), "persisted/".to_string());
            store.flush();
        }
        let store2 = RecentsStore::load(path);
        let list = store2.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].prefix, "persisted/");
    }
}
