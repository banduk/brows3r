//! `CacheStore` — in-memory LRU + `redb` disk-backed cache.
//!
//! # Architecture
//!
//! ```text
//!   get(key)
//!     │
//!     ├─ validation gate: profile_validation_ts == None? → Ok(None)
//!     │
//!     ├─ in-memory map hit? → deserialise + classify freshness → return
//!     │
//!     └─ redb table hit?   → populate in-memory + classify freshness → return
//! ```
//!
//! `put` writes to both layers.  `invalidate` removes from both layers.
//! `invalidate_profile` removes every key whose profile prefix matches.
//!
//! # Disk schema
//!
//! One `redb` table named `"cache"`.
//! - Key  : serialized `CacheKey` bytes (`CacheKey::serialize_key()`).
//! - Value: `serde_json::to_vec(CacheEntry<serde_json::Value>)`.
//!
//! # Clock injection
//!
//! `CacheStore::new_with_clock` accepts a `Clock` impl so tests can control
//! time without sleeping.  Production code uses `SystemClock`.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;

use crate::error::AppError;

use super::{CacheConfig, CacheEntry, CacheKey, CacheRead, Freshness};

// ---------------------------------------------------------------------------
// redb table definition
// ---------------------------------------------------------------------------

/// Single table: serialized CacheKey → JSON-encoded `CacheEntry<Value>`.
const CACHE_TABLE: TableDefinition<&[u8], &[u8]> = TableDefinition::new("cache");

// ---------------------------------------------------------------------------
// Clock trait — allows test-time injection
// ---------------------------------------------------------------------------

/// Source of the current Unix timestamp in seconds.
pub trait Clock: Send + Sync {
    fn now_secs(&self) -> i64;
}

/// Real wall-clock implementation.
#[derive(Debug, Clone, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_secs(&self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64
    }
}

/// Controllable test clock.
#[derive(Debug, Default)]
pub struct MockClock {
    inner: Mutex<i64>,
}

impl MockClock {
    pub fn new(secs: i64) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(secs),
        })
    }

    /// Advance the clock by `delta` seconds.
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
// InMemoryEntry
// ---------------------------------------------------------------------------

/// An in-memory slot holds the raw JSON bytes so the type parameter can vary
/// per call site without making `CacheStore` itself generic.
#[derive(Debug, Clone)]
struct InMemoryEntry {
    raw: Vec<u8>, // serde_json bytes of CacheEntry<Value>
    expires_at: i64,
    swr_deadline: i64, // expires_at + swr_window_secs
}

// ---------------------------------------------------------------------------
// open_or_recreate_redb — wipe + retry on stale-schema files
// ---------------------------------------------------------------------------

/// Open a `redb` `Database` at `path`, recreating the file when it has a
/// stale on-disk schema.
///
/// redb's file format changes between major versions (we recently bumped
/// 2.x → 4.x). Opening a file written by the previous major returns
/// `DatabaseError::UpgradeRequired(_)` and there is no automatic in-place
/// migration. Every redb file the app maintains is derivative state —
/// the SWR cache and the multipart-upload bookkeeping table — that can be
/// safely wiped and rebuilt at runtime; the alternative (panicking and
/// refusing to launch) is far worse for the user than losing a cache and
/// orphaning a handful of multipart uploads (which the MultipartPanel can
/// still clean up by scanning S3 directly).
///
/// Retry strategy:
///   1. `Database::create(path)` (opens existing or creates new).
///   2. If `UpgradeRequired` → remove the file and call `create` again.
///   3. Any other error propagates unchanged.
pub fn open_or_recreate_redb(path: &std::path::Path) -> Result<Database, redb::DatabaseError> {
    use redb::DatabaseError;
    match Database::create(path) {
        Ok(db) => Ok(db),
        Err(DatabaseError::UpgradeRequired(_)) => {
            // Best-effort: ignore the remove error so a missing/locked file
            // still falls through to the retry path with a meaningful error.
            let _ = std::fs::remove_file(path);
            Database::create(path)
        }
        Err(e) => Err(e),
    }
}

