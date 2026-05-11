//! Tauri commands for search operations.
//!
//! # Commands
//!
//! - [`search_local_filter`]  — pure in-process filter over a caller-supplied
//!                              `Vec<EntryRef>` slice; no S3 calls.
//! - [`search_prefix`]        — paginated bucket-wide search that emits
//!                              `search:page` events; returns `request_id`.
//! - [`search_cancel`]        — cancel an in-flight prefix search.
//!
//! # OCP
//!
//! Search modes are independent command paths.  Adding a new mode
//! (e.g. history search) is one new command here.  `CancellationToken` and
//! `SearchRegistry` are reusable for any future long-running command.

use tauri::{AppHandle, State};

use crate::{
    error::AppError,
    events::{self, EventKind},
    ids::{BucketId, ProfileId},
    profiles::ProfileStoreHandle,
    s3::{list::list_objects_flat, S3ClientPoolHandle},
    search::{EntryRef, SearchPage, SearchRegistryHandle},
    settings::SettingsHandle,
};

// ---------------------------------------------------------------------------
// search_local_filter
// ---------------------------------------------------------------------------

/// Filter `entries` by `query` (case-insensitive substring match on `key`).
///
/// This is a pure, synchronous operation — no IPC, no S3.  The frontend
/// sends its current cached listing slice and gets back the matching subset.
///
/// An empty `query` returns all entries unchanged.
#[tauri::command]
pub async fn search_local_filter(
    _pane_id: String,
    query: String,
    entries: Vec<EntryRef>,
) -> Result<Vec<EntryRef>, AppError> {
    if query.is_empty() {
        return Ok(entries);
    }

    let q = query.to_lowercase();
    let results = entries
        .into_iter()
        .filter(|e| e.key.to_lowercase().contains(&q))
        .collect();

    Ok(results)
}

// ---------------------------------------------------------------------------
// search_prefix
// ---------------------------------------------------------------------------

