//! Transfer registry and domain types for file downloads and uploads.
//!
//! # Architecture
//!
//! - [`Transfer`]              — per-transfer state record.
//! - [`TransferKind`]          — discriminates Download vs Upload.
//! - [`TransferState`]         — lifecycle state machine (Queued → Running → terminal).
//! - [`TransferRegistry`]      — in-memory registry with cancellation tokens.
//! - [`TransferRegistryHandle`]— `Arc<RwLock<TransferRegistry>>` for Tauri state.
//! - [`TransferSpec`]          — discriminated union describing what to enqueue.
//! - [`TransferFilter`]        — filter enum for `transfer_list`.
//! - [`TransferQueue`]         — concurrency-capped scheduling layer over `TransferRegistry`.
//! - [`TransferQueueHandle`]   — `Arc<TransferQueue>` for Tauri state.
//!
//! # OCP contract
//!
//! - `Transfer` gains `checksum`, `priority`, `retries` as optional fields later
//!   with no breaking change to existing call sites.
//! - `TransferRegistry` is decoupled from transfer logic — upload (task 32) reuses
//!   the same registry without modification.
//! - `TransferState` uses 5 variants as per design.md events line 397.
//! - `TransferSpec` is an open enum — new kinds (`Move`, `Copy`) are additive.
//! - `TransferFilter` is extensible without breaking existing call sites.
//! - The concurrency cap is a single `Arc<Semaphore>` — rebuilding on settings
//!   changes is one `rebuild_semaphore` call.

pub mod download;
pub mod notify;
pub mod progress;
pub mod upload;

use std::{collections::HashMap, path::PathBuf, sync::Arc};

use serde::{Deserialize, Serialize};
use tokio::sync::{oneshot, RwLock, Semaphore};
use uuid::Uuid;

use crate::{
    error::AppError,
    ids::{BucketId, ProfileId},
};

// ---------------------------------------------------------------------------
// TransferKind
// ---------------------------------------------------------------------------

/// Discriminates between download and upload transfers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferKind {
    Download,
    Upload,
}

// ---------------------------------------------------------------------------
// TransferState
// ---------------------------------------------------------------------------

/// Lifecycle state of a transfer.
///
/// Serialized as snake_case to match design.md events line 397:
/// `queued | running | done | failed | canceled`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferState {
    Queued,
    Running,
    Done,
    Failed,
    Canceled,
}

// ---------------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------------

/// Full state record for one download or upload transfer.
///
/// OCP: adding `checksum`, `priority`, or `retries` is a non-breaking additive
/// change — existing call sites are unaffected.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    /// UUID v4 request identifier returned to the frontend.
    pub id: String,
    pub kind: TransferKind,
    pub profile_id: ProfileId,
    pub bucket: BucketId,
    /// S3 object key.
    pub key: String,
    /// Source local path for uploads; `None` for downloads.
    pub source_path: Option<PathBuf>,
    /// Destination local path for downloads; `None` for uploads.
    pub dest_path: Option<PathBuf>,
    /// Total bytes, if known before the transfer starts.
    pub total_bytes: Option<u64>,
    /// Bytes transferred so far.
    pub transferred_bytes: u64,
    /// Multipart parts completed so far.
    pub parts_done: u32,
    /// Total multipart parts, if applicable.
    pub parts_total: u32,
    pub state: TransferState,
    /// Unix timestamp (milliseconds) when the transfer was registered.
    pub started_at: i64,
    /// Unix timestamp (milliseconds) when the transfer reached a terminal state.
    pub finished_at: Option<i64>,
    /// Error details when `state` is `Failed`. AppError serializes one-way
    /// (backend → frontend) via its custom `Serialize` impl; we skip on
    /// deserialize so the Transfer struct can still be deserialized when it
    /// crosses IPC the other direction (e.g. test fixtures).
    #[serde(skip_deserializing, default)]
    pub error: Option<AppError>,
}

