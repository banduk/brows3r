//! Capability classification cache.
//!
//! Stores `(profile, bucket?, op) → CapabilityRecord` in memory with a
//! configurable TTL (default 30 minutes). Future tasks may add disk persistence
//! via `redb`; the API surface is deliberately designed to accommodate that
//! without changing call sites.
//!
//! # OCP contract
//!
//! - Add a new capability class: add a `CapabilityClass` variant + one arm in
//!   `record_from_error`. Existing arms are untouched.
//! - Add a new error pattern to classify: add one `match` arm inside
//!   `record_from_error`. The enum and store are unaffected.
//! - Add a new scope for `clear`: add a `ClearScope` variant + one arm in
//!   `CapabilityCache::clear`. Existing scopes are untouched.
//! - Storage-class extraction uses a small substring scan; new storage class
//!   names (e.g. `DEEP_ARCHIVE_IA`) are recognized automatically when they
//!   appear in the error message after `"InvalidStorageClass"` or
//!   `"NoSuchTransition"`.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};

use crate::{
    error::AppError,
    ids::{BucketId, ProfileId},
};

// ---------------------------------------------------------------------------
// TTL default
// ---------------------------------------------------------------------------

/// Default TTL for capability records: 30 minutes.
///
/// Configurable in the future via `Settings::cache_ttl_secs`.
const DEFAULT_TTL_SECS: i64 = 30 * 60;

// ---------------------------------------------------------------------------
// CapabilityClass
// ---------------------------------------------------------------------------

/// Classification of a single S3 operation's capability for a (profile,
/// bucket?, op) triple.
///
/// Variants are open for extension (new entries do not break existing match arms
/// because callers use `record_from_error` as the single classification point).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "class", rename_all = "camelCase")]
pub enum CapabilityClass {
    /// The operation is permitted.
    Allowed,
    /// IAM policy denied the operation.
    ///
    /// `iam_action` is the action string from the `AccessDenied` error when
    /// available (e.g. `"s3:PutBucketVersioning"`).
    Denied { iam_action: Option<String> },
    /// The provider does not implement the operation.
    ///
    /// `provider` names the S3-compatible endpoint (e.g. `"MinIO"`).
    Unsupported { provider: Option<String> },
    /// The operation is blocked because the object's storage class does not
    /// support it (e.g. GLACIER objects cannot be directly downloaded).
    StorageClassBlocked { storage_class: String },
}

// ---------------------------------------------------------------------------
// CapabilityRecord
// ---------------------------------------------------------------------------

/// A cached capability result with the timestamp at which it was learned.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapabilityRecord {
    /// The classified outcome.
    pub class: CapabilityClass,
    /// Unix timestamp (seconds) when this record was inserted or last updated.
    pub learned_at: i64,
}

// ---------------------------------------------------------------------------
// CapabilityMap
// ---------------------------------------------------------------------------

/// All known capabilities for a profile, keyed by `"<bucket_or_empty>/<op>"`.
///
/// Used by the frontend `useCapabilities` hook to render disabled controls with
/// contextual reasons (e.g. `"Requires s3:PutBucketVersioning"`).
pub type CapabilityMap = HashMap<String, CapabilityRecord>;

// ---------------------------------------------------------------------------
// ClearScope
// ---------------------------------------------------------------------------

/// What entries to remove when `CapabilityCache::clear` is called.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClearScope {
    /// Remove all entries for the profile.
    All,
    /// Remove all entries for a specific bucket (and the profile-level entries
    /// for that bucket, i.e. where the bucket key matches).
    Bucket(BucketId),
    /// Remove all entries for a specific operation string.
    Op(String),
}

// ---------------------------------------------------------------------------
// Internal map key
// ---------------------------------------------------------------------------

type CacheKey = (ProfileId, Option<BucketId>, String);

// ---------------------------------------------------------------------------
// Clock trait (mirrors store.rs; re-declared here to keep the module self-
// contained)
// ---------------------------------------------------------------------------

pub(crate) trait Clock: Send + Sync {
    fn now_secs(&self) -> i64;
}

#[derive(Default)]
struct SystemClock;

impl Clock for SystemClock {
    fn now_secs(&self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64
    }
}

/// Controllable clock for deterministic tests.
#[derive(Default)]
pub struct MockClock {
    inner: Mutex<i64>,
}

