//! Authoritative SWR cache — types and configuration.
//!
//! # Layers
//!
//! - `mod.rs`          — `CacheKey`, `CacheEntry<T>`, `CacheConfig`, `Freshness`.
//! - `store.rs`        — `CacheStore`: in-memory LRU + `redb` disk backend.
//! - `invalidation.rs` — mutation-triggered invalidation helpers.
//! - `capability.rs`   — stub placeholder for the capability cache (task 20).
//!
//! # OCP
//!
//! - Add a new cached resource: add a `CacheKey` variant + one arm in
//!   `serialize_key`. Nothing else changes.
//! - Add a new validation gate: add one `Option` arg to `store::get` and one
//!   check at the top of the function. Existing call sites are unaffected.
//! - Swap the KV backend: replace the `redb`-specific code inside `CacheStore`
//!   without touching any caller.

pub mod capability;
pub mod invalidation;
pub mod store;

pub use capability::{
    CapabilityCache, CapabilityClass, CapabilityHandle, CapabilityMap, CapabilityRecord, ClearScope,
};

use serde::{Deserialize, Serialize};

use crate::ids::{BucketId, ObjectKey, ProfileId};

// ---------------------------------------------------------------------------
// CacheKey
// ---------------------------------------------------------------------------

/// Discriminated key for every entity the cache can hold.
///
/// `serialize_key` produces a stable, prefix-safe byte sequence so that
/// per-profile invalidation can iterate by prefix without deserialising values.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum CacheKey {
    /// Bucket list for a profile.
    Buckets(ProfileId),
    /// Object listing at a prefix inside a bucket.
    Objects {
        profile: ProfileId,
        bucket: BucketId,
        prefix: String,
    },
    /// Single-object `HeadObject` result.
    ObjectHead {
        profile: ProfileId,
        bucket: BucketId,
        key: ObjectKey,
    },
    /// Inspector panel data (bucket or object properties).
    Inspector {
        profile: ProfileId,
        bucket: BucketId,
        key: Option<ObjectKey>,
    },
    /// Capability classification result (allowed / denied / unsupported).
    Capability {
        profile: ProfileId,
        bucket: Option<BucketId>,
        op: String,
    },
}

impl CacheKey {
    /// Stable byte representation used as the `redb` table key and as the
    /// in-memory `HashMap` lookup key serialisation.
    ///
    /// Format: `<variant_tag>/<profile_id>[/<extra...>]`
    /// Fields are separated by `\x00` so no URL-encoding is needed and the
    /// keys are prefix-scannable for per-profile invalidation.
    pub fn serialize_key(&self) -> Vec<u8> {
        let s = match self {
            CacheKey::Buckets(pid) => {
                format!("buckets\x00{}", pid.as_str())
            }
            CacheKey::Objects {
                profile,
                bucket,
                prefix,
            } => {
                format!(
                    "objects\x00{}\x00{}\x00{}",
                    profile.as_str(),
                    bucket.as_str(),
                    prefix
                )
            }
            CacheKey::ObjectHead {
                profile,
                bucket,
                key,
            } => {
                format!(
                    "object_head\x00{}\x00{}\x00{}",
                    profile.as_str(),
                    bucket.as_str(),
                    key.as_str()
                )
            }
            CacheKey::Inspector {
                profile,
                bucket,
                key,
            } => {
                let key_part = key.as_ref().map(|k| k.as_str()).unwrap_or("");
                format!(
                    "inspector\x00{}\x00{}\x00{}",
                    profile.as_str(),
                    bucket.as_str(),
                    key_part
                )
            }
            CacheKey::Capability {
                profile,
                bucket,
                op,
            } => {
                let bucket_part = bucket.as_ref().map(|b| b.as_str()).unwrap_or("");
                format!(
                    "capability\x00{}\x00{}\x00{}",
                    profile.as_str(),
                    bucket_part,
                    op
                )
            }
        };
        s.into_bytes()
    }

    /// Return the `ProfileId` this key is scoped to.
    pub fn profile_id(&self) -> &ProfileId {
        match self {
            CacheKey::Buckets(pid) => pid,
            CacheKey::Objects { profile, .. } => profile,
            CacheKey::ObjectHead { profile, .. } => profile,
            CacheKey::Inspector { profile, .. } => profile,
            CacheKey::Capability { profile, .. } => profile,
        }
    }
}

// ---------------------------------------------------------------------------
// CacheEntry<T>
// ---------------------------------------------------------------------------