// ---------------------------------------------------------------------------
// CancelToken — oneshot-based cancellation
// ---------------------------------------------------------------------------

/// Sender side of a cancellation signal for one transfer.
///
/// Held by `TransferRegistry`; the download/upload task holds the receiver.
pub struct CancelToken(pub oneshot::Sender<()>);

// ---------------------------------------------------------------------------
// TransferRegistry
// ---------------------------------------------------------------------------

/// In-memory registry of active and recently-completed transfers.
///
/// Thread-safe via `Arc<RwLock<TransferRegistry>>`.  Commands register a
/// transfer, spawn the work, and the work task calls back via `update`.
pub struct TransferRegistry {
    transfers: HashMap<String, Transfer>,
    cancel_tokens: HashMap<String, CancelToken>,
}

impl TransferRegistry {
    pub fn new() -> Self {
        Self {
            transfers: HashMap::new(),
            cancel_tokens: HashMap::new(),
        }
    }

    /// Register a new transfer and return its `id` (UUID v4).
    ///
    /// Returns `(id, cancel_receiver)` — the caller spawns the task with
    /// the receiver so it can detect a cancel signal.
    pub fn register(&mut self, transfer: Transfer) -> (String, oneshot::Receiver<()>) {
        let id = transfer.id.clone();
        let (tx, rx) = oneshot::channel::<()>();
        self.transfers.insert(id.clone(), transfer);
        self.cancel_tokens.insert(id.clone(), CancelToken(tx));
        (id, rx)
    }

    /// Apply a mutator closure to the transfer with `id`.
    ///
    /// Returns `AppError::NotFound` when the id is unknown.
    pub fn update<F>(&mut self, id: &str, mutator: F) -> Result<(), AppError>
    where
        F: FnOnce(&mut Transfer),
    {
        match self.transfers.get_mut(id) {
            Some(t) => {
                mutator(t);
                Ok(())
            }
            None => Err(AppError::NotFound {
                resource: format!("transfer:{id}"),
            }),
        }
    }

    /// Send the cancellation signal to the transfer with `id`.
    ///
    /// The cancel token is consumed on first call; subsequent calls on the
    /// same id return `Ok(())` (idempotent).
    pub fn cancel(&mut self, id: &str) -> Result<(), AppError> {
        match self.cancel_tokens.remove(id) {
            Some(token) => {
                // Receiver may already be dropped (completed transfer).
                let _ = token.0.send(());
                Ok(())
            }
            None => {
                // Token already consumed (cancel already sent) or id unknown.
                if self.transfers.contains_key(id) {
                    Ok(()) // idempotent
                } else {
                    Err(AppError::NotFound {
                        resource: format!("transfer:{id}"),
                    })
                }
            }
        }
    }

    /// Return transfers, optionally filtered by `profile_id`.
    ///
    /// `None` → all transfers.
    pub fn list(&self, profile_filter: Option<&ProfileId>) -> Vec<Transfer> {
        self.transfers
            .values()
            .filter(|t| profile_filter.map(|pf| &t.profile_id == pf).unwrap_or(true))
            .cloned()
            .collect()
    }

    /// Retrieve a single transfer by id.
    pub fn get(&self, id: &str) -> Option<&Transfer> {
        self.transfers.get(id)
    }
}

impl Default for TransferRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// TransferRegistryHandle — Arc<RwLock<...>> for Tauri state
// ---------------------------------------------------------------------------

/// Tauri managed state handle for the transfer registry.
///
/// Wraps `Arc<RwLock<TransferRegistry>>` so commands can `.write().await` to
/// register/update/cancel, or `.read().await` to list/get.
#[derive(Clone)]
pub struct TransferRegistryHandle(pub Arc<RwLock<TransferRegistry>>);

impl TransferRegistryHandle {
    pub fn new(registry: TransferRegistry) -> Self {
        Self(Arc::new(RwLock::new(registry)))
    }

    /// Borrow the inner `RwLock<TransferRegistry>` for read/write access.
    pub fn inner(&self) -> &RwLock<TransferRegistry> {
        &self.0
    }
}