/// Open a redb `Database`, returning an in-memory backend as the final
/// fallback so callers never have to panic during app startup.
///
/// First tries [`open_or_recreate_redb`]. On any error that
/// `open_or_recreate_redb` cannot itself recover from (permissions, full
/// disk, locked file, corrupt header that isn't a stale-schema marker),
/// switches to redb's `InMemoryBackend`. The app keeps running with a
/// non-persistent state for this session.
///
/// Returns `(db, was_in_memory)` so callers can surface a one-shot
/// startup notification explaining that, e.g., the multipart upload
/// bookkeeping is not persisting this session.
pub fn open_redb_or_in_memory(path: &std::path::Path) -> (Database, bool) {
    match open_or_recreate_redb(path) {
        Ok(db) => (db, false),
        Err(_) => {
            // `InMemoryBackend` is purely in-process state with no IO of its
            // own to fail; the only way `create_with_backend` errors here is
            // if redb changes the invariant — be loud so we catch it.
            let db = Database::builder()
                .create_with_backend(redb::backends::InMemoryBackend::new())
                .expect(
                    "redb InMemoryBackend create cannot fail in current crate \
                     version; audit this call if it ever does",
                );
            (db, true)
        }
    }
}

// ---------------------------------------------------------------------------
// CacheStore
// ---------------------------------------------------------------------------

/// Shared cache handle.  Clone to share across threads.
pub type CacheHandle = Arc<CacheStore>;

/// In-memory + disk-backed authoritative cache.
///
/// All methods are synchronous (redb is synchronous).  Callers that need
/// async can wrap calls in `tokio::task::spawn_blocking`.
pub struct CacheStore {
    config: CacheConfig,
    clock: Arc<dyn Clock>,
    /// In-memory LRU map.  `HashMap` with a simple insertion-order eviction
    /// is sufficient for the v1 `max_in_memory_entries` budget; a proper LRU
    /// is a future optimisation.
    mem: Mutex<HashMap<Vec<u8>, InMemoryEntry>>,
    /// `redb` database handle.  `None` in unit tests that skip the disk layer.
    db: Option<Arc<Database>>,
}

impl CacheStore {
    /// Open a `redb` database at `path` and return a shared `CacheHandle`.
    pub fn open(path: &std::path::Path, config: CacheConfig) -> Result<CacheHandle, AppError> {
        let db = open_or_recreate_redb(path).map_err(|e| AppError::Internal {
            trace_id: format!("redb open failed: {e}"),
        })?;
        // Ensure the table exists.
        let write_txn = db.begin_write().map_err(|e| AppError::Internal {
            trace_id: format!("redb begin_write failed: {e}"),
        })?;
        {
            write_txn
                .open_table(CACHE_TABLE)
                .map_err(|e| AppError::Internal {
                    trace_id: format!("redb open_table failed: {e}"),
                })?;
        }
        write_txn.commit().map_err(|e| AppError::Internal {
            trace_id: format!("redb commit failed: {e}"),
        })?;

        Ok(Arc::new(Self {
            config,
            clock: Arc::new(SystemClock),
            mem: Mutex::new(HashMap::new()),
            db: Some(Arc::new(db)),
        }))
    }

    /// In-memory only store — used in tests that do not exercise the disk layer.
    pub fn in_memory(config: CacheConfig) -> CacheHandle {
        Arc::new(Self {
            config,
            clock: Arc::new(SystemClock),
            mem: Mutex::new(HashMap::new()),
            db: None,
        })
    }

    /// Constructor with an injected clock for tests.
    pub fn new_with_clock(
        config: CacheConfig,
        clock: Arc<dyn Clock>,
        db: Option<Arc<Database>>,
    ) -> CacheHandle {
        Arc::new(Self {
            config,
            clock,
            mem: Mutex::new(HashMap::new()),
            db,
        })
    }

    // -----------------------------------------------------------------------
    // db
    // -----------------------------------------------------------------------

    /// Return the underlying `redb::Database` handle, if one was opened.
    ///
    /// Used by `MultipartTable` (task 32) to share the same file handle
    /// rather than opening `cache.redb` a second time.
    pub fn db(&self) -> Option<Arc<Database>> {
        self.db.clone()
    }

