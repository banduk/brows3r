//! Search module: types, cancellation, and the in-process search registry.
//!
//! # Sub-modules
//!
//! - `cancel` — `CancellationToken` (atomic flag wrapper).
//!
//! # Types exposed at module level
//!
//! - `EntryRef`       — thin DTO for a single search result row.
//! - `SearchPage`     — one streamed page of search results.
//! - `SearchRegistry` — tracks in-flight searches by `request_id`.
//! - `SearchRegistryHandle` — `Arc<RwLock<SearchRegistry>>` for Tauri state.
//!
//! # OCP
//!
//! - `EntryRef` is a thin DTO — extending with metadata fields is non-breaking.
//! - `SearchRegistry` operates on `request_id` strings; the registry is
//!   independent of search mode, so future modes (history search, tag search)
//!   register tokens the same way.

pub mod cancel;

use std::{collections::HashMap, sync::Arc};

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::search::cancel::CancellationToken;

// ---------------------------------------------------------------------------
// EntryRef — thin search result DTO
// ---------------------------------------------------------------------------

/// A single search result entry.
///
/// Intentionally thinner than `ObjectEntry` — only the fields needed to render
/// a search result row are included.  Extending with `etag` or `storage_class`
/// is additive and non-breaking.
///
/// OCP: new metadata fields can be added here without changing the command or
/// the event schema — serde skips unknown fields on the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryRef {
    /// Full S3 key (or common-prefix string for virtual folders).
    pub key: String,
    /// Object size in bytes. Always `0` for prefix entries.
    pub size: u64,
    /// Last-modified Unix timestamp in milliseconds. `None` for prefix entries.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<i64>,
    /// `true` when this entry represents a virtual-folder prefix.
    pub is_prefix: bool,
}

// ---------------------------------------------------------------------------
// SearchPage — one streamed page of results
// ---------------------------------------------------------------------------

/// One page of search results emitted as a `search:page` event.
///
/// The frontend accumulates pages in order until `is_final = true`.
/// On cancellation the backend emits a final empty page with `is_final = true`
/// so the frontend knows the stream is closed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    /// Echoed from the originating `search_prefix` call so the frontend can
    /// match pages to the correct in-flight search even when multiple searches
    /// overlap (e.g. the user typed fast).
    pub request_id: String,
    /// Zero-based page counter.
    pub page_index: u32,
    /// Matching entries for this page.
    pub results: Vec<EntryRef>,
    /// `true` on the very last page (either end-of-listing or cancelled).
    pub is_final: bool,
}

// ---------------------------------------------------------------------------
// SearchRegistry
// ---------------------------------------------------------------------------

/// In-memory registry of in-flight prefix searches.
///
/// Each search is identified by a `request_id` string.  Registering a search
/// creates a `CancellationToken`; cancelling it sets the token's flag.  The
/// background task polls `is_cancelled()` between pages and emits a final
/// empty page before exiting.
///
/// OCP: the registry is mode-agnostic — future long-running commands can
/// reuse the same pattern by holding their own token kind.
#[derive(Default)]
pub struct SearchRegistry {
    tokens: HashMap<String, CancellationToken>,
}

impl SearchRegistry {
    /// Register a new search and return a `CancellationToken` to pass to the
    /// background task.
    ///
    /// If a search with the same `request_id` already exists, it is
    /// overwritten (the old token is dropped, freeing any lingering Arc).
    pub fn register(&mut self, request_id: impl Into<String>) -> CancellationToken {
        let token = CancellationToken::new();
        self.tokens.insert(request_id.into(), token.clone());
        token
    }

    /// Cancel the search identified by `request_id`.
    ///
    /// Returns `true` when the token was found and cancelled; `false` when
    /// no matching search exists (already completed or never started).
    pub fn cancel(&mut self, request_id: &str) -> bool {
        if let Some(token) = self.tokens.get(request_id) {
            token.cancel();
            true
        } else {
            false
        }
    }

    /// Returns `true` when the search has been cancelled (or never started).
    pub fn is_cancelled(&self, request_id: &str) -> bool {
        self.tokens
            .get(request_id)
            .map_or(true, |t| t.is_cancelled())
    }