impl MockClock {
    pub fn new(secs: i64) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(secs),
        })
    }

    /// Advance time by `delta` seconds.
    pub fn advance(&self, delta: i64) {
        *self.inner.lock().unwrap() += delta;
    }
}

impl Clock for MockClock {
    fn now_secs(&self) -> i64 {
        *self.inner.lock().unwrap()
    }
}

// ---------------------------------------------------------------------------
// CapabilityCache
// ---------------------------------------------------------------------------

/// In-memory capability classification cache.
///
/// Thread-safe; meant to be wrapped in `Arc` and shared across Tauri commands
/// as a managed `CapabilityHandle`.
pub struct CapabilityCache {
    ttl_secs: i64,
    clock: Arc<dyn Clock>,
    map: Mutex<HashMap<CacheKey, CapabilityRecord>>,
}

impl Default for CapabilityCache {
    fn default() -> Self {
        Self {
            ttl_secs: DEFAULT_TTL_SECS,
            clock: Arc::new(SystemClock),
            map: Mutex::new(HashMap::new()),
        }
    }
}

impl CapabilityCache {
    /// Construct a cache with a custom clock (test-only helper).
    ///
    /// Gated to test builds because the production code path always uses
    /// the real `SystemClock` via `CapabilityCache::default()`.
    #[cfg(test)]
    pub(crate) fn with_clock(clock: Arc<dyn Clock>) -> Self {
        Self {
            ttl_secs: DEFAULT_TTL_SECS,
            clock,
            map: Mutex::new(HashMap::new()),
        }
    }

    /// Insert or update a capability record for the given (profile, bucket, op)
    /// triple.
    ///
    /// `bucket` is `None` for profile-level operations (e.g. `ListBuckets`).
    pub fn record_capability(
        &self,
        profile: &ProfileId,
        bucket: Option<&BucketId>,
        op: &str,
        class: CapabilityClass,
    ) {
        let key: CacheKey = (profile.clone(), bucket.cloned(), op.to_owned());
        let record = CapabilityRecord {
            class,
            learned_at: self.clock.now_secs(),
        };
        self.map.lock().unwrap().insert(key, record);
    }

    /// Classify `error` and, if classifiable, record the result for the given
    /// (profile, bucket, op) triple.
    ///
    /// Returns `Ok(true)` when the error was classified and stored.
    /// Returns `Ok(false)` when the error is not classifiable (no record is
    /// stored).
    pub fn record_from_error(
        &self,
        profile: &ProfileId,
        bucket: Option<&BucketId>,
        op: &str,
        error: &AppError,
    ) -> Result<bool, AppError> {
        let class = match error {
            AppError::AccessDenied { op: action, .. } => CapabilityClass::Denied {
                iam_action: Some(action.clone()),
            },
            AppError::Unsupported { provider, .. } => CapabilityClass::Unsupported {
                provider: Some(provider.clone()),
            },
            AppError::ProviderSpecific { code, message } => {
                // Matches: "InvalidStorageClass" and "NoSuchTransition" errors.
                if code == "InvalidStorageClass" || code == "NoSuchTransition" {
                    let storage_class = extract_storage_class(message);
                    CapabilityClass::StorageClassBlocked { storage_class }
                } else {
                    return Ok(false);
                }
            }
            // All other error kinds are not capability-related.
            _ => return Ok(false),
        };

        self.record_capability(profile, bucket, op, class);
        Ok(true)
    }

    /// Look up a capability record. Returns `None` if missing or expired.
    pub fn get(
        &self,
        profile: &ProfileId,
        bucket: Option<&BucketId>,
        op: &str,
    ) -> Option<CapabilityRecord> {
        let key: CacheKey = (profile.clone(), bucket.cloned(), op.to_owned());
        let map = self.map.lock().unwrap();
        let record = map.get(&key)?;
        let age = self.clock.now_secs() - record.learned_at;
        if age >= self.ttl_secs {
            return None;
        }
        Some(record.clone())
    }

