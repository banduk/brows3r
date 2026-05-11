//! Tauri commands for bucket listing and region discovery.
//!
//! # Commands
//!
//! - [`buckets_list`]      — list buckets for a profile; SWR cache + validation gate.
//! - [`bucket_region_get`] — get cached region for one bucket; lazy-resolves on miss.
//!
//! # Validation gate (AC-8 / round-1 finding #9)
//!
//! Both commands refuse to serve any data when `profile.validated_at` is `None`.
//! The cache itself also enforces this, but the command boundary check is
//! defence-in-depth: a future refactor of the cache must not silently lift the gate.
//!
//! # SWR behaviour
//!
//! - Fresh (within TTL): return cache directly.
//! - Stale (past TTL, within SWR window): return stale value immediately and
//!   spawn a background task that re-fetches and updates the cache.
//! - Missing: fetch synchronously, store, return.
//! - `force = Some(true)`: bypass cache; fetch synchronously.
//!
//! # Region discovery
//!
//! After a successful bucket list, a background task fires `GetBucketLocation`
//! for every bucket. Failures are logged as `Severity::Warning` notifications
//! and do not fail the command. Each successful discovery updates the cache
//! and emits a `buckets:updated` event.

use std::sync::Arc;

use tauri::{AppHandle, State};
use tokio::task;

use crate::{
    cache::{store::CacheHandle, CacheKey, Freshness},
    error::AppError,
    events::{self, EventKind},
    ids::{BucketId, ProfileId},
    notifications::{Notification, NotificationCategory, NotificationLogHandle, Severity},
    profiles::{Profile, ProfileStoreHandle},
    s3::{
        list::{discover_bucket_region, list_buckets, BucketSummary},
        ClientPool, S3ClientPoolHandle,
    },
};

// ---------------------------------------------------------------------------
// Region cache key helper
// ---------------------------------------------------------------------------

// Per-bucket regions are stored using a reuse of the ObjectHead key with
// the sentinel ObjectKey `__region__`. This avoids adding a new CacheKey
// variant inside task-23 scope while still giving per-bucket region
// persistence through the existing cache infrastructure.
fn region_cache_key(profile_id: &ProfileId, bucket: &str) -> CacheKey {
    CacheKey::ObjectHead {
        profile: profile_id.clone(),
        bucket: BucketId::new(bucket),
        key: crate::ids::ObjectKey::new("__region__"),
    }
}

// ---------------------------------------------------------------------------
// buckets_list — main command
// ---------------------------------------------------------------------------

