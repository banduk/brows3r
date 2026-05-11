//! Diff preview / confirmation framework.
//!
//! # Overview
//!
//! High-impact property edits (storage class change in v1; future: lifecycle,
//! ACL, metadata bulk-edit) go through a two-phase flow:
//!
//! 1. **Create**: caller invokes `diff_preview_create` with a description of
//!    the proposed change → backend persists a [`DiffRecord`] in the
//!    [`DiffStore`] and returns a [`DiffId`].
//!
//! 2. **Confirm or Cancel**:
//!    - Confirm: the mutating command (e.g. `object_set_storage_class`) calls
//!      [`DiffStore::consume`] with the id.  Consume succeeds only once and
//!      only for records in the `Pending` state.
//!    - Cancel: `diff_preview_cancel` sets the status to `Cancelled`.
//!      Any subsequent `consume` call returns `None`.
//!
//! # OCP
//!
//! - [`DiffPayload`] is open for new kinds (metadata bulk-edit, ACL change).
//!   Adding a new kind is one new variant here + one new parsing branch in
//!   `diff_cmd.rs` + one new rendering branch in the frontend modal.
//! - [`DiffStore::consume`] is the single safety gate.  Every mutating
//!   command that uses the diff framework must call `consume` — it is the
//!   authoritative check for cancelled/expired/double-confirm rejection.

use std::{
    collections::HashMap,
    sync::{Arc, RwLock},
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{error::AppError, ids::BucketId};

// ---------------------------------------------------------------------------
// DiffId
// ---------------------------------------------------------------------------

/// Opaque diff identifier — a UUID v4 string.
///
/// Serialises as a transparent string so the IPC layer sees a bare UUID,
/// e.g. `"550e8400-e29b-41d4-a716-446655440000"`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DiffId(String);

impl DiffId {
    /// Create a fresh random `DiffId`.
    pub fn new_v4() -> Self {
        Self(Uuid::new_v4().to_string())
    }

    /// Borrow the inner string slice.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for DiffId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<String> for DiffId {
    fn from(s: String) -> Self {
        Self(s)
    }
}

impl From<&str> for DiffId {
    fn from(s: &str) -> Self {
        Self(s.to_owned())
    }
}

// ---------------------------------------------------------------------------
// ObjectRef (re-used in DiffPayload)
// ---------------------------------------------------------------------------

/// A reference to a single S3 object used in diff payloads.
///
/// Mirrors `commands::objects_cmd::ObjectRef` but lives here to avoid a
/// circular dependency between `diff` and `commands`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffObjectRef {
    pub bucket: BucketId,
    pub key: String,
}

// ---------------------------------------------------------------------------
// DiffPayload
// ---------------------------------------------------------------------------

/// Describes what change a diff is proposing.
///
/// OCP: new variants can be added for future high-impact edits (metadata
/// bulk-edit, ACL change, lifecycle configuration) without changing the
/// existing `StorageClass` variant or the store machinery.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[serde(rename_all_fields = "camelCase")]
pub enum DiffPayload {
    /// v1 trigger: change the storage class of one or more objects.
    StorageClass {
        /// The objects whose storage class will be changed.
        targets: Vec<DiffObjectRef>,
        /// Map of `key → current_storage_class` (from object listing / HEAD).
        current: HashMap<String, String>,
        /// The new storage class value (e.g. `"GLACIER"`, `"STANDARD_IA"`).
        new_class: String,
    },
}

// ---------------------------------------------------------------------------
// DiffStatus
// ---------------------------------------------------------------------------

/// Lifecycle status of a diff record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffStatus {
    /// Created and waiting for a confirm or cancel.
    Pending,
    /// The mutating command consumed the diff — change was applied.
    Confirmed,
    /// User explicitly cancelled from the diff preview modal.
    Cancelled,
    /// TTL elapsed without confirm or cancel.
    Expired,
}

// ---------------------------------------------------------------------------
// DiffRecord
// ---------------------------------------------------------------------------

/// A persisted diff entry in the [`DiffStore`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRecord {
    pub id: DiffId,
    pub payload: DiffPayload,
    /// Unix timestamp (seconds) when the record was created.
    pub created_at: i64,
    /// Unix timestamp (seconds) after which the record is considered expired.
    pub expires_at: i64,
    pub status: DiffStatus,
}

// ---------------------------------------------------------------------------
// DiffStore
// ---------------------------------------------------------------------------

/// Default TTL for diff records: 5 minutes.
pub const DEFAULT_DIFF_TTL_SECS: i64 = 300;