    /// Remove a completed (or cancelled) search from the registry.
    ///
    /// Call this after the background task emits its final page to free the
    /// token from the HashMap.  Idempotent — safe to call on missing ids.
    pub fn remove(&mut self, request_id: &str) {
        self.tokens.remove(request_id);
    }
}

// ---------------------------------------------------------------------------
// SearchRegistryHandle — Tauri managed state
// ---------------------------------------------------------------------------

/// `Arc<RwLock<SearchRegistry>>` used as Tauri managed state.
///
/// Commands receive `tauri::State<SearchRegistryHandle>`.
#[derive(Clone, Default)]
pub struct SearchRegistryHandle {
    pub inner: Arc<RwLock<SearchRegistry>>,
}

impl SearchRegistryHandle {
    pub fn new() -> Self {
        Self::default()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // SearchRegistry
    // -----------------------------------------------------------------------

    #[test]
    fn register_returns_uncancelled_token() {
        let mut reg = SearchRegistry::default();
        let token = reg.register("req-1");
        assert!(!token.is_cancelled());
    }

    #[test]
    fn cancel_known_request_returns_true() {
        let mut reg = SearchRegistry::default();
        reg.register("req-1");
        assert!(reg.cancel("req-1"));
    }

    #[test]
    fn cancel_unknown_request_returns_false() {
        let mut reg = SearchRegistry::default();
        assert!(!reg.cancel("does-not-exist"));
    }

    #[test]
    fn cancel_makes_token_see_cancellation() {
        let mut reg = SearchRegistry::default();
        let token = reg.register("req-1");
        reg.cancel("req-1");
        assert!(
            token.is_cancelled(),
            "background task token must see cancellation"
        );
    }

    #[test]
    fn is_cancelled_true_after_cancel() {
        let mut reg = SearchRegistry::default();
        reg.register("req-1");
        reg.cancel("req-1");
        assert!(reg.is_cancelled("req-1"));
    }

    #[test]
    fn is_cancelled_false_before_cancel() {
        let mut reg = SearchRegistry::default();
        reg.register("req-1");
        assert!(!reg.is_cancelled("req-1"));
    }

    #[test]
    fn is_cancelled_true_for_unknown_id() {
        let reg = SearchRegistry::default();
        // An unknown id is treated as "already cancelled / never started".
        assert!(reg.is_cancelled("ghost"));
    }

    #[test]
    fn remove_cleans_up_entry() {
        let mut reg = SearchRegistry::default();
        reg.register("req-1");
        reg.remove("req-1");
        // After removal, is_cancelled should return true (treated as unknown).
        assert!(reg.is_cancelled("req-1"));
    }

    #[test]
    fn overwrite_existing_request_id() {
        let mut reg = SearchRegistry::default();
        let _old = reg.register("req-1");
        // Registering the same id again must succeed and return a fresh token.
        let new_token = reg.register("req-1");
        assert!(!new_token.is_cancelled());
    }

    // -----------------------------------------------------------------------
    // SearchPage serialisation
    // -----------------------------------------------------------------------

    #[test]
    fn search_page_serialises_correctly() {
        let page = SearchPage {
            request_id: "r-1".to_string(),
            page_index: 0,
            results: vec![EntryRef {
                key: "folder/file.txt".to_string(),
                size: 1024,
                last_modified: Some(1_700_000_000_000),
                is_prefix: false,
            }],
            is_final: false,
        };
        let v = serde_json::to_value(&page).unwrap();
        assert_eq!(v["requestId"], "r-1");
        assert_eq!(v["pageIndex"], 0);
        assert_eq!(v["isFinal"], false);
        assert_eq!(v["results"][0]["key"], "folder/file.txt");
        assert_eq!(v["results"][0]["size"], 1024);
        assert_eq!(v["results"][0]["isPrefix"], false);
    }

    #[test]
    fn entry_ref_omits_none_last_modified() {
        let entry = EntryRef {
            key: "prefix/".to_string(),
            size: 0,
            last_modified: None,
            is_prefix: true,
        };
        let v = serde_json::to_value(&entry).unwrap();
        assert!(v.get("lastModified").is_none(), "None must be omitted");
    }
}