    // -----------------------------------------------------------------------
    // get
    // -----------------------------------------------------------------------

    /// Read a cached value.
    ///
    /// # Validation gate (AC-8)
    ///
    /// If `profile_validation_ts` is `None`, the profile has not been
    /// validated in the current session and cached data MUST NOT be surfaced.
    /// The gate returns `Ok(None)` without reading from disk.
    pub fn get<T: DeserializeOwned>(
        &self,
        key: &CacheKey,
        profile_validation_ts: Option<i64>,
    ) -> Result<Option<CacheRead<T>>, AppError> {
        // --- AC-8 validation gate -------------------------------------------
        if profile_validation_ts.is_none() {
            return Ok(None);
        }

        let raw_key = key.serialize_key();
        let now = self.clock.now_secs();

        // --- in-memory lookup -----------------------------------------------
        if let Some(entry) = self.mem.lock().unwrap().get(&raw_key).cloned() {
            return Self::classify_entry_bytes::<T>(
                &entry.raw,
                now,
                entry.expires_at,
                entry.swr_deadline,
            );
        }

        // --- disk lookup ----------------------------------------------------
        if let Some(db) = &self.db {
            let read_txn = db.begin_read().map_err(|e| AppError::Internal {
                trace_id: format!("redb begin_read failed: {e}"),
            })?;
            let table = read_txn
                .open_table(CACHE_TABLE)
                .map_err(|e| AppError::Internal {
                    trace_id: format!("redb open_table failed: {e}"),
                })?;
            if let Some(bytes_guard) =
                table
                    .get(raw_key.as_slice())
                    .map_err(|e| AppError::Internal {
                        trace_id: format!("redb get failed: {e}"),
                    })?
            {
                let bytes: Vec<u8> = bytes_guard.value().to_vec();
                // Parse the stored CacheEntry<Value> to extract timing metadata.
                let entry: CacheEntry<Value> =
                    serde_json::from_slice(&bytes).map_err(|e| AppError::Internal {
                        trace_id: format!("cache deserialise failed: {e}"),
                    })?;
                let swr_deadline = entry.expires_at + self.config.swr_window_secs as i64;

                // Populate in-memory cache.
                self.mem.lock().unwrap().insert(
                    raw_key,
                    InMemoryEntry {
                        raw: bytes.clone(),
                        expires_at: entry.expires_at,
                        swr_deadline,
                    },
                );

                return Self::classify_entry_bytes::<T>(
                    &bytes,
                    now,
                    entry.expires_at,
                    swr_deadline,
                );
            }
        }

        Ok(None)
    }

    // -----------------------------------------------------------------------
    // put
    // -----------------------------------------------------------------------

    /// Write a value into both the in-memory and disk layers.
    pub fn put<T: Serialize>(
        &self,
        key: &CacheKey,
        value: T,
        ttl: Option<Duration>,
    ) -> Result<(), AppError> {
        let now = self.clock.now_secs();
        let ttl_secs = ttl
            .map(|d| d.as_secs())
            .unwrap_or(self.config.default_ttl_secs) as i64;
        let expires_at = now + ttl_secs;
        let swr_deadline = expires_at + self.config.swr_window_secs as i64;

        // Serialise value to JSON Value first so we can store it generically.
        let json_value: Value = serde_json::to_value(&value).map_err(|e| AppError::Internal {
            trace_id: format!("cache serialise failed: {e}"),
        })?;

        let entry: CacheEntry<Value> = CacheEntry {
            value: json_value,
            fetched_at: now,
            expires_at,
            etag: None,
        };

        let bytes = serde_json::to_vec(&entry).map_err(|e| AppError::Internal {
            trace_id: format!("cache serialise failed: {e}"),
        })?;

        let raw_key = key.serialize_key();

        // In-memory with naïve eviction: drop oldest when at capacity.
        {
            let mut mem = self.mem.lock().unwrap();
            if mem.len() >= self.config.max_in_memory_entries && !mem.contains_key(&raw_key) {
                // Remove an arbitrary entry (simplest eviction for v1).
                if let Some(oldest_key) = mem.keys().next().cloned() {
                    mem.remove(&oldest_key);
                }
            }
            mem.insert(
                raw_key.clone(),
                InMemoryEntry {
                    raw: bytes.clone(),
                    expires_at,
                    swr_deadline,
                },
            );
        }

        // Disk.
        if let Some(db) = &self.db {
            let write_txn = db.begin_write().map_err(|e| AppError::Internal {
                trace_id: format!("redb begin_write failed: {e}"),
            })?;
            {
                let mut table =
                    write_txn
                        .open_table(CACHE_TABLE)
                        .map_err(|e| AppError::Internal {
                            trace_id: format!("redb open_table failed: {e}"),
                        })?;
                table
                    .insert(raw_key.as_slice(), bytes.as_slice())
                    .map_err(|e| AppError::Internal {
                        trace_id: format!("redb insert failed: {e}"),
                    })?;
            }
            write_txn.commit().map_err(|e| AppError::Internal {
                trace_id: format!("redb commit failed: {e}"),
            })?;
        }

        Ok(())
    }