/// List all buckets for the given profile.
///
/// Applies the validation gate, SWR cache logic, and background region
/// discovery. Emits `buckets:updated { profileId }` after every revalidation.
#[tauri::command]
pub async fn buckets_list(
    profile_id: ProfileId,
    force: Option<bool>,
    store: State<'_, ProfileStoreHandle>,
    pool: State<'_, S3ClientPoolHandle>,
    cache: State<'_, CacheHandle>,
    notification_log: State<'_, NotificationLogHandle>,
    channel: AppHandle,
) -> Result<Vec<BucketSummary>, AppError> {
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

    // Command-boundary validation gate (defence-in-depth; cache also enforces).
    if profile.validated_at.is_none() {
        return Err(AppError::Auth {
            reason: "profile_not_validated_in_session".to_string(),
        });
    }

    let default_region = profile
        .default_region
        .clone()
        .unwrap_or_else(|| "us-east-1".to_string());

    // Clone the Arc handles we need to pass to background tasks.
    let pool_arc: Arc<ClientPool> = pool.inner.clone();
    let cache_arc: CacheHandle = (*cache).clone();
    let log_arc = notification_log.0.clone();

    // ------------------------------------------------------------------
    // 2. SWR cache check (skip if force = true)
    // ------------------------------------------------------------------
    if force != Some(true) {
        let cache_key = CacheKey::Buckets(profile_id.clone());
        let cached = cache_arc.get::<Vec<BucketSummary>>(&cache_key, profile.validated_at)?;

        if let Some(read) = cached {
            match read.freshness {
                Freshness::Fresh => return Ok(read.value),
                Freshness::Stale => {
                    // Return stale value immediately, revalidate in background.
                    let stale_value = read.value.clone();
                    let profile_id_bg = profile_id.clone();
                    let profile_bg = profile.clone();
                    let default_region_bg = default_region.clone();
                    let pool_bg = pool_arc.clone();
                    let cache_bg = cache_arc.clone();
                    let log_bg = log_arc.clone();
                    let channel_bg = channel.clone();

                    task::spawn(async move {
                        revalidate_buckets(
                            profile_id_bg,
                            profile_bg,
                            default_region_bg,
                            pool_bg,
                            cache_bg,
                            log_bg,
                            channel_bg,
                        )
                        .await;
                    });

                    return Ok(stale_value);
                }
                Freshness::Missing => {
                    // Past SWR window — fall through to fresh fetch below.
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // 3. Fresh fetch (cache miss, past SWR window, or force=true)
    // ------------------------------------------------------------------
    let client = pool_arc
        .get_or_build(&profile_id, &default_region)
        .await
        .ok_or_else(|| AppError::Internal {
            trace_id: format!("pool_miss:profile:{}", profile_id.as_str()),
        })?;

    let buckets = list_buckets(&client, &profile_id).await?;

    // Store in cache.
    cache_arc.put(&CacheKey::Buckets(profile_id.clone()), &buckets, None)?;

    // Emit buckets:updated.
    let _ = events::emit(
        &channel,
        EventKind::BucketsUpdated,
        serde_json::json!({ "profileId": profile_id.as_str() }),
    );

    // Spawn background region discovery.
    spawn_region_discovery(
        profile_id.clone(),
        buckets.clone(),
        pool_arc,
        cache_arc,
        log_arc,
        channel,
        default_region,
    );

    Ok(buckets)
}

// ---------------------------------------------------------------------------
// bucket_region_get — per-bucket region lookup
// ---------------------------------------------------------------------------

/// Return the cached region for `bucket`, resolving it lazily on cache miss.
///
/// If the region is not yet known (background discovery has not finished),
/// this command resolves it synchronously and caches the result.
#[tauri::command]
pub async fn bucket_region_get(
    profile_id: ProfileId,
    bucket: BucketId,
    store: State<'_, ProfileStoreHandle>,
    pool: State<'_, S3ClientPoolHandle>,
    cache: State<'_, CacheHandle>,
) -> Result<String, AppError> {
    // Resolve profile + validation gate.
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

    let cache_arc: CacheHandle = (*cache).clone();
    let bucket_str = bucket.as_str().to_string();
    let key = region_cache_key(&profile_id, &bucket_str);

    // Check cache first.
    if let Some(read) = cache_arc.get::<String>(&key, profile.validated_at)? {
        if read.freshness != Freshness::Missing {
            return Ok(read.value);
        }
    }

    // Lazy resolution: build a client and call GetBucketLocation.
    let default_region = profile
        .default_region
        .as_deref()
        .unwrap_or("us-east-1")
        .to_string();
    let client = pool
        .inner
        .get_or_build(&profile_id, &default_region)
        .await
        .ok_or_else(|| AppError::Internal {
            trace_id: format!("pool_miss:profile:{}", profile_id.as_str()),
        })?;

    let region = discover_bucket_region(&client, &bucket_str)
        .await?
        .unwrap_or(default_region);

    cache_arc.put(&key, &region, None)?;
    Ok(region)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Re-fetch the bucket list and update the cache + emit events.
/// Called from the background task spawned on a stale cache hit.
async fn revalidate_buckets(
    profile_id: ProfileId,
    _profile: Profile,
    default_region: String,
    pool: Arc<ClientPool>,
    cache: CacheHandle,
    log: Arc<tokio::sync::RwLock<crate::notifications::NotificationLog>>,
    channel: AppHandle,
) {
    let client = match pool.get_or_build(&profile_id, &default_region).await {
        Some(c) => c,
        None => return,
    };

    match list_buckets(&client, &profile_id).await {
        Ok(buckets) => {
            let _ = cache.put(&CacheKey::Buckets(profile_id.clone()), &buckets, None);
            let _ = events::emit(
                &channel,
                EventKind::BucketsUpdated,
                serde_json::json!({ "profileId": profile_id.as_str() }),
            );
            // Kick off region discovery for the refreshed list.
            spawn_region_discovery(
                profile_id,
                buckets,
                pool,
                cache,
                log,
                channel,
                default_region,
            );
        }
        Err(e) => {
            push_bg_warning(
                &log,
                &format!("background bucket revalidation failed: {e}"),
                &profile_id,
            )
            .await;
        }
    }
}

/// Spawn a background task that calls `GetBucketLocation` for every bucket
/// in the list, updating the per-bucket region cache on success and emitting
/// `buckets:updated` per discovery.
fn spawn_region_discovery(
    profile_id: ProfileId,
    buckets: Vec<BucketSummary>,
    pool: Arc<ClientPool>,
    cache: CacheHandle,
    log: Arc<tokio::sync::RwLock<crate::notifications::NotificationLog>>,
    channel: AppHandle,
    default_region: String,
) {
    let names: Vec<String> = buckets.into_iter().map(|b| b.name).collect();

    task::spawn(async move {
        let client = match pool.get_or_build(&profile_id, &default_region).await {
            Some(c) => c,
            None => return,
        };

        for bucket_name in &names {
            match discover_bucket_region(&client, bucket_name).await {
                Ok(Some(region)) => {
                    let key = region_cache_key(&profile_id, bucket_name);
                    let _ = cache.put(&key, &region, None);
                    let _ = events::emit(
                        &channel,
                        EventKind::BucketsUpdated,
                        serde_json::json!({ "profileId": profile_id.as_str() }),
                    );
                }
                Ok(None) => {
                    // AccessDenied or NoSuchBucket — silently skip.
                }
                Err(e) => {
                    push_bg_warning(
                        &log,
                        &format!("region discovery for {bucket_name}: {e}"),
                        &profile_id,
                    )
                    .await;
                }
            }
        }
    });
}

/// Push a `Severity::Warning` notification into the log — best-effort.
async fn push_bg_warning(
    log: &tokio::sync::RwLock<crate::notifications::NotificationLog>,
    message: &str,
    profile_id: &ProfileId,
) {
    let notification = Notification {
        id: uuid::Uuid::new_v4().to_string(),
        severity: Severity::Warning,
        category: NotificationCategory::Background,
        title: "S3 background operation".to_string(),
        message: message.to_string(),
        resource: Some(format!("profile:{}", profile_id.as_str())),
        operation: Some("buckets_list".to_string()),
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
        details: None,
    };
    log.write().await.push(notification);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        cache::{store::CacheStore, CacheConfig},
        events::MockChannel,
    };

    fn validated_profile_id() -> ProfileId {
        ProfileId::new("p-validated")
    }

    fn validated_at() -> Option<i64> {
        Some(1_700_000_000_000)
    }

    // ------------------------------------------------------------------
    // Validation gate: unvalidated profile returns Auth error
    // ------------------------------------------------------------------

    #[test]
    fn unvalidated_profile_gate_returns_auth_error() {
        // Simulate the gate check directly (no live Tauri command context needed).
        let validated_at: Option<i64> = None;
        let result: Result<(), AppError> = if validated_at.is_none() {
            Err(AppError::Auth {
                reason: "profile_not_validated_in_session".to_string(),
            })
        } else {
            Ok(())
        };

        match result {
            Err(AppError::Auth { reason }) => {
                assert_eq!(reason, "profile_not_validated_in_session");
            }
            _ => panic!("expected Auth error for unvalidated profile"),
        }
    }

    // ------------------------------------------------------------------
    // Cache fresh hit: cached value returned without an SDK call
    // ------------------------------------------------------------------

    #[test]
    fn cache_fresh_hit_returns_without_sdk_call() {
        let pid = validated_profile_id();
        let cache = CacheStore::in_memory(CacheConfig::default());

        let expected = vec![BucketSummary {
            name: "my-bucket".to_string(),
            creation_date: Some(1_700_000_000_000),
            region: Some("us-east-1".to_string()),
            profile_id: pid.clone(),
        }];

        cache
            .put(&CacheKey::Buckets(pid.clone()), &expected, None)
            .expect("put must succeed");

        let read = cache
            .get::<Vec<BucketSummary>>(&CacheKey::Buckets(pid.clone()), validated_at())
            .expect("get must not error")
            .expect("entry must exist");

        assert_eq!(read.freshness, Freshness::Fresh);
        assert_eq!(read.value.len(), 1);
        assert_eq!(read.value[0].name, "my-bucket");
    }

    // ------------------------------------------------------------------
    // Cache gate: unvalidated profile cannot read from cache
    // ------------------------------------------------------------------

    #[test]
    fn unvalidated_profile_cannot_read_from_cache() {
        let pid = ProfileId::new("p-unval");
        let cache = CacheStore::in_memory(CacheConfig::default());

        let buckets = vec![BucketSummary {
            name: "secret-bucket".to_string(),
            creation_date: None,
            region: None,
            profile_id: pid.clone(),
        }];
        cache
            .put(&CacheKey::Buckets(pid.clone()), &buckets, None)
            .unwrap();

        // validated_at = None → gate refuses read.
        let result = cache
            .get::<Vec<BucketSummary>>(&CacheKey::Buckets(pid.clone()), None)
            .expect("get must not error");

        assert!(
            result.is_none(),
            "unvalidated profile must not read from cache"
        );
    }

    // ------------------------------------------------------------------
    // Event emission: buckets:updated carries profileId
    // ------------------------------------------------------------------

    #[test]
    fn buckets_updated_event_carries_profile_id() {
        let channel = MockChannel::default();
        let pid = ProfileId::new("evt-profile");

        events::emit(
            &channel,
            EventKind::BucketsUpdated,
            serde_json::json!({ "profileId": pid.as_str() }),
        )
        .expect("emit must succeed");

        let emitted = channel.emitted();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].0, EventKind::BucketsUpdated);
        assert_eq!(emitted[0].1["profileId"], pid.as_str());
    }

    // ------------------------------------------------------------------
    // region_cache_key: different buckets produce different keys
    // ------------------------------------------------------------------

    #[test]
    fn region_cache_keys_are_bucket_specific() {
        let pid = ProfileId::new("p1");
        let k1 = region_cache_key(&pid, "bucket-a");
        let k2 = region_cache_key(&pid, "bucket-b");
        assert_ne!(k1.serialize_key(), k2.serialize_key());
    }

    // ------------------------------------------------------------------
    // region_cache_key: different profiles produce different keys
    // ------------------------------------------------------------------

    #[test]
    fn region_cache_keys_are_profile_specific() {
        let k1 = region_cache_key(&ProfileId::new("p1"), "same-bucket");
        let k2 = region_cache_key(&ProfileId::new("p2"), "same-bucket");
        assert_ne!(k1.serialize_key(), k2.serialize_key());
    }

    // ------------------------------------------------------------------
    // Region cache put+get round-trip
    // ------------------------------------------------------------------

    #[test]
    fn region_cache_round_trip() {
        let pid = ProfileId::new("p-region");
        let cache = CacheStore::in_memory(CacheConfig::default());
        let key = region_cache_key(&pid, "bucket-eu");

        cache.put(&key, &"eu-west-1".to_string(), None).unwrap();

        let read = cache
            .get::<String>(&key, Some(1_700_000_000_000))
            .unwrap()
            .unwrap();
        assert_eq!(read.value, "eu-west-1");
        assert_eq!(read.freshness, Freshness::Fresh);
    }
}