/// In-memory store for pending diff records.
///
/// Backed by a `RwLock<HashMap>` so reads (polling, rendering the modal) are
/// non-blocking.  Mutations take a write lock.
///
/// The store is intentionally not persisted to disk — if the app restarts,
/// pending diffs are lost and the user must start the flow again.
#[derive(Debug, Default)]
pub struct DiffStore {
    inner: RwLock<HashMap<DiffId, DiffRecord>>,
    ttl_secs: i64,
}

impl DiffStore {
    /// Create a new store with the default 5-minute TTL.
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(HashMap::new()),
            ttl_secs: DEFAULT_DIFF_TTL_SECS,
        }
    }

    /// Create a store with a custom TTL (useful in tests with a mock clock).
    pub fn with_ttl(ttl_secs: i64) -> Self {
        Self {
            inner: RwLock::new(HashMap::new()),
            ttl_secs,
        }
    }

    // -----------------------------------------------------------------------
    // Internal timestamp helper — injectable for tests
    // -----------------------------------------------------------------------

    /// Return current Unix time in seconds.
    ///
    /// Using `SystemTime` directly.  Test overrides pass explicit timestamps
    /// through the `create_at` parameter variant.
    fn now_secs() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /// Create a new diff record and return its [`DiffId`].
    ///
    /// The record starts in [`DiffStatus::Pending`].
    pub fn create(&self, payload: DiffPayload) -> DiffId {
        self.create_at(payload, Self::now_secs())
    }

    /// Create a diff record at an explicit timestamp (test helper).
    pub fn create_at(&self, payload: DiffPayload, now: i64) -> DiffId {
        let id = DiffId::new_v4();
        let record = DiffRecord {
            id: id.clone(),
            payload,
            created_at: now,
            expires_at: now + self.ttl_secs,
            status: DiffStatus::Pending,
        };
        let mut map = self.inner.write().expect("diff store write lock poisoned");
        map.insert(id.clone(), record);
        id
    }

    /// Set the status of a diff record to [`DiffStatus::Cancelled`].
    ///
    /// A cancelled record's `consume` will subsequently return `None` (the
    /// `Validation` error path in `object_set_storage_class`).
    ///
    /// Returns `AppError::NotFound` when the id does not exist.
    pub fn cancel(&self, id: &DiffId) -> Result<(), AppError> {
        let mut map = self.inner.write().expect("diff store write lock poisoned");
        match map.get_mut(id) {
            Some(record) => {
                record.status = DiffStatus::Cancelled;
                Ok(())
            }
            None => Err(AppError::NotFound {
                resource: format!("diff:{}", id.as_str()),
            }),
        }
    }

    /// Consume a diff record on confirmation.
    ///
    /// Returns `Some(payload)` exactly once for a record in `Pending` state
    /// that has not yet expired.  Sets the status to `Confirmed`.
    ///
    /// Returns `None` when:
    /// - The record does not exist.
    /// - The record was cancelled.
    /// - The record is expired (checked against wall clock).
    /// - The record was already consumed (double-confirm rejection).
    pub fn consume(&self, id: &DiffId) -> Option<DiffPayload> {
        self.consume_at(id, Self::now_secs())
    }

    /// Consume at an explicit timestamp (test helper).
    pub fn consume_at(&self, id: &DiffId, now: i64) -> Option<DiffPayload> {
        let mut map = self.inner.write().expect("diff store write lock poisoned");
        let record = map.get_mut(id)?;

        // Expire on demand.
        if record.status == DiffStatus::Pending && now >= record.expires_at {
            record.status = DiffStatus::Expired;
        }

        if record.status != DiffStatus::Pending {
            return None;
        }

        record.status = DiffStatus::Confirmed;
        Some(record.payload.clone())
    }

    /// Read a diff record without consuming it.
    ///
    /// Returns `None` when the id does not exist.  Does not expire the record.
    pub fn get(&self, id: &DiffId) -> Option<DiffRecord> {
        let map = self.inner.read().expect("diff store read lock poisoned");
        map.get(id).cloned()
    }

    /// Sweep expired records from the store.
    ///
    /// Called periodically by a background task (or on demand in tests).
    /// Records whose `expires_at` has elapsed are removed rather than merely
    /// flagged so the map does not grow unbounded.
    pub fn gc(&self) {
        self.gc_at(Self::now_secs())
    }

    /// GC at an explicit timestamp (test helper).
    pub fn gc_at(&self, now: i64) {
        let mut map = self.inner.write().expect("diff store write lock poisoned");
        map.retain(|_, record| {
            // Keep Confirmed and Cancelled records for a grace period so the
            // frontend can still read them (e.g. to show "already confirmed").
            // Only fully expired Pending records are swept immediately.
            !(record.status == DiffStatus::Pending && now >= record.expires_at)
        });
    }
}

// ---------------------------------------------------------------------------
// DiffStoreHandle — Arc-wrapped state handle for Tauri
// ---------------------------------------------------------------------------