    // -----------------------------------------------------------------------
    // invalidate
    // -----------------------------------------------------------------------

    /// Remove a single entry from both memory and disk.
    pub fn invalidate(&self, key: &CacheKey) {
        let raw_key = key.serialize_key();
        self.mem.lock().unwrap().remove(&raw_key);

        if let Some(db) = &self.db {
            if let Ok(txn) = db.begin_write() {
                if let Ok(mut table) = txn.open_table(CACHE_TABLE) {
                    let _ = table.remove(raw_key.as_slice());
                }
                let _ = txn.commit();
            }
        }
    }

    // -----------------------------------------------------------------------
    // invalidate_profile
    // -----------------------------------------------------------------------

    /// Remove all entries scoped to `profile` from both layers.
    ///
    /// In-memory: O(n) linear scan — acceptable for `max_in_memory_entries`.
    /// Disk: full table scan, removing matching keys in one transaction.
    pub fn invalidate_profile(&self, profile: &crate::ids::ProfileId) {
        // `prefix` matches keys like `objects\x00<profile>\x00...`.
        // `profile_tag` matches the `Buckets` key which ends with `\x00<profile>`.
        let prefix = format!("\x00{}\x00", profile.as_str());
        let profile_tag = format!("\x00{}", profile.as_str());

        // Memory: O(n) linear scan.
        {
            let mut mem = self.mem.lock().unwrap();
            mem.retain(|k, _| {
                let s = String::from_utf8_lossy(k);
                !s.contains(&prefix) && !s.ends_with(profile_tag.as_str())
            });
        }

        // Disk.
        if let Some(db) = &self.db {
            if let Ok(txn) = db.begin_write() {
                if let Ok(mut table) = txn.open_table(CACHE_TABLE) {
                    // Collect keys to remove (we cannot remove while iterating
                    // in some redb versions, so collect first).
                    let to_remove: Vec<Vec<u8>> = table
                        .iter()
                        .ok()
                        .map(|iter| {
                            iter.filter_map(|r| {
                                let (k, _) = r.ok()?;
                                let bytes: &[u8] = k.value();
                                let s = String::from_utf8_lossy(bytes);
                                if s.contains(&prefix) || s.ends_with(profile_tag.as_str()) {
                                    Some(bytes.to_vec())
                                } else {
                                    None
                                }
                            })
                            .collect()
                        })
                        .unwrap_or_default();

                    for k in to_remove {
                        let _ = table.remove(k.as_slice());
                    }
                }
                let _ = txn.commit();
            }
        }
    }

    // -----------------------------------------------------------------------
    // clear_all
    // -----------------------------------------------------------------------

