//! Resource lock registry with full lifecycle.
//!
//! Provides acquire/release/heartbeat/TTL-expire/startup-cleanup for any
//! scoped resource operation, wired to the typed event system from task 9.
//!
//! # OCP contract
//!
//! - Adding a new scope dimension: add one optional field to `LockScope` and
//!   one intersection arm in `LockScope::intersects`.  No existing arms change.
//! - Adding a new release reason: add one `ReleaseReason` variant.  Serializes
//!   automatically via `rename_all = "snake_case"`.
//! - Heartbeat loop works for any scope — it is a generic background task that
//!   calls `release_stale` on any `LockRegistry`.
//! - Event emission uses `events::emit` — no string literals scattered at call
//!   sites.

pub mod lifecycle;

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    error::AppError,
    events::{EventEmitter, EventKind},
    ids::{BucketId, ObjectKey, ProfileId},
};

// ---------------------------------------------------------------------------
// LockId
// ---------------------------------------------------------------------------

/// Opaque lock identifier — UUID v4 minted on `acquire`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct LockId(pub String);

impl LockId {
    /// Mint a new `LockId` backed by a UUID v4.
    pub fn new_v4() -> Self {
        Self(Uuid::new_v4().to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for LockId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<&str> for LockId {
    fn from(s: &str) -> Self {
        Self(s.to_owned())
    }
}

impl From<String> for LockId {
    fn from(s: String) -> Self {
        Self(s)
    }
}

// ---------------------------------------------------------------------------
// LockScope
// ---------------------------------------------------------------------------

/// Hierarchical scope key for a resource lock.
///
/// Conflict detection uses longest-prefix matching: two scopes conflict when
/// one is an ancestor of the other in the hierarchy
/// `profile → bucket → prefix → key`.
///
/// Adding a new scope dimension requires only: a new optional field here and
/// one additional arm in `intersects`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockScope {
    pub profile: ProfileId,
    pub bucket: Option<BucketId>,
    /// S3 key prefix (folder path), e.g. `"images/"`.
    pub prefix: Option<String>,
    pub key: Option<ObjectKey>,
}

impl LockScope {
    /// Returns `true` when `self` and `other` share a resource and a lock on
    /// one would conflict with a lock on the other.
    ///
    /// Two scopes intersect when one is an ancestor (or equal to) the other in
    /// the `profile → bucket → prefix → key` hierarchy — longest-prefix rule.
    pub fn intersects(&self, other: &LockScope) -> bool {
        // Different profiles never conflict.
        if self.profile != other.profile {
            return false;
        }

        // Different buckets never conflict (when both specified).
        if let (Some(a), Some(b)) = (&self.bucket, &other.bucket) {
            if a != b {
                return false;
            }
        }
        // If either bucket is None the scope is profile-wide → overlaps any
        // same-profile scope.
        if self.bucket.is_none() || other.bucket.is_none() {
            return true;
        }

        // Same bucket. Key-level checks take precedence so two concurrent
        // single-object operations (e.g. download a.pdf and download
        // b.html) do not falsely conflict via a None prefix on both sides.
        // The previous implementation early-returned `true` when either
        // prefix was None — making every `prefix=None, key=Some` scope
        // collide with every other one in the same bucket.
        match (&self.key, &other.key) {
            (Some(a), Some(b)) => return a == b,
            (Some(k), None) => {
                // self is key-specific; other is broader (prefix or bucket).
                // Overlap iff k is under other's prefix (or other is
                // bucket-wide, i.e. other.prefix == None).
                return match &other.prefix {
                    Some(p) => k.as_str().starts_with(p.as_str()),
                    None => true,
                };
            }
            (None, Some(k)) => {
                return match &self.prefix {
                    Some(p) => k.as_str().starts_with(p.as_str()),
                    None => true,
                };
            }
            (None, None) => {}
        }

        // Neither side carries a specific key. Compare prefixes.
        match (&self.prefix, &other.prefix) {
            (None, _) | (_, None) => true,
            (Some(a), Some(b)) => {
                a.starts_with(b.as_str()) || b.starts_with(a.as_str())
            }
        }
    }
}

// ---------------------------------------------------------------------------
// ReleaseReason
// ---------------------------------------------------------------------------

/// Why a lock was released.
///
/// Serialized as snake_case strings to match the `lock:released { reason }`
/// event payload described in the design (line 399–400).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReleaseReason {
    Success,
    Failure,
    Cancel,
    Ttl,
    StartupCleanup,
}

// ---------------------------------------------------------------------------
// ResourceLock
// ---------------------------------------------------------------------------

/// An active resource lock held by an operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceLock {
    pub id: LockId,
    pub scope: LockScope,
    pub op_name: String,
    /// Unix timestamp (seconds) when the lock was acquired.
    pub acquired_at: i64,
    /// Unix timestamp (seconds) of the last heartbeat (or initial acquisition).
    pub last_heartbeat_at: i64,
    /// How many seconds of inactivity before the lock is considered stale.
    pub ttl_secs: u64,
}

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockAcquiredPayload {
    pub lock_id: LockId,
    pub scope: LockScope,
    pub op_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockReleasedPayload {
    pub lock_id: LockId,
    pub scope: LockScope,
    pub reason: ReleaseReason,
}

// ---------------------------------------------------------------------------
// LockRegistry
// ---------------------------------------------------------------------------

/// Inner registry state — separated so tests can poke at it directly.
struct RegistryInner {
    locks: HashMap<LockId, ResourceLock>,
}

impl RegistryInner {
    fn new() -> Self {
        Self {
            locks: HashMap::new(),
        }
    }
}

/// Thread-safe in-memory registry of active resource locks.
///
/// Wrap in `Arc<LockRegistry>` and manage via Tauri's state system.
pub struct LockRegistry {
    inner: Mutex<RegistryInner>,
}

impl LockRegistry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(RegistryInner::new()),
        }
    }

    // -----------------------------------------------------------------------
    // acquire
    // -----------------------------------------------------------------------

    /// Acquire a lock for `scope` / `op_name` with `ttl_secs` TTL.
    ///
    /// Returns the new `LockId` on success.  Returns `AppError::Locked` when
    /// any existing lock has an intersecting scope.
    ///
    /// The caller is responsible for emitting `lock:acquired` via
    /// `lifecycle::emit_acquired`.
    pub fn acquire(
        &self,
        scope: LockScope,
        op_name: impl Into<String>,
        ttl_secs: u64,
        now: i64,
    ) -> Result<LockId, AppError> {
        let op_name = op_name.into();
        let mut inner = self.inner.lock().expect("lock poisoned");

        // Check for conflicts.
        for existing in inner.locks.values() {
            if existing.scope.intersects(&scope) {
                return Err(AppError::Locked {
                    lock_id: existing.id.as_str().to_owned(),
                    op_name: existing.op_name.clone(),
                });
            }
        }

        let id = LockId::new_v4();
        let lock = ResourceLock {
            id: id.clone(),
            scope,
            op_name,
            acquired_at: now,
            last_heartbeat_at: now,
            ttl_secs,
        };
        inner.locks.insert(id.clone(), lock);
        Ok(id)
    }

    // -----------------------------------------------------------------------
    // heartbeat
    // -----------------------------------------------------------------------

    /// Extend the heartbeat for `lock_id`.
    ///
    /// Returns `AppError::NotFound` if the lock does not exist.
    pub fn heartbeat(&self, lock_id: &LockId, now: i64) -> Result<(), AppError> {
        let mut inner = self.inner.lock().expect("lock poisoned");
        match inner.locks.get_mut(lock_id) {
            Some(lock) => {
                lock.last_heartbeat_at = now;
                Ok(())
            }
            None => Err(AppError::NotFound {
                resource: format!("lock:{}", lock_id.as_str()),
            }),
        }
    }

    // -----------------------------------------------------------------------
    // release
    // -----------------------------------------------------------------------

    /// Release a lock explicitly.
    ///
    /// Returns `AppError::NotFound` if the lock does not exist.
    /// The returned `ResourceLock` carries the scope needed for the event.
    pub fn release(&self, lock_id: &LockId) -> Result<ResourceLock, AppError> {
        let mut inner = self.inner.lock().expect("lock poisoned");
        inner
            .locks
            .remove(lock_id)
            .ok_or_else(|| AppError::NotFound {
                resource: format!("lock:{}", lock_id.as_str()),
            })
    }

    // -----------------------------------------------------------------------
    // list
    // -----------------------------------------------------------------------

    /// Return all active locks, optionally filtered to those whose scope
    /// intersects `scope_filter`.
    pub fn list(&self, scope_filter: Option<&LockScope>) -> Vec<ResourceLock> {
        let inner = self.inner.lock().expect("lock poisoned");
        inner
            .locks
            .values()
            .filter(|l| scope_filter.map(|f| l.scope.intersects(f)).unwrap_or(true))
            .cloned()
            .collect()
    }

    // -----------------------------------------------------------------------
    // release_stale
    // -----------------------------------------------------------------------

    /// Release all locks whose TTL has expired relative to `now`.
    ///
    /// Returns the released locks so the caller can emit events.
    pub fn release_stale(&self, now: i64) -> Vec<ResourceLock> {
        let mut inner = self.inner.lock().expect("lock poisoned");
        let stale_ids: Vec<LockId> = inner
            .locks
            .values()
            .filter(|l| (l.last_heartbeat_at + l.ttl_secs as i64) < now)
            .map(|l| l.id.clone())
            .collect();

        let mut released = Vec::with_capacity(stale_ids.len());
        for id in stale_ids {
            if let Some(lock) = inner.locks.remove(&id) {
                released.push(lock);
            }
        }
        released
    }

    // -----------------------------------------------------------------------
    // startup_cleanup
    // -----------------------------------------------------------------------

    /// Remove *all* locks regardless of TTL.
    ///
    /// Called once at app start to clear any locks left over from a prior crash
    /// or abnormal exit.  Returns the removed locks so the caller can emit
    /// `lock:released { reason: StartupCleanup }` for each.
    pub fn startup_cleanup(&self) -> Vec<ResourceLock> {
        let mut inner = self.inner.lock().expect("lock poisoned");
        inner.locks.drain().map(|(_, v)| v).collect()
    }
}