    /// Return all non-expired capability records for `profile` as a flat map.
    ///
    /// Key format: `"<bucket>/<op>"` where `<bucket>` is empty for
    /// profile-level operations.
    pub fn get_map(&self, profile: &ProfileId) -> CapabilityMap {
        let now = self.clock.now_secs();
        let map = self.map.lock().unwrap();
        map.iter()
            .filter(|((pid, _, _), _)| pid == profile)
            .filter(|(_, record)| (now - record.learned_at) < self.ttl_secs)
            .map(|((_, bucket, op), record)| {
                let bucket_part = bucket.as_ref().map(|b| b.as_str()).unwrap_or("");
                let key = format!("{bucket_part}/{op}");
                (key, record.clone())
            })
            .collect()
    }

    /// Remove entries for `profile` that match `scope`.
    ///
    /// After `clear(All)` the profile has zero entries in the cache. After
    /// `clear(Bucket(id))` only that bucket's entries are removed (other
    /// buckets and profile-level ops remain). After `clear(Op(name))` only
    /// entries with that exact operation string are removed.
    pub fn clear(&self, profile: &ProfileId, scope: &ClearScope) {
        let mut map = self.map.lock().unwrap();
        map.retain(|(pid, bucket, op), _| {
            if pid != profile {
                return true; // keep entries belonging to other profiles
            }
            match scope {
                ClearScope::All => false,
                ClearScope::Bucket(bid) => bucket.as_ref() != Some(bid),
                ClearScope::Op(target_op) => op != target_op,
            }
        });
    }
}

// ---------------------------------------------------------------------------
// CapabilityHandle — Tauri managed state
// ---------------------------------------------------------------------------

/// `Arc` wrapper so `CapabilityCache` can be registered as Tauri managed state.
#[derive(Clone, Default)]
pub struct CapabilityHandle(pub Arc<CapabilityCache>);

impl CapabilityHandle {
    pub fn inner(&self) -> &CapabilityCache {
        &self.0
    }
}

impl std::ops::Deref for CapabilityHandle {
    type Target = CapabilityCache;
    fn deref(&self) -> &CapabilityCache {
        &self.0
    }
}

// ---------------------------------------------------------------------------
// Storage-class extraction helper
// ---------------------------------------------------------------------------