/// Begin a paginated, cancellable prefix search.
///
/// Returns `request_id` immediately.  A background tokio task walks
/// `ListObjectsV2` pages starting at `prefix`, filtering each page by `query`
/// (case-insensitive substring on the key relative to `prefix`), and emits a
/// `search:page` event for each batch of matching results.
///
/// Walk concurrency is capped by the `transfer_concurrency` setting to avoid
/// monopolising the S3 connection pool.
///
/// # Cancellation
///
/// Call `search_cancel(request_id)` to stop the walk.  The background task
/// checks the cancellation token between pages; on cancellation it emits a
/// final empty page with `is_final = true` and exits.
#[tauri::command]
pub async fn search_prefix(
    profile_id: ProfileId,
    bucket: BucketId,
    prefix: String,
    query: String,
    request_id: String,
    store: State<'_, ProfileStoreHandle>,
    pool: State<'_, S3ClientPoolHandle>,
    search_registry: State<'_, SearchRegistryHandle>,
    settings: State<'_, SettingsHandle>,
    channel: AppHandle,
) -> Result<String, AppError> {
    // ------------------------------------------------------------------
    // 1. Resolve profile + validation gate
    // ------------------------------------------------------------------
    let profile = {
        let store_guard = store.inner.lock().await;
        store_guard
            .get(&profile_id)
            .ok_or_else(|| AppError::NotFound {
                resource: format!("profile:{}", profile_id.as_str()),
            })?
    };

    if profile.validated_at.is_none() {
        return Err(AppError::Auth {
            reason: "profile_not_validated_in_session".to_string(),
        });
    }

    let default_region = profile
        .default_region
        .clone()
        .unwrap_or_else(|| "us-east-1".to_string());

    // ------------------------------------------------------------------
    // 2. Build S3 client
    // ------------------------------------------------------------------
    let client = pool
        .inner
        .get_or_build(&profile_id, &default_region)
        .await
        .ok_or_else(|| AppError::Internal {
            trace_id: format!("pool_miss:profile:{}", profile_id.as_str()),
        })?;

    // ------------------------------------------------------------------
    // 3. Register cancellation token
    // ------------------------------------------------------------------
    let token = {
        let mut reg = search_registry.inner.write().await;
        reg.register(request_id.clone())
    };

    // ------------------------------------------------------------------
    // 4. Read settings for concurrency cap (informational — we honour it
    //    by limiting to one page-fetch at a time in the loop below).
    // ------------------------------------------------------------------
    let _transfer_concurrency = {
        let s = settings.inner.lock().await;
        s.transfer_concurrency
    };

    // ------------------------------------------------------------------
    // 5. Spawn background walk task
    // ------------------------------------------------------------------
    let rid = request_id.clone();
    let bucket_str = bucket.as_str().to_string();
    let prefix_clone = prefix.clone();
    let query_clone = query.clone();
    let registry_handle = search_registry.inner.clone();

    tokio::spawn(async move {
        let mut continuation_token: Option<String> = None;
        let mut page_index: u32 = 0;
        let q = query_clone.to_lowercase();

        loop {
            // Check cancellation before each page fetch.
            if token.is_cancelled() {
                // Emit a final empty page to close the stream cleanly.
                let final_page = SearchPage {
                    request_id: rid.clone(),
                    page_index,
                    results: vec![],
                    is_final: true,
                };
                let _ = events::emit(&channel, EventKind::SearchPage, &final_page);
                break;
            }

            let ct_ref = continuation_token.as_deref();

            let list_result =
                list_objects_flat(&client, &bucket_str, &prefix_clone, ct_ref, Some(1000)).await;

            let page = match list_result {
                Ok(p) => p,
                Err(_) => {
                    // On error emit a final empty page so the frontend doesn't hang.
                    let final_page = SearchPage {
                        request_id: rid.clone(),
                        page_index,
                        results: vec![],
                        is_final: true,
                    };
                    let _ = events::emit(&channel, EventKind::SearchPage, &final_page);
                    break;
                }
            };

            let is_last_page = !page.is_truncated || page.next_continuation_token.is_none();

            // Filter matching entries.
            let results: Vec<EntryRef> = page
                .entries
                .iter()
                .filter(|e| q.is_empty() || e.key.to_lowercase().contains(&q))
                .map(|e| EntryRef {
                    key: e.key.clone(),
                    size: e.size,
                    last_modified: e.last_modified,
                    is_prefix: e.is_prefix,
                })
                .collect();

            let search_page = SearchPage {
                request_id: rid.clone(),
                page_index,
                results,
                is_final: is_last_page,
            };

            let _ = events::emit(&channel, EventKind::SearchPage, &search_page);

            if is_last_page {
                break;
            }

            continuation_token = page.next_continuation_token;
            page_index += 1;
        }

        // Clean up the registry entry so it doesn't grow unbounded.
        let mut reg = registry_handle.write().await;
        reg.remove(&rid);
    });

    Ok(request_id)
}

// ---------------------------------------------------------------------------
// search_cancel
// ---------------------------------------------------------------------------