impl Default for LockRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// LockRegistryHandle — Arc wrapper for Tauri state
// ---------------------------------------------------------------------------

/// `Arc<LockRegistry>` wrapped for Tauri's `State` system.
#[derive(Clone)]
pub struct LockRegistryHandle(pub Arc<LockRegistry>);

impl LockRegistryHandle {
    pub fn new(registry: LockRegistry) -> Self {
        Self(Arc::new(registry))
    }

    pub fn inner(&self) -> &LockRegistry {
        &self.0
    }
}

impl std::ops::Deref for LockRegistryHandle {
    type Target = LockRegistry;
    fn deref(&self) -> &LockRegistry {
        &self.0
    }
}

impl Default for LockRegistryHandle {
    fn default() -> Self {
        Self::new(LockRegistry::new())
    }
}

// ---------------------------------------------------------------------------
// Convenience: emit helpers (used by commands and lifecycle)
// ---------------------------------------------------------------------------

/// Emit `lock:acquired` for `lock`.
pub fn emit_acquired<E: EventEmitter>(channel: &E, lock: &ResourceLock) -> Result<(), AppError> {
    crate::events::emit(
        channel,
        EventKind::LockAcquired,
        LockAcquiredPayload {
            lock_id: lock.id.clone(),
            scope: lock.scope.clone(),
            op_name: lock.op_name.clone(),
        },
    )
}