impl Default for TransferRegistryHandle {
    fn default() -> Self {
        Self::new(TransferRegistry::new())
    }
}

// ---------------------------------------------------------------------------
// TransferSpec — open enum describing a transfer to enqueue
// ---------------------------------------------------------------------------

/// Discriminated union describing a transfer that can be enqueued into
/// [`TransferQueue`].
///
/// OCP: new kinds (`Move`, `Copy`) are added as additional variants here
/// without touching existing call sites that match on `Upload`/`Download`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TransferSpec {
    Upload {
        profile: ProfileId,
        bucket: BucketId,
        key: String,
        source_path: PathBuf,
    },
    Download {
        profile: ProfileId,
        bucket: BucketId,
        key: String,
        dest_path: PathBuf,
    },
}

// ---------------------------------------------------------------------------
// TransferFilter — extensible filter for transfer_list
// ---------------------------------------------------------------------------

/// Filter applied by `transfer_list` to narrow the returned set.
///
/// OCP: new filter variants (e.g. `ByBucket(BucketId)`) are additive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferFilter {
    /// Running or Queued transfers.
    Active,
    /// Transfers in terminal state Done.
    Completed,
    /// Transfers in terminal state Failed.
    Failed,
    /// All transfers regardless of state.
    All,
}

impl TransferFilter {
    fn matches(&self, t: &Transfer) -> bool {
        match self {
            Self::Active => t.state == TransferState::Queued || t.state == TransferState::Running,
            Self::Completed => t.state == TransferState::Done,
            Self::Failed => t.state == TransferState::Failed,
            Self::All => true,
        }
    }
}

// ---------------------------------------------------------------------------
// TransferQueue — concurrency-capped scheduling layer
// ---------------------------------------------------------------------------

/// Concurrency-capped transfer queue wrapping [`TransferRegistry`].
///
/// The [`Semaphore`] limits how many transfers run simultaneously.  The
/// semaphore is acquired **inside** the spawned task, so `enqueue` always
/// returns immediately with a `request_id`.
///
/// When `transfer_concurrency` changes in settings, call `rebuild_semaphore`
/// to replace the semaphore with a new one at the new width.
pub struct TransferQueue {
    registry: Arc<RwLock<TransferRegistry>>,
    semaphore: std::sync::RwLock<Arc<Semaphore>>,
}

impl TransferQueue {
    /// Create a new queue with the given concurrency cap.
    pub fn new(concurrency: u32) -> Self {
        let cap = (concurrency as usize).max(1);
        Self {
            registry: Arc::new(RwLock::new(TransferRegistry::new())),
            semaphore: std::sync::RwLock::new(Arc::new(Semaphore::new(cap))),
        }
    }

    /// Shared reference to the inner `RwLock<TransferRegistry>`.
    pub fn registry(&self) -> &RwLock<TransferRegistry> {
        &self.registry
    }

    /// Replace the semaphore with a new one at `new_concurrency`.
    ///
    /// In-flight transfers hold their old permits until they finish; the new
    /// semaphore only affects newly spawned transfers.
    pub fn rebuild_semaphore(&self, new_concurrency: u32) {
        let cap = (new_concurrency as usize).max(1);
        let mut guard = self.semaphore.write().expect("semaphore lock poisoned");
        *guard = Arc::new(Semaphore::new(cap));
    }

    /// Acquire a clone of the current semaphore.
    ///
    /// The returned `Arc<Semaphore>` is the one that was active at the moment
    /// of the call.  Spawned tasks hold this arc; a `rebuild_semaphore` call
    /// does not invalidate existing permit holders.
    pub fn current_semaphore(&self) -> Arc<Semaphore> {
        Arc::clone(&*self.semaphore.read().expect("semaphore lock poisoned"))
    }