/// A cached value together with its validity metadata.
///
/// `T` is the value type; when stored on disk the bytes are
/// `serde_json::to_vec(CacheEntry<serde_json::Value>)`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheEntry<T> {
    /// The cached value.
    pub value: T,
    /// Unix timestamp (seconds) when the entry was written.
    pub fetched_at: i64,
    /// Unix timestamp (seconds) after which the entry is considered expired
    /// (i.e. `fetched_at + ttl`).  A read between `expires_at` and
    /// `expires_at + swr_window` returns `Freshness::Stale`.
    pub expires_at: i64,
    /// ETag of the S3 object at fetch time, if available.
    pub etag: Option<String>,
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

/// Freshness classification returned by `CacheStore::get`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Freshness {
    /// Within TTL — safe to use directly.
    Fresh,
    /// Past TTL but within the SWR window — return to caller while the
    /// background revalidation (wired in later tasks) fetches a fresh copy.
    Stale,
    /// Past the SWR window; the caller must fetch a fresh value before rendering.
    Missing,
}

// ---------------------------------------------------------------------------
// CacheRead<T>
// ---------------------------------------------------------------------------

/// Return type of `CacheStore::get`: value + freshness classification.
pub struct CacheRead<T> {
    pub value: T,
    pub freshness: Freshness,
}

// ---------------------------------------------------------------------------
// CacheConfig
// ---------------------------------------------------------------------------

/// Runtime-configurable cache parameters.
///
/// Loaded from `Settings` at startup; `Default` reflects the v1 proposal
/// values so callers can construct a sensible default without a settings handle.
#[derive(Debug, Clone)]
pub struct CacheConfig {
    /// Time-to-live in seconds (default 30, from `Settings.cache_ttl_secs`).
    pub default_ttl_secs: u64,
    /// How long stale data may be served while background revalidation runs.
    /// Default 60 s — twice the default TTL so there is always a window
    /// without a blocking S3 fetch during normal browsing.
    pub swr_window_secs: u64,
    /// Maximum number of entries kept in the in-memory LRU map.
    /// Eviction is LRU; disk is unaffected by eviction.
    pub max_in_memory_entries: usize,
}

impl Default for CacheConfig {
    fn default() -> Self {
        Self {
            default_ttl_secs: 30,
            swr_window_secs: 60,
            max_in_memory_entries: 1024,
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::{BucketId, ObjectKey, ProfileId};

    #[test]
    fn serialize_key_buckets_is_stable() {
        let pid = ProfileId::new("p1");
        let key = CacheKey::Buckets(pid.clone());
        let bytes = key.serialize_key();
        assert!(bytes.starts_with(b"buckets\x00"));
        // Idempotent
        assert_eq!(key.serialize_key(), bytes);
    }

    #[test]
    fn serialize_key_objects_includes_all_fields() {
        let key = CacheKey::Objects {
            profile: ProfileId::new("prof"),
            bucket: BucketId::new("bkt"),
            prefix: "folder/".to_string(),
        };
        let s = String::from_utf8(key.serialize_key()).unwrap();
        assert!(s.contains("objects"));
        assert!(s.contains("prof"));
        assert!(s.contains("bkt"));
        assert!(s.contains("folder/"));
    }

    #[test]
    fn serialize_key_inspector_none_key_is_stable() {
        let key = CacheKey::Inspector {
            profile: ProfileId::new("p"),
            bucket: BucketId::new("b"),
            key: None,
        };
        let bytes = key.serialize_key();
        let with_key = CacheKey::Inspector {
            profile: ProfileId::new("p"),
            bucket: BucketId::new("b"),
            key: Some(ObjectKey::new("obj.txt")),
        };
        assert_ne!(bytes, with_key.serialize_key());
    }

    #[test]
    fn serialize_key_capability_none_bucket_is_stable() {
        let k1 = CacheKey::Capability {
            profile: ProfileId::new("p"),
            bucket: None,
            op: "ListBuckets".to_string(),
        };
        let k2 = CacheKey::Capability {
            profile: ProfileId::new("p"),
            bucket: Some(BucketId::new("bkt")),
            op: "ListBuckets".to_string(),
        };
        assert_ne!(k1.serialize_key(), k2.serialize_key());
    }

    #[test]
    fn profile_id_accessor_returns_correct_profile() {
        let pid = ProfileId::new("my-profile");
        let key = CacheKey::Buckets(pid.clone());
        assert_eq!(key.profile_id(), &pid);

        let key2 = CacheKey::Objects {
            profile: pid.clone(),
            bucket: BucketId::new("b"),
            prefix: String::new(),
        };
        assert_eq!(key2.profile_id(), &pid);
    }

    #[test]
    fn cache_config_defaults_match_v1_spec() {
        let cfg = CacheConfig::default();
        assert_eq!(cfg.default_ttl_secs, 30);
        assert_eq!(cfg.swr_window_secs, 60);
        assert_eq!(cfg.max_in_memory_entries, 1024);
    }
}