/// Emit `lock:released` for a lock that was removed with `reason`.
pub fn emit_released<E: EventEmitter>(
    channel: &E,
    lock: &ResourceLock,
    reason: ReleaseReason,
) -> Result<(), AppError> {
    crate::events::emit(
        channel,
        EventKind::LockReleased,
        LockReleasedPayload {
            lock_id: lock.id.clone(),
            scope: lock.scope.clone(),
            reason,
        },
    )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::{EventKind, MockChannel};

    fn profile() -> ProfileId {
        ProfileId::new("p1")
    }

    fn bucket() -> BucketId {
        BucketId::new("my-bucket")
    }

    fn scope_profile() -> LockScope {
        LockScope {
            profile: profile(),
            bucket: None,
            prefix: None,
            key: None,
        }
    }

    fn scope_bucket() -> LockScope {
        LockScope {
            profile: profile(),
            bucket: Some(bucket()),
            prefix: None,
            key: None,
        }
    }

    fn scope_prefix(prefix: &str) -> LockScope {
        LockScope {
            profile: profile(),
            bucket: Some(bucket()),
            prefix: Some(prefix.to_owned()),
            key: None,
        }
    }

    fn scope_key(prefix: &str, key: &str) -> LockScope {
        LockScope {
            profile: profile(),
            bucket: Some(bucket()),
            prefix: Some(prefix.to_owned()),
            key: Some(ObjectKey::new(key)),
        }
    }

    const NOW: i64 = 1_000_000;

    // -----------------------------------------------------------------------
    // LockScope::intersects
    // -----------------------------------------------------------------------

    #[test]
    fn different_profiles_do_not_intersect() {
        let a = LockScope {
            profile: ProfileId::new("p1"),
            bucket: None,
            prefix: None,
            key: None,
        };
        let b = LockScope {
            profile: ProfileId::new("p2"),
            bucket: None,
            prefix: None,
            key: None,
        };
        assert!(!a.intersects(&b));
    }

    #[test]
    fn profile_level_intersects_everything_same_profile() {
        assert!(scope_profile().intersects(&scope_bucket()));
        assert!(scope_bucket().intersects(&scope_profile()));
    }

    #[test]
    fn bucket_level_intersects_prefix_under_same_bucket() {
        assert!(scope_bucket().intersects(&scope_prefix("images/")));
        assert!(scope_prefix("images/").intersects(&scope_bucket()));
    }

    #[test]
    fn different_buckets_do_not_intersect() {
        let a = LockScope {
            profile: profile(),
            bucket: Some(BucketId::new("bucket-a")),
            prefix: None,
            key: None,
        };
        let b = LockScope {
            profile: profile(),
            bucket: Some(BucketId::new("bucket-b")),
            prefix: None,
            key: None,
        };
        assert!(!a.intersects(&b));
    }

    #[test]
    fn prefix_conflict_by_longest_prefix() {
        // "images/" is a prefix of "images/cats/" — conflict.
        assert!(scope_prefix("images/").intersects(&scope_prefix("images/cats/")));
        assert!(scope_prefix("images/cats/").intersects(&scope_prefix("images/")));
    }

    #[test]
    fn disjoint_prefixes_do_not_intersect() {
        assert!(!scope_prefix("images/").intersects(&scope_prefix("videos/")));
    }

    #[test]
    fn same_prefix_different_keys_do_not_intersect() {
        let a = scope_key("images/", "images/cat.png");
        let b = scope_key("images/", "images/dog.png");
        assert!(!a.intersects(&b));
    }

    #[test]
    fn same_key_intersects() {
        let a = scope_key("images/", "images/cat.png");
        let b = scope_key("images/", "images/cat.png");
        assert!(a.intersects(&b));
    }

    /// Regression: two concurrent single-object downloads acquire scopes
    /// with `prefix: None, key: Some(...)`. The previous intersect logic
    /// early-returned `true` whenever either prefix was None, so the
    /// second download was always rejected with AppError::Locked — which
    /// surfaced as a silently-failing PDF (or HTML, depending on race
    /// order) when the user downloaded a folder containing both.
    #[test]
    fn prefix_none_key_some_different_keys_do_not_intersect() {
        let a = LockScope {
            profile: profile(),
            bucket: Some(bucket()),
            prefix: None,
            key: Some(ObjectKey::new("folder/cat.pdf")),
        };
        let b = LockScope {
            profile: profile(),
            bucket: Some(bucket()),
            prefix: None,
            key: Some(ObjectKey::new("folder/dog.html")),
        };
        assert!(!a.intersects(&b));
    }

    #[test]
    fn prefix_none_key_some_same_key_still_intersects() {
        let a = LockScope {
            profile: profile(),
            bucket: Some(bucket()),
            prefix: None,
            key: Some(ObjectKey::new("folder/cat.pdf")),
        };
        let b = LockScope {
            profile: profile(),
            bucket: Some(bucket()),
            prefix: None,
            key: Some(ObjectKey::new("folder/cat.pdf")),
        };
        assert!(a.intersects(&b));
    }

    /// Key-specific scope conflicts with a prefix-wide scope that
    /// covers it (mixed-mode operations e.g. download single object
    /// during a bulk upload to its parent prefix).
    #[test]
    fn key_under_prefix_intersects() {
        let key = LockScope {
            profile: profile(),
            bucket: Some(bucket()),
            prefix: None,
            key: Some(ObjectKey::new("foo/bar.txt")),
        };
        let prefix = scope_prefix("foo/");
        assert!(key.intersects(&prefix));
        assert!(prefix.intersects(&key));
    }

    /// Key-specific scope does NOT conflict with a sibling prefix that
    /// doesn't cover it.
    #[test]
    fn key_under_unrelated_prefix_does_not_intersect() {
        let key = LockScope {
            profile: profile(),
            bucket: Some(bucket()),
            prefix: None,
            key: Some(ObjectKey::new("foo/bar.txt")),
        };
        let prefix = scope_prefix("baz/");
        assert!(!key.intersects(&prefix));
        assert!(!prefix.intersects(&key));
    }

    // -----------------------------------------------------------------------
    // Test 1: Acquire happy path
    // -----------------------------------------------------------------------

    #[test]
    fn acquire_happy_path() {
        let registry = LockRegistry::new();
        let channel = MockChannel::default();

        let scope = scope_bucket();
        let lock_id = registry
            .acquire(scope.clone(), "DeleteObject", 300, NOW)
            .expect("acquire should succeed");

        // Emit acquired event.
        let locks = registry.list(None);
        assert_eq!(locks.len(), 1);
        let lock = &locks[0];
        assert_eq!(lock.id, lock_id);
        assert_eq!(lock.op_name, "DeleteObject");
        assert_eq!(lock.ttl_secs, 300);

        emit_acquired(&channel, lock).expect("emit should succeed");

        let emitted = channel.emitted();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].0, EventKind::LockAcquired);
        assert_eq!(emitted[0].1["lockId"], lock_id.as_str());
        assert_eq!(emitted[0].1["opName"], "DeleteObject");
    }

    // -----------------------------------------------------------------------
    // Test 2: Double-acquire conflict
    // -----------------------------------------------------------------------

    #[test]
    fn double_acquire_conflict() {
        let registry = LockRegistry::new();
        let scope = scope_bucket();

        registry
            .acquire(scope.clone(), "Op1", 300, NOW)
            .expect("first acquire must succeed");

        let err = registry
            .acquire(scope.clone(), "Op2", 300, NOW)
            .expect_err("second acquire on overlapping scope must fail");

        match err {
            AppError::Locked { op_name, .. } => {
                assert_eq!(op_name, "Op1");
            }
            other => panic!("expected Locked, got {:?}", other),
        }
    }

    // -----------------------------------------------------------------------
    // Test 3: Heartbeat extension
    // -----------------------------------------------------------------------

    #[test]
    fn heartbeat_extends_lock_survives_release_stale() {
        let registry = LockRegistry::new();
        let scope = scope_bucket();
        let ttl: u64 = 300;

        let lock_id = registry
            .acquire(scope.clone(), "Op1", ttl, NOW)
            .expect("acquire");

        // Advance time past the original TTL.
        let after_ttl = NOW + ttl as i64 + 1;

        // Heartbeat at `after_ttl` — resets last_heartbeat_at.
        registry.heartbeat(&lock_id, after_ttl).expect("heartbeat");

        // release_stale at `after_ttl + 1` — lock's new deadline is
        // after_ttl + ttl = after_ttl + 300; still alive.
        let stale = registry.release_stale(after_ttl + 1);
        assert!(
            stale.is_empty(),
            "lock should survive after heartbeat extension"
        );

        // Lock still in registry.
        let locks = registry.list(None);
        assert_eq!(locks.len(), 1, "lock should still be present");
    }

    // -----------------------------------------------------------------------
    // Test 4: TTL expiry
    // -----------------------------------------------------------------------

    #[test]
    fn ttl_expiry_releases_lock_and_emits_event() {
        let registry = LockRegistry::new();
        let channel = MockChannel::default();
        let ttl: u64 = 300;

        let _lock_id = registry
            .acquire(scope_bucket(), "Op1", ttl, NOW)
            .expect("acquire");

        // Advance past TTL without heartbeating.
        let expired_at = NOW + ttl as i64 + 1;
        let stale = registry.release_stale(expired_at);
        assert_eq!(stale.len(), 1, "one stale lock should be released");

        // Emit event for each stale lock.
        for lock in &stale {
            emit_released(&channel, lock, ReleaseReason::Ttl).expect("emit");
        }

        let emitted = channel.emitted();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].0, EventKind::LockReleased);
        assert_eq!(emitted[0].1["reason"], "ttl");

        // Registry is now empty.
        assert!(registry.list(None).is_empty());
    }

    // -----------------------------------------------------------------------
    // Test 5: Startup cleanup
    // -----------------------------------------------------------------------

    #[test]
    fn startup_cleanup_removes_all_locks_and_emits_events() {
        let registry = LockRegistry::new();
        let channel = MockChannel::default();

        // Acquire two locks with different scopes (different profiles to avoid
        // conflict detection).
        let scope_a = LockScope {
            profile: ProfileId::new("p-a"),
            bucket: None,
            prefix: None,
            key: None,
        };
        let scope_b = LockScope {
            profile: ProfileId::new("p-b"),
            bucket: None,
            prefix: None,
            key: None,
        };

        registry
            .acquire(scope_a, "OpA", 300, NOW)
            .expect("acquire A");
        registry
            .acquire(scope_b, "OpB", 300, NOW)
            .expect("acquire B");

        assert_eq!(registry.list(None).len(), 2);

        let removed = registry.startup_cleanup();
        assert_eq!(removed.len(), 2, "all locks should be removed");

        for lock in &removed {
            emit_released(&channel, lock, ReleaseReason::StartupCleanup).expect("emit");
        }

        let emitted = channel.emitted();
        assert_eq!(emitted.len(), 2);
        for e in &emitted {
            assert_eq!(e.0, EventKind::LockReleased);
            assert_eq!(e.1["reason"], "startup_cleanup");
        }

        assert!(registry.list(None).is_empty());
    }

    // -----------------------------------------------------------------------
    // Test 6: Release reasons
    // -----------------------------------------------------------------------

    #[test]
    fn release_reasons_emit_correct_events() {
        let cases = [
            ReleaseReason::Success,
            ReleaseReason::Failure,
            ReleaseReason::Cancel,
        ];
        let expected_strings = ["success", "failure", "cancel"];

        for (reason, expected) in cases.iter().zip(expected_strings.iter()) {
            let registry = LockRegistry::new();
            let channel = MockChannel::default();

            let lock_id = registry
                .acquire(scope_bucket(), "Op1", 300, NOW)
                .expect("acquire");

            let lock = registry.release(&lock_id).expect("release");
            emit_released(&channel, &lock, reason.clone()).expect("emit");

            let emitted = channel.emitted();
            assert_eq!(emitted.len(), 1);
            assert_eq!(emitted[0].0, EventKind::LockReleased);
            assert_eq!(
                emitted[0].1["reason"], *expected,
                "reason should be {:?}",
                reason
            );
            assert_eq!(emitted[0].1["lockId"], lock_id.as_str());
        }
    }

    // -----------------------------------------------------------------------
    // Heartbeat on non-existent lock returns NotFound
    // -----------------------------------------------------------------------

    #[test]
    fn heartbeat_nonexistent_lock_returns_not_found() {
        let registry = LockRegistry::new();
        let fake_id = LockId::from("00000000-0000-0000-0000-000000000000");
        let err = registry
            .heartbeat(&fake_id, NOW)
            .expect_err("heartbeat on missing lock must fail");
        match err {
            AppError::NotFound { .. } => {}
            other => panic!("expected NotFound, got {:?}", other),
        }
    }

    // -----------------------------------------------------------------------
    // List with scope filter
    // -----------------------------------------------------------------------

    #[test]
    fn list_with_scope_filter() {
        let registry = LockRegistry::new();

        let scope_a = LockScope {
            profile: ProfileId::new("p-a"),
            bucket: None,
            prefix: None,
            key: None,
        };
        let scope_b = LockScope {
            profile: ProfileId::new("p-b"),
            bucket: None,
            prefix: None,
            key: None,
        };

        registry
            .acquire(scope_a.clone(), "OpA", 300, NOW)
            .expect("acquire A");
        registry
            .acquire(scope_b, "OpB", 300, NOW)
            .expect("acquire B");

        // Filter by profile p-a: should return only OpA.
        let filtered = registry.list(Some(&scope_a));
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].op_name, "OpA");
    }
}