    /// Return a [`TransferRegistryHandle`] that shares the same underlying
    /// registry, suitable for passing to `download_object` / `upload_object`.
    pub fn registry_handle(&self) -> TransferRegistryHandle {
        TransferRegistryHandle(Arc::clone(&self.registry))
    }

    /// List transfers, optionally filtering by state.
    ///
    /// `filter` = `None` is equivalent to `TransferFilter::All`.
    pub async fn list(&self, filter: Option<TransferFilter>) -> Vec<Transfer> {
        let reg = self.registry.read().await;
        let f = filter.unwrap_or(TransferFilter::All);
        reg.transfers
            .values()
            .filter(|t| f.matches(t))
            .cloned()
            .collect()
    }

    /// Cancel the transfer with `id`.
    pub async fn cancel(&self, id: &str) -> Result<(), AppError> {
        let mut reg = self.registry.write().await;
        reg.cancel(id)
    }
}

impl Default for TransferQueue {
    fn default() -> Self {
        Self::new(4)
    }
}

// ---------------------------------------------------------------------------
// TransferQueueHandle — Arc<TransferQueue> for Tauri state
// ---------------------------------------------------------------------------

/// Tauri managed-state handle for the transfer queue.
///
/// Cloning is cheap — all clones share the same underlying `TransferQueue`.
#[derive(Clone)]
pub struct TransferQueueHandle(pub Arc<TransferQueue>);

impl TransferQueueHandle {
    pub fn new(queue: TransferQueue) -> Self {
        Self(Arc::new(queue))
    }
}

impl Default for TransferQueueHandle {
    fn default() -> Self {
        Self::new(TransferQueue::default())
    }
}

// ---------------------------------------------------------------------------
// Helper: mint a new Transfer id
// ---------------------------------------------------------------------------