/// Extract the storage class name from a provider error message.
///
/// Provider messages typically look like:
///   `"The storage class GLACIER is not supported for this operation"`
///   `"NoSuchTransition for STANDARD_IA"`
///
/// The heuristic: find the first token after a known sentinel word that
/// looks like a storage class (all uppercase letters, digits, underscores,
/// at least 3 chars). Falls back to `"UNKNOWN"` when nothing matches.
fn extract_storage_class(message: &str) -> String {
    // Known sentinels that precede the storage class name in provider messages.
    let sentinels = [
        "class ",
        "class\t",
        "for ",
        "GLACIER",
        "STANDARD_IA",
        "DEEP_ARCHIVE",
    ];

    // Fast path: look for known storage class names directly in the message.
    for known in &[
        "GLACIER_IR",
        "GLACIER",
        "DEEP_ARCHIVE",
        "STANDARD_IA",
        "ONEZONE_IA",
        "INTELLIGENT_TIERING",
        "STANDARD",
        "REDUCED_REDUNDANCY",
        "EXPRESS_ONEZONE",
    ] {
        if message.contains(known) {
            return (*known).to_owned();
        }
    }

    // Slow path: look for a sentinel and grab the next uppercase token.
    for sentinel in &sentinels {
        if let Some(pos) = message.find(sentinel) {
            let after = &message[pos + sentinel.len()..];
            let token: String = after
                .chars()
                .take_while(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == '_')
                .collect();
            if token.len() >= 3 {
                return token;
            }
        }
    }

    "UNKNOWN".to_owned()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(s: &str) -> ProfileId {
        ProfileId::new(s)
    }

    fn bucket(s: &str) -> BucketId {
        BucketId::new(s)
    }

    // -----------------------------------------------------------------------
    // record_from_error classification
    // -----------------------------------------------------------------------

    #[test]
    fn access_denied_maps_to_denied_with_iam_action() {
        let cache = CapabilityCache::default();
        let pid = profile("p1");
        let bid = bucket("my-bucket");

        let err = AppError::AccessDenied {
            op: "s3:PutBucketVersioning".to_owned(),
            resource: "arn:aws:s3:::my-bucket".to_owned(),
        };

        let classified = cache
            .record_from_error(&pid, Some(&bid), "PutBucketVersioning", &err)
            .unwrap();
        assert!(classified, "AccessDenied must be classified");

        let record = cache
            .get(&pid, Some(&bid), "PutBucketVersioning")
            .expect("record must be stored");
        assert_eq!(
            record.class,
            CapabilityClass::Denied {
                iam_action: Some("s3:PutBucketVersioning".to_owned()),
            }
        );
    }

    #[test]
    fn unsupported_maps_to_unsupported_with_provider() {
        let cache = CapabilityCache::default();
        let pid = profile("p2");

        let err = AppError::Unsupported {
            op: "SelectObjectContent".to_owned(),
            provider: "MinIO".to_owned(),
        };

        let classified = cache
            .record_from_error(&pid, None, "SelectObjectContent", &err)
            .unwrap();
        assert!(classified);

        let record = cache
            .get(&pid, None, "SelectObjectContent")
            .expect("record must be stored");
        assert_eq!(
            record.class,
            CapabilityClass::Unsupported {
                provider: Some("MinIO".to_owned()),
            }
        );
    }

    #[test]
    fn invalid_storage_class_maps_to_storage_class_blocked() {
        let cache = CapabilityCache::default();
        let pid = profile("p3");
        let bid = bucket("archive-bucket");

        let err = AppError::ProviderSpecific {
            code: "InvalidStorageClass".to_owned(),
            message: "The storage class GLACIER is not supported for this transition".to_owned(),
        };

        let classified = cache
            .record_from_error(&pid, Some(&bid), "SetStorageClass", &err)
            .unwrap();
        assert!(classified);

        let record = cache
            .get(&pid, Some(&bid), "SetStorageClass")
            .expect("record must be stored");
        assert_eq!(
            record.class,
            CapabilityClass::StorageClassBlocked {
                storage_class: "GLACIER".to_owned(),
            }
        );
    }

    #[test]
    fn no_such_transition_maps_to_storage_class_blocked() {
        let cache = CapabilityCache::default();
        let pid = profile("p3b");
        let bid = bucket("bucket-x");

        let err = AppError::ProviderSpecific {
            code: "NoSuchTransition".to_owned(),
            message: "Transition to STANDARD_IA failed".to_owned(),
        };

        let classified = cache
            .record_from_error(&pid, Some(&bid), "TransitionStorageClass", &err)
            .unwrap();
        assert!(classified);

        let record = cache
            .get(&pid, Some(&bid), "TransitionStorageClass")
            .expect("record must be stored");
        match &record.class {
            CapabilityClass::StorageClassBlocked { storage_class } => {
                assert_eq!(storage_class, "STANDARD_IA");
            }
            other => panic!("expected StorageClassBlocked, got {other:?}"),
        }
    }

    #[test]
    fn not_found_returns_ok_false_and_stores_nothing() {
        let cache = CapabilityCache::default();
        let pid = profile("p4");

        let err = AppError::NotFound {
            resource: "s3://bucket/key".to_owned(),
        };

        let classified = cache
            .record_from_error(&pid, None, "GetObject", &err)
            .unwrap();
        assert!(!classified, "NotFound must not be classified");

        assert!(
            cache.get(&pid, None, "GetObject").is_none(),
            "no record must be stored for unclassifiable error"
        );
    }

    // -----------------------------------------------------------------------
    // TTL expiry
    // -----------------------------------------------------------------------

    #[test]
    fn expired_record_returns_none() {
        let clock = MockClock::new(1_000_000);
        let cache = CapabilityCache::with_clock(clock.clone());
        let pid = profile("p-ttl");

        cache.record_capability(&pid, None, "ListBuckets", CapabilityClass::Allowed);

        // Not yet expired.
        assert!(cache.get(&pid, None, "ListBuckets").is_some());

        // Advance past the 30-minute TTL.
        clock.advance(DEFAULT_TTL_SECS);

        assert!(
            cache.get(&pid, None, "ListBuckets").is_none(),
            "record must expire after TTL"
        );
    }

    #[test]
    fn record_just_before_ttl_is_returned() {
        let clock = MockClock::new(1_000_000);
        let cache = CapabilityCache::with_clock(clock.clone());
        let pid = profile("p-ttl2");

        cache.record_capability(&pid, None, "ListBuckets", CapabilityClass::Allowed);

        // Advance to one second before expiry.
        clock.advance(DEFAULT_TTL_SECS - 1);

        assert!(
            cache.get(&pid, None, "ListBuckets").is_some(),
            "record must still be live one second before TTL"
        );
    }

    // -----------------------------------------------------------------------
    // clear
    // -----------------------------------------------------------------------

    #[test]
    fn clear_all_removes_all_profile_entries() {
        let cache = CapabilityCache::default();
        let pid = profile("p-clear");
        let bid = bucket("bucket-a");

        cache.record_capability(&pid, None, "ListBuckets", CapabilityClass::Allowed);
        cache.record_capability(&pid, Some(&bid), "PutObject", CapabilityClass::Allowed);

        cache.clear(&pid, &ClearScope::All);

        assert!(cache.get(&pid, None, "ListBuckets").is_none());
        assert!(cache.get(&pid, Some(&bid), "PutObject").is_none());
    }

    #[test]
    fn clear_all_does_not_touch_other_profiles() {
        let cache = CapabilityCache::default();
        let p1 = profile("p-clear-a");
        let p2 = profile("p-clear-b");

        cache.record_capability(&p1, None, "ListBuckets", CapabilityClass::Allowed);
        cache.record_capability(&p2, None, "ListBuckets", CapabilityClass::Allowed);

        cache.clear(&p1, &ClearScope::All);

        assert!(cache.get(&p1, None, "ListBuckets").is_none());
        assert!(
            cache.get(&p2, None, "ListBuckets").is_some(),
            "other profile's entries must survive"
        );
    }

    #[test]
    fn clear_bucket_removes_only_that_buckets_entries() {
        let cache = CapabilityCache::default();
        let pid = profile("p-bucket-clear");
        let b_foo = bucket("foo");
        let b_bar = bucket("bar");

        cache.record_capability(&pid, Some(&b_foo), "PutObject", CapabilityClass::Allowed);
        cache.record_capability(&pid, Some(&b_bar), "PutObject", CapabilityClass::Allowed);
        cache.record_capability(&pid, None, "ListBuckets", CapabilityClass::Allowed);

        cache.clear(&pid, &ClearScope::Bucket(b_foo.clone()));

        assert!(
            cache.get(&pid, Some(&b_foo), "PutObject").is_none(),
            "foo's entry must be removed"
        );
        assert!(
            cache.get(&pid, Some(&b_bar), "PutObject").is_some(),
            "bar's entry must survive"
        );
        assert!(
            cache.get(&pid, None, "ListBuckets").is_some(),
            "profile-level entry must survive"
        );
    }

    // -----------------------------------------------------------------------
    // get_map
    // -----------------------------------------------------------------------

    #[test]
    fn get_map_returns_correct_subset_for_profile() {
        let cache = CapabilityCache::default();
        let p1 = profile("map-p1");
        let p2 = profile("map-p2");
        let bid = bucket("my-bucket");

        cache.record_capability(&p1, Some(&bid), "PutObject", CapabilityClass::Allowed);
        cache.record_capability(
            &p1,
            None,
            "ListBuckets",
            CapabilityClass::Denied {
                iam_action: Some("s3:ListBuckets".to_owned()),
            },
        );
        cache.record_capability(&p2, None, "ListBuckets", CapabilityClass::Allowed);

        let map = cache.get_map(&p1);
        assert_eq!(map.len(), 2, "p1 must have exactly 2 entries");
        assert!(map.contains_key("my-bucket/PutObject"));
        assert!(map.contains_key("/ListBuckets"));

        let p2_map = cache.get_map(&p2);
        assert_eq!(p2_map.len(), 1, "p2 must have exactly 1 entry");
    }

    #[test]
    fn get_map_excludes_expired_entries() {
        let clock = MockClock::new(2_000_000);
        let cache = CapabilityCache::with_clock(clock.clone());
        let pid = profile("map-ttl");

        cache.record_capability(&pid, None, "ListBuckets", CapabilityClass::Allowed);

        // Expire the record.
        clock.advance(DEFAULT_TTL_SECS);

        let map = cache.get_map(&pid);
        assert!(map.is_empty(), "get_map must exclude expired entries");
    }
}