/// `Arc`-wrapped [`DiffStore`] managed by Tauri.
///
/// Cloneable so it can be passed to multiple commands simultaneously.
#[derive(Debug, Clone)]
pub struct DiffStoreHandle {
    pub inner: Arc<DiffStore>,
}

impl DiffStoreHandle {
    pub fn new(store: DiffStore) -> Self {
        Self {
            inner: Arc::new(store),
        }
    }
}

impl Default for DiffStoreHandle {
    fn default() -> Self {
        Self::new(DiffStore::new())
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    // -----------------------------------------------------------------------
    // Fixtures
    // -----------------------------------------------------------------------

    fn make_storage_class_payload(targets: &[(&str, &str)], new_class: &str) -> DiffPayload {
        let target_refs = targets
            .iter()
            .map(|(bucket, key)| DiffObjectRef {
                bucket: BucketId::new(bucket.to_string()),
                key: key.to_string(),
            })
            .collect();
        let current: HashMap<String, String> = targets
            .iter()
            .map(|(_, key)| (key.to_string(), "STANDARD".to_string()))
            .collect();
        DiffPayload::StorageClass {
            targets: target_refs,
            current,
            new_class: new_class.to_string(),
        }
    }

    // -----------------------------------------------------------------------
    // DiffId
    // -----------------------------------------------------------------------

    #[test]
    fn diff_id_new_v4_produces_unique_ids() {
        let a = DiffId::new_v4();
        let b = DiffId::new_v4();
        assert_ne!(a, b);
    }

    #[test]
    fn diff_id_serialises_as_transparent_string() {
        let id = DiffId::from("abc-123");
        let v = serde_json::to_value(&id).unwrap();
        assert_eq!(v, "abc-123");
    }

    #[test]
    fn diff_id_deserialises_from_string() {
        let id: DiffId = serde_json::from_str("\"test-id\"").unwrap();
        assert_eq!(id.as_str(), "test-id");
    }

    // -----------------------------------------------------------------------
    // DiffPayload serialisation
    // -----------------------------------------------------------------------

    #[test]
    fn diff_payload_storage_class_serialises_with_kind_tag() {
        let payload = make_storage_class_payload(&[("my-bucket", "photos/img.jpg")], "GLACIER");
        let v = serde_json::to_value(&payload).unwrap();
        assert_eq!(v["kind"], "storage_class");
        assert_eq!(v["newClass"], "GLACIER");
        assert!(v["targets"].is_array());
    }

    // -----------------------------------------------------------------------
    // DiffStore::create
    // -----------------------------------------------------------------------

    #[test]
    fn create_returns_unique_ids() {
        let store = DiffStore::new();
        let p1 = make_storage_class_payload(&[("b", "k")], "GLACIER");
        let p2 = make_storage_class_payload(&[("b", "k2")], "STANDARD_IA");
        let id1 = store.create(p1);
        let id2 = store.create(p2);
        assert_ne!(id1, id2);
    }

    #[test]
    fn create_stores_record_as_pending() {
        let store = DiffStore::new();
        let p = make_storage_class_payload(&[("b", "k")], "GLACIER");
        let id = store.create(p);
        let record = store.get(&id).expect("record must exist");
        assert_eq!(record.status, DiffStatus::Pending);
    }

    #[test]
    fn create_stores_correct_ttl() {
        let ttl = 60_i64;
        let store = DiffStore::with_ttl(ttl);
        let now = 1_000_000_i64;
        let p = make_storage_class_payload(&[("b", "k")], "GLACIER");
        let id = store.create_at(p, now);
        let record = store.get(&id).unwrap();
        assert_eq!(record.expires_at, now + ttl);
    }

    // -----------------------------------------------------------------------
    // DiffStore::consume — happy path
    // -----------------------------------------------------------------------

    #[test]
    fn consume_returns_payload_and_marks_confirmed() {
        let store = DiffStore::new();
        let p = make_storage_class_payload(&[("bucket", "key.txt")], "GLACIER");
        let id = store.create(p.clone());

        let consumed = store.consume(&id).expect("consume must succeed");
        assert_eq!(consumed, p);

        let record = store.get(&id).unwrap();
        assert_eq!(record.status, DiffStatus::Confirmed);
    }

    // -----------------------------------------------------------------------
    // DiffStore::consume — double-confirm rejection
    // -----------------------------------------------------------------------

    #[test]
    fn consume_second_call_returns_none() {
        let store = DiffStore::new();
        let p = make_storage_class_payload(&[("b", "k")], "STANDARD_IA");
        let id = store.create(p);

        let first = store.consume(&id);
        let second = store.consume(&id);

        assert!(first.is_some(), "first consume must succeed");
        assert!(
            second.is_none(),
            "second consume must be rejected (double-confirm)"
        );
    }

    // -----------------------------------------------------------------------
    // DiffStore::cancel
    // -----------------------------------------------------------------------

    #[test]
    fn cancel_sets_status_to_cancelled() {
        let store = DiffStore::new();
        let p = make_storage_class_payload(&[("b", "k")], "GLACIER");
        let id = store.create(p);

        store.cancel(&id).unwrap();

        let record = store.get(&id).unwrap();
        assert_eq!(record.status, DiffStatus::Cancelled);
    }

    #[test]
    fn consume_after_cancel_returns_none() {
        let store = DiffStore::new();
        let p = make_storage_class_payload(&[("b", "k")], "GLACIER");
        let id = store.create(p);

        store.cancel(&id).unwrap();
        let result = store.consume(&id);

        assert!(result.is_none(), "consume after cancel must return None");
    }

    #[test]
    fn cancel_nonexistent_id_returns_not_found() {
        let store = DiffStore::new();
        let fake = DiffId::from("does-not-exist");
        let result = store.cancel(&fake);
        assert!(matches!(result, Err(AppError::NotFound { .. })));
    }

    // -----------------------------------------------------------------------
    // DiffStore expiry
    // -----------------------------------------------------------------------

    #[test]
    fn consume_after_expiry_returns_none() {
        let store = DiffStore::with_ttl(10);
        let now = 1_000_000_i64;
        let p = make_storage_class_payload(&[("b", "k")], "GLACIER");
        let id = store.create_at(p, now);

        // Try to consume 11 seconds after creation — TTL was 10 s.
        let result = store.consume_at(&id, now + 11);
        assert!(result.is_none(), "consume past TTL must fail");

        let record = store.get(&id).unwrap();
        assert_eq!(record.status, DiffStatus::Expired);
    }

    #[test]
    fn consume_at_exact_expiry_boundary_fails() {
        let store = DiffStore::with_ttl(10);
        let now = 1_000_000_i64;
        let p = make_storage_class_payload(&[("b", "k")], "GLACIER");
        let id = store.create_at(p, now);

        // expires_at = now + 10 → consuming exactly at that second is expired.
        let result = store.consume_at(&id, now + 10);
        assert!(result.is_none(), "consume at exact expiry must fail");
    }

    #[test]
    fn consume_before_expiry_succeeds() {
        let store = DiffStore::with_ttl(10);
        let now = 1_000_000_i64;
        let p = make_storage_class_payload(&[("b", "k")], "GLACIER");
        let id = store.create_at(p, now);

        let result = store.consume_at(&id, now + 9);
        assert!(result.is_some(), "consume before expiry must succeed");
    }

    // -----------------------------------------------------------------------
    // DiffStore::gc
    // -----------------------------------------------------------------------

    #[test]
    fn gc_removes_expired_pending_records() {
        let store = DiffStore::with_ttl(10);
        let now = 1_000_000_i64;
        let p = make_storage_class_payload(&[("b", "k")], "GLACIER");
        let id = store.create_at(p, now);

        // GC past expiry.
        store.gc_at(now + 11);
        let record = store.get(&id);
        assert!(record.is_none(), "expired record must be removed by gc");
    }

    #[test]
    fn gc_does_not_remove_confirmed_records() {
        let store = DiffStore::with_ttl(10);
        let now = 1_000_000_i64;
        let p = make_storage_class_payload(&[("b", "k")], "GLACIER");
        let id = store.create_at(p, now);

        store.consume_at(&id, now + 1).unwrap();
        store.gc_at(now + 11);

        // Confirmed records are kept (so the frontend can still read them).
        let record = store.get(&id);
        assert!(record.is_some(), "confirmed record must survive gc");
    }

    #[test]
    fn gc_does_not_remove_cancelled_records() {
        let store = DiffStore::with_ttl(10);
        let now = 1_000_000_i64;
        let p = make_storage_class_payload(&[("b", "k")], "GLACIER");
        let id = store.create_at(p, now);

        store.cancel(&id).unwrap();
        store.gc_at(now + 11);

        // Cancelled records are kept for the same reason.
        let record = store.get(&id);
        assert!(record.is_some(), "cancelled record must survive gc");
    }

    // -----------------------------------------------------------------------
    // DiffStoreHandle — Arc clone is the same store
    // -----------------------------------------------------------------------

    #[test]
    fn diff_store_handle_clones_share_state() {
        let handle = DiffStoreHandle::default();
        let clone = handle.clone();

        let p = make_storage_class_payload(&[("b", "k")], "GLACIER");
        let id = handle.inner.create(p);

        // The clone must see the record created through the original handle.
        let record = clone.inner.get(&id);
        assert!(record.is_some(), "cloned handle must see same store");
    }
}
