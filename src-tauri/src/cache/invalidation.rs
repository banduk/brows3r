//! Mutation-triggered invalidation helpers.
//!
//! These pure helpers contain the invalidation logic for common S3 mutations.
//! The actual call sites (S3 commands) wire them in during later tasks.
//!
//! # OCP
//!
//! Adding a new mutation type: add one more `pub fn on_*_mutation` that calls
//! `store.invalidate(...)` for the affected `CacheKey` variants.  Nothing else
//! changes.

use crate::ids::{BucketId, ProfileId};

use super::store::CacheHandle;
use super::CacheKey;

/// Invalidate `Objects` and `ObjectHead` keys for the affected scope when an
/// object is created, updated, deleted, or moved within `bucket/prefix`.
///
/// Callers pass the exact `prefix` that was mutated.  If the mutation spans
/// multiple prefixes (e.g. a recursive delete), callers are responsible for
/// calling this helper once per distinct prefix.
pub fn on_object_mutation(
    profile: &ProfileId,
    bucket: &BucketId,
    prefix: &str,
    object_key: Option<&crate::ids::ObjectKey>,
    store: &CacheHandle,
) {
    // Invalidate the listing for this prefix.
    store.invalidate(&CacheKey::Objects {
        profile: profile.clone(),
        bucket: bucket.clone(),
        prefix: prefix.to_string(),
    });

    // If the caller supplies a specific object key, also invalidate the
    // per-object head entry.
    if let Some(key) = object_key {
        store.invalidate(&CacheKey::ObjectHead {
            profile: profile.clone(),
            bucket: bucket.clone(),
            key: key.clone(),
        });
        // Invalidate the inspector entry for this specific object.
        store.invalidate(&CacheKey::Inspector {
            profile: profile.clone(),
            bucket: bucket.clone(),
            key: Some(key.clone()),
        });
    }
}

/// Invalidate the `Buckets` listing for a profile when a bucket-level mutation
/// occurs (e.g. bucket created or deleted).
pub fn on_bucket_mutation(profile: &ProfileId, store: &CacheHandle) {
    store.invalidate(&CacheKey::Buckets(profile.clone()));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        cache::{
            store::{CacheStore, MockClock},
            CacheConfig,
        },
        ids::{BucketId, ObjectKey, ProfileId},
    };

    fn make_store() -> CacheHandle {
        CacheStore::new_with_clock(CacheConfig::default(), MockClock::new(1_000_000), None)
    }

    #[test]
    fn on_object_mutation_removes_objects_and_head_entries() {
        let store = make_store();
        let pid = ProfileId::new("p");
        let bid = BucketId::new("b");
        let key = ObjectKey::new("folder/file.txt");
        let validated = Some(0_i64);

        // Write both an Objects listing and an ObjectHead entry.
        let objects_key = CacheKey::Objects {
            profile: pid.clone(),
            bucket: bid.clone(),
            prefix: "folder/".to_string(),
        };
        let head_key = CacheKey::ObjectHead {
            profile: pid.clone(),
            bucket: bid.clone(),
            key: key.clone(),
        };

        store
            .put(&objects_key, serde_json::json!(["file.txt"]), None)
            .unwrap();
        store
            .put(&head_key, serde_json::json!({"size": 42}), None)
            .unwrap();

        // Invalidate after mutation.
        on_object_mutation(&pid, &bid, "folder/", Some(&key), &store);

        assert!(
            store
                .get::<serde_json::Value>(&objects_key, validated)
                .unwrap()
                .is_none(),
            "Objects entry must be invalidated"
        );
        assert!(
            store
                .get::<serde_json::Value>(&head_key, validated)
                .unwrap()
                .is_none(),
            "ObjectHead entry must be invalidated"
        );
    }

    #[test]
    fn on_bucket_mutation_removes_bucket_list_entry() {
        let store = make_store();
        let pid = ProfileId::new("p");
        let validated = Some(0_i64);

        let buckets_key = CacheKey::Buckets(pid.clone());
        store
            .put(&buckets_key, serde_json::json!(["b1", "b2"]), None)
            .unwrap();

        on_bucket_mutation(&pid, &store);

        assert!(
            store
                .get::<serde_json::Value>(&buckets_key, validated)
                .unwrap()
                .is_none(),
            "Buckets entry must be invalidated after bucket mutation"
        );
    }
}