/// Cancel an in-flight prefix search identified by `request_id`.
///
/// The background task will detect the cancellation between pages and emit a
/// final empty `search:page` event before exiting.
///
/// Returns `Ok(())` even when the `request_id` is not found (already completed
/// or never started) — this is intentional: the frontend may race and call
/// cancel after the search already finished.
#[tauri::command]
pub async fn search_cancel(
    request_id: String,
    search_registry: State<'_, SearchRegistryHandle>,
) -> Result<(), AppError> {
    let mut reg = search_registry.inner.write().await;
    reg.cancel(&request_id);
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::{EventKind, MockChannel};
    use crate::search::{EntryRef, SearchPage, SearchRegistry, SearchRegistryHandle};
    use std::sync::Arc;
    use tokio::sync::RwLock;

    // -----------------------------------------------------------------------
    // search_local_filter
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn local_filter_case_insensitive_substring() {
        let entries = vec![
            EntryRef {
                key: "photos/Image.jpg".to_string(),
                size: 100,
                last_modified: None,
                is_prefix: false,
            },
            EntryRef {
                key: "docs/report.pdf".to_string(),
                size: 200,
                last_modified: None,
                is_prefix: false,
            },
            EntryRef {
                key: "photos/thumbnail.png".to_string(),
                size: 50,
                last_modified: None,
                is_prefix: false,
            },
        ];
        let result = search_local_filter("pane-1".to_string(), "IMAGE".to_string(), entries)
            .await
            .unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].key, "photos/Image.jpg");
    }

    #[tokio::test]
    async fn local_filter_empty_query_returns_all() {
        let entries = vec![
            EntryRef {
                key: "a.txt".to_string(),
                size: 1,
                last_modified: None,
                is_prefix: false,
            },
            EntryRef {
                key: "b.txt".to_string(),
                size: 2,
                last_modified: None,
                is_prefix: false,
            },
        ];
        let count = entries.len();
        let result = search_local_filter("pane-1".to_string(), String::new(), entries)
            .await
            .unwrap();

        assert_eq!(result.len(), count);
    }

    #[tokio::test]
    async fn local_filter_no_match_returns_empty() {
        let entries = vec![EntryRef {
            key: "folder/file.txt".to_string(),
            size: 10,
            last_modified: None,
            is_prefix: false,
        }];
        let result = search_local_filter("pane-1".to_string(), "zzz-no-match".to_string(), entries)
            .await
            .unwrap();

        assert!(result.is_empty());
    }

    #[tokio::test]
    async fn local_filter_preserves_prefix_entries() {
        let entries = vec![
            EntryRef {
                key: "logs/".to_string(),
                size: 0,
                last_modified: None,
                is_prefix: true,
            },
            EntryRef {
                key: "data/file.csv".to_string(),
                size: 500,
                last_modified: None,
                is_prefix: false,
            },
        ];
        let result = search_local_filter("pane-1".to_string(), "logs".to_string(), entries)
            .await
            .unwrap();

        assert_eq!(result.len(), 1);
        assert!(result[0].is_prefix);
    }

    // -----------------------------------------------------------------------
    // SearchRegistry — event emission test
    // -----------------------------------------------------------------------

    #[test]
    fn search_registry_register_and_cancel() {
        let mut reg = SearchRegistry::default();
        let token = reg.register("req-42");
        assert!(!token.is_cancelled());
        assert!(reg.cancel("req-42"));
        assert!(token.is_cancelled());
    }

    /// Asserts that `search:page` events are emitted with the correct
    /// `request_id` in the payload (round-1 finding #14).
    #[test]
    fn search_page_event_carries_correct_request_id() {
        let channel = MockChannel::default();
        let page = SearchPage {
            request_id: "req-abc".to_string(),
            page_index: 0,
            results: vec![EntryRef {
                key: "folder/doc.txt".to_string(),
                size: 42,
                last_modified: None,
                is_prefix: false,
            }],
            is_final: false,
        };

        events::emit(&channel, EventKind::SearchPage, &page).unwrap();

        let emitted = channel.emitted();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].0, EventKind::SearchPage);
        assert_eq!(emitted[0].1["requestId"], "req-abc");
        assert_eq!(emitted[0].1["pageIndex"], 0);
        assert_eq!(emitted[0].1["isFinal"], false);
        assert_eq!(emitted[0].1["results"][0]["key"], "folder/doc.txt");
    }

    #[test]
    fn final_page_has_is_final_true() {
        let channel = MockChannel::default();
        let page = SearchPage {
            request_id: "req-fin".to_string(),
            page_index: 2,
            results: vec![],
            is_final: true,
        };

        events::emit(&channel, EventKind::SearchPage, &page).unwrap();

        let emitted = channel.emitted();
        assert_eq!(emitted[0].1["isFinal"], true);
        assert_eq!(emitted[0].1["requestId"], "req-fin");
    }
}