pub fn new_transfer_id() -> String {
    Uuid::new_v4().to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> ProfileId {
        ProfileId::new("p1")
    }

    fn bucket() -> BucketId {
        BucketId::new("my-bucket")
    }

    fn now_ms() -> i64 {
        1_700_000_000_000
    }

    fn make_transfer(id: &str) -> Transfer {
        Transfer {
            id: id.to_owned(),
            kind: TransferKind::Download,
            profile_id: profile(),
            bucket: bucket(),
            key: "test/file.bin".to_string(),
            source_path: None,
            dest_path: Some(PathBuf::from("/tmp/file.bin")),
            total_bytes: Some(1_048_576),
            transferred_bytes: 0,
            parts_done: 0,
            parts_total: 0,
            state: TransferState::Queued,
            started_at: now_ms(),
            finished_at: None,
            error: None,
        }
    }

    // -----------------------------------------------------------------------
    // Register
    // -----------------------------------------------------------------------

    #[test]
    fn register_returns_id_and_cancel_receiver() {
        let mut registry = TransferRegistry::new();
        let t = make_transfer("xfer-001");
        let (id, _rx) = registry.register(t);
        assert_eq!(id, "xfer-001");
        assert!(registry.get("xfer-001").is_some());
    }

    #[test]
    fn register_multiple_transfers() {
        let mut registry = TransferRegistry::new();
        registry.register(make_transfer("t1"));
        registry.register(make_transfer("t2"));
        assert_eq!(registry.list(None).len(), 2);
    }

    // -----------------------------------------------------------------------
    // Update
    // -----------------------------------------------------------------------

    #[test]
    fn update_mutates_transfer_state() {
        let mut registry = TransferRegistry::new();
        registry.register(make_transfer("t-upd"));

        registry
            .update("t-upd", |t| {
                t.transferred_bytes = 256_000;
                t.state = TransferState::Running;
            })
            .expect("update must succeed");

        let t = registry.get("t-upd").unwrap();
        assert_eq!(t.transferred_bytes, 256_000);
        assert_eq!(t.state, TransferState::Running);
    }

    #[test]
    fn update_unknown_id_returns_not_found() {
        let mut registry = TransferRegistry::new();
        let err = registry
            .update("nonexistent", |_| {})
            .expect_err("update on missing id must fail");
        match err {
            AppError::NotFound { resource } => {
                assert!(resource.contains("nonexistent"));
            }
            other => panic!("expected NotFound, got {:?}", other),
        }
    }

    // -----------------------------------------------------------------------
    // Cancel
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn cancel_sends_signal_to_receiver() {
        let mut registry = TransferRegistry::new();
        let (_, rx) = registry.register(make_transfer("t-cancel"));

        registry.cancel("t-cancel").expect("cancel must succeed");

        // The receiver should immediately resolve.
        let result = rx.await;
        assert!(result.is_ok(), "cancel receiver must fire");
    }

    #[test]
    fn cancel_twice_is_idempotent() {
        let mut registry = TransferRegistry::new();
        registry.register(make_transfer("t-idem"));

        registry
            .cancel("t-idem")
            .expect("first cancel must succeed");
        // Second cancel: token already consumed but transfer still exists.
        registry
            .cancel("t-idem")
            .expect("second cancel must be idempotent");
    }

    #[test]
    fn cancel_unknown_id_returns_not_found() {
        let mut registry = TransferRegistry::new();
        let err = registry
            .cancel("ghost-id")
            .expect_err("cancel on missing id must fail");
        match err {
            AppError::NotFound { .. } => {}
            other => panic!("expected NotFound, got {:?}", other),
        }
    }

    // -----------------------------------------------------------------------
    // List with profile filter
    // -----------------------------------------------------------------------

    #[test]
    fn list_filters_by_profile() {
        let mut registry = TransferRegistry::new();

        let mut t2 = make_transfer("t-other");
        t2.profile_id = ProfileId::new("other-profile");
        registry.register(make_transfer("t-p1"));
        registry.register(t2);

        let filtered = registry.list(Some(&profile()));
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].id, "t-p1");
    }

    #[test]
    fn list_none_filter_returns_all() {
        let mut registry = TransferRegistry::new();
        registry.register(make_transfer("a"));
        registry.register(make_transfer("b"));
        assert_eq!(registry.list(None).len(), 2);
    }

    // -----------------------------------------------------------------------
    // TransferState serialization
    // -----------------------------------------------------------------------

    #[test]
    fn transfer_state_serializes_as_snake_case() {
        let cases = [
            (TransferState::Queued, "queued"),
            (TransferState::Running, "running"),
            (TransferState::Done, "done"),
            (TransferState::Failed, "failed"),
            (TransferState::Canceled, "canceled"),
        ];
        for (state, expected) in &cases {
            let v = serde_json::to_value(state).expect("must serialize");
            assert_eq!(v.as_str().unwrap(), *expected, "state {:?}", state);
        }
    }

    // -----------------------------------------------------------------------
    // TransferKind serialization
    // -----------------------------------------------------------------------

    #[test]
    fn transfer_kind_serializes_as_snake_case() {
        assert_eq!(
            serde_json::to_value(TransferKind::Download)
                .unwrap()
                .as_str()
                .unwrap(),
            "download"
        );
        assert_eq!(
            serde_json::to_value(TransferKind::Upload)
                .unwrap()
                .as_str()
                .unwrap(),
            "upload"
        );
    }

    // -----------------------------------------------------------------------
    // TransferFilter
    // -----------------------------------------------------------------------

    #[test]
    fn filter_active_matches_queued_and_running() {
        let mut t_q = make_transfer("q");
        t_q.state = TransferState::Queued;
        let mut t_r = make_transfer("r");
        t_r.state = TransferState::Running;
        let mut t_d = make_transfer("d");
        t_d.state = TransferState::Done;

        assert!(TransferFilter::Active.matches(&t_q));
        assert!(TransferFilter::Active.matches(&t_r));
        assert!(!TransferFilter::Active.matches(&t_d));
    }

    #[test]
    fn filter_completed_matches_done_only() {
        let mut t_d = make_transfer("d");
        t_d.state = TransferState::Done;
        let mut t_f = make_transfer("f");
        t_f.state = TransferState::Failed;

        assert!(TransferFilter::Completed.matches(&t_d));
        assert!(!TransferFilter::Completed.matches(&t_f));
    }

    #[test]
    fn filter_failed_matches_failed_only() {
        let mut t_f = make_transfer("f");
        t_f.state = TransferState::Failed;
        let mut t_d = make_transfer("d");
        t_d.state = TransferState::Done;

        assert!(TransferFilter::Failed.matches(&t_f));
        assert!(!TransferFilter::Failed.matches(&t_d));
    }

    #[test]
    fn filter_all_matches_every_state() {
        for state in [
            TransferState::Queued,
            TransferState::Running,
            TransferState::Done,
            TransferState::Failed,
            TransferState::Canceled,
        ] {
            let mut t = make_transfer("any");
            t.state = state;
            assert!(TransferFilter::All.matches(&t));
        }
    }

    // -----------------------------------------------------------------------
    // TransferQueue — concurrency cap
    // -----------------------------------------------------------------------

    /// Assert that at most `cap` transfers can be Running at the same time.
    ///
    /// We enqueue 6 long-running tasks with cap=2.  Each task sleeps briefly
    /// then marks itself Done.  We verify that just before the first batch
    /// finishes, the running count does not exceed 2.
    #[tokio::test]
    async fn concurrency_cap_limits_running_transfers() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        const CAP: usize = 2;
        const TOTAL: usize = 6;

        let queue = Arc::new(TransferQueue::new(CAP as u32));
        let active_count = Arc::new(AtomicUsize::new(0));
        let peak_concurrent = Arc::new(AtomicUsize::new(0));
        let sem = queue.current_semaphore();

        let mut handles = Vec::new();

        for i in 0..TOTAL {
            let sem_clone = Arc::clone(&sem);
            let active_clone = Arc::clone(&active_count);
            let peak_clone = Arc::clone(&peak_concurrent);
            let id = format!("t{i}");

            // Register into the registry so we can track state.
            {
                let t = Transfer {
                    id: id.clone(),
                    kind: TransferKind::Download,
                    profile_id: profile(),
                    bucket: bucket(),
                    key: format!("key/{i}"),
                    source_path: None,
                    dest_path: Some(PathBuf::from(format!("/tmp/{id}"))),
                    total_bytes: None,
                    transferred_bytes: 0,
                    parts_done: 0,
                    parts_total: 0,
                    state: TransferState::Queued,
                    started_at: now_ms(),
                    finished_at: None,
                    error: None,
                };
                let mut reg = queue.registry.write().await;
                reg.register(t);
            }

            let handle = tokio::spawn(async move {
                // Semaphore acquisition is inside the task — simulates the queue.
                let _permit = sem_clone
                    .acquire()
                    .await
                    .expect("semaphore must not be closed");

                let prev = active_clone.fetch_add(1, Ordering::SeqCst);
                let current = prev + 1;
                // Atomically track peak concurrent.
                peak_clone.fetch_max(current, Ordering::SeqCst);

                // Simulate brief work.
                tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;

                active_clone.fetch_sub(1, Ordering::SeqCst);
            });

            handles.push(handle);
        }

        for h in handles {
            h.await.expect("task must not panic");
        }

        let peak = peak_concurrent.load(Ordering::SeqCst);
        assert!(
            peak <= CAP,
            "peak concurrent ({peak}) must not exceed cap ({CAP})"
        );
    }

    // -----------------------------------------------------------------------
    // TransferQueue::list with filter
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn queue_list_filter_active() {
        let queue = TransferQueue::new(4);
        let mut t_active = make_transfer("a");
        t_active.state = TransferState::Running;
        let mut t_done = make_transfer("b");
        t_done.state = TransferState::Done;

        {
            let mut reg = queue.registry.write().await;
            reg.register(t_active);
            reg.register(t_done);
        }

        let active = queue.list(Some(TransferFilter::Active)).await;
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, "a");
    }
}