    /// Wipe every cached entry from both layers.
    pub fn clear_all(&self) {
        self.mem.lock().unwrap().clear();

        if let Some(db) = &self.db {
            if let Ok(txn) = db.begin_write() {
                if let Ok(mut table) = txn.open_table(CACHE_TABLE) {
                    // Drain by iterating the full table.
                    let keys: Vec<Vec<u8>> = table
                        .iter()
                        .ok()
                        .map(|iter| {
                            iter.filter_map(|r| {
                                let (k, _) = r.ok()?;
                                Some(k.value().to_vec())
                            })
                            .collect()
                        })
                        .unwrap_or_default();
                    for k in keys {
                        let _ = table.remove(k.as_slice());
                    }
                }
                let _ = txn.commit();
            }
        }
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    /// Deserialise raw bytes and classify freshness based on the current time.
    fn classify_entry_bytes<T: DeserializeOwned>(
        raw: &[u8],
        now: i64,
        expires_at: i64,
        swr_deadline: i64,
    ) -> Result<Option<CacheRead<T>>, AppError> {
        let entry: CacheEntry<Value> =
            serde_json::from_slice(raw).map_err(|e| AppError::Internal {
                trace_id: format!("cache deserialise failed: {e}"),
            })?;

        let freshness = if now < expires_at {
            Freshness::Fresh
        } else if now < swr_deadline {
            Freshness::Stale
        } else {
            // Beyond the SWR window — entry is logically gone.
            return Ok(None);
        };

        let value: T = serde_json::from_value(entry.value).map_err(|e| AppError::Internal {
            trace_id: format!("cache value deserialise failed: {e}"),
        })?;

        Ok(Some(CacheRead { value, freshness }))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::{BucketId, ObjectKey, ProfileId};

    use std::sync::Arc;

    fn test_store(clock: Arc<dyn Clock>) -> CacheHandle {
        let config = CacheConfig {
            default_ttl_secs: 10,
            swr_window_secs: 20,
            max_in_memory_entries: 1024,
        };
        CacheStore::new_with_clock(config, clock, None)
    }

    fn profile_a() -> ProfileId {
        ProfileId::new("profile-a")
    }
    fn profile_b() -> ProfileId {
        ProfileId::new("profile-b")
    }

    // -----------------------------------------------------------------------
    // AC-8 verbatim test
    // -----------------------------------------------------------------------

    #[test]
    fn validation_gate_blocks_read_through_for_unvalidated_profile_in_current_session() {
        let clock = MockClock::new(1_000_000);
        let store = test_store(clock.clone());

        let key = CacheKey::Buckets(profile_a());

        // Put an entry that would normally be fresh.
        store
            .put(&key, serde_json::json!(["bucket-1", "bucket-2"]), None)
            .unwrap();

        // Reading with profile_validation_ts = None must return Ok(None).
        let result: Option<CacheRead<serde_json::Value>> = store.get(&key, None).unwrap();

        assert!(
            result.is_none(),
            "cache must not serve data for an unvalidated profile (AC-8)"
        );
    }

    // -----------------------------------------------------------------------
    // TTL expiry
    // -----------------------------------------------------------------------

    #[test]
    fn ttl_expiry_returns_stale_then_missing() {
        let clock = MockClock::new(1_000_000);
        let store = test_store(clock.clone());

        let key = CacheKey::Buckets(profile_a());
        let validated = Some(999_999_i64);

        store.put(&key, serde_json::json!(42u32), None).unwrap();

        // Within TTL (10 s) → Fresh.
        let read: CacheRead<serde_json::Value> = store
            .get(&key, validated)
            .unwrap()
            .expect("should be present");
        assert_eq!(read.freshness, Freshness::Fresh);

        // Advance past TTL but within SWR window (10 < 12 < 30).
        clock.advance(12);
        let read: CacheRead<serde_json::Value> = store
            .get(&key, validated)
            .unwrap()
            .expect("should still be present as stale");
        assert_eq!(read.freshness, Freshness::Stale);

        // Advance past SWR window (TTL=10, SWR=20, total=30 from write).
        // We've advanced 12 already; need 18 more to clear 30 total.
        clock.advance(19);
        let missing: Option<CacheRead<serde_json::Value>> = store.get(&key, validated).unwrap();
        assert!(
            missing.is_none(),
            "entry must be missing after SWR window expires"
        );
    }

    // -----------------------------------------------------------------------
    // SWR stale read
    // -----------------------------------------------------------------------

    #[test]
    fn swr_stale_read_returns_value_between_ttl_and_swr_window() {
        let clock = MockClock::new(2_000_000);
        let store = test_store(clock.clone());

        let key = CacheKey::Objects {
            profile: profile_a(),
            bucket: BucketId::new("my-bucket"),
            prefix: "photos/".to_string(),
        };
        let validated = Some(1_999_999_i64);
        let payload = serde_json::json!({ "items": ["a.jpg", "b.jpg"] });

        store.put(&key, payload.clone(), None).unwrap();

        // Advance into the SWR window (TTL=10, advance 15 → stale).
        clock.advance(15);

        let read: CacheRead<serde_json::Value> = store
            .get(&key, validated)
            .unwrap()
            .expect("stale entry must still be returned");

        assert_eq!(
            read.freshness,
            Freshness::Stale,
            "should be Stale in SWR window"
        );
        assert_eq!(
            read.value, payload,
            "stale value must equal the written payload"
        );
    }

    // -----------------------------------------------------------------------
    // Per-profile invalidation
    // -----------------------------------------------------------------------

    #[test]
    fn per_profile_invalidation_removes_profile_a_leaves_profile_b() {
        let clock = MockClock::new(3_000_000);
        let store = test_store(clock.clone());
        let validated_a = Some(2_999_999_i64);
        let validated_b = Some(2_999_999_i64);

        // 3 entries for profile A.
        let key_a1 = CacheKey::Buckets(profile_a());
        let key_a2 = CacheKey::Objects {
            profile: profile_a(),
            bucket: BucketId::new("bkt-a"),
            prefix: String::new(),
        };
        let key_a3 = CacheKey::ObjectHead {
            profile: profile_a(),
            bucket: BucketId::new("bkt-a"),
            key: ObjectKey::new("file.txt"),
        };
        // 1 entry for profile B.
        let key_b1 = CacheKey::Buckets(profile_b());

        store.put(&key_a1, serde_json::json!("a1"), None).unwrap();
        store.put(&key_a2, serde_json::json!("a2"), None).unwrap();
        store.put(&key_a3, serde_json::json!("a3"), None).unwrap();
        store.put(&key_b1, serde_json::json!("b1"), None).unwrap();

        // Invalidate all of profile A.
        store.invalidate_profile(&profile_a());

        // Profile A entries must be gone.
        assert!(
            store
                .get::<serde_json::Value>(&key_a1, validated_a)
                .unwrap()
                .is_none(),
            "key_a1 must be removed"
        );
        assert!(
            store
                .get::<serde_json::Value>(&key_a2, validated_a)
                .unwrap()
                .is_none(),
            "key_a2 must be removed"
        );
        assert!(
            store
                .get::<serde_json::Value>(&key_a3, validated_a)
                .unwrap()
                .is_none(),
            "key_a3 must be removed"
        );

        // Profile B entry must survive.
        let b1 = store
            .get::<serde_json::Value>(&key_b1, validated_b)
            .unwrap();
        assert!(b1.is_some(), "key_b1 must survive profile A invalidation");
    }

    // -----------------------------------------------------------------------
    // redb round-trip
    // -----------------------------------------------------------------------

    #[test]
    fn redb_round_trip_survives_store_reopen() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("cache.redb");
        let config = CacheConfig {
            default_ttl_secs: 300,
            swr_window_secs: 600,
            max_in_memory_entries: 1024,
        };
        let key = CacheKey::Buckets(ProfileId::new("redb-profile"));
        let payload = serde_json::json!(["bucket-x", "bucket-y"]);
        let validated = Some(0_i64);

        // Write with the first store instance.
        {
            let store = CacheStore::open(&db_path, config.clone()).expect("open store");
            store.put(&key, payload.clone(), None).unwrap();
        }

        // Reopen — in-memory is cold; must fall through to redb.
        {
            let store = CacheStore::open(&db_path, config).expect("reopen store");
            let read: CacheRead<serde_json::Value> = store
                .get(&key, validated)
                .unwrap()
                .expect("entry must survive reopen");
            assert_eq!(read.freshness, Freshness::Fresh);
            assert_eq!(read.value, payload);
        }
    }
}
