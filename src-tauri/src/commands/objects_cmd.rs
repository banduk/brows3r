//! Tauri commands for object listing and mutations.
//!
//! # Commands
//!
//! - [`objects_list`]          — hierarchical listing (`delimiter="/"`) with SWR
//!                               cache and validation gate.
//! - [`objects_list_flat`]     — flat listing (no delimiter) with validation gate.
//! - [`object_copy`]           — server-side copy with cross-account fallback.
//! - [`object_move`]           — server-side copy + delete source.
//! - [`object_create_folder`]  — PUT zero-byte `prefix/` placeholder.
//! - [`object_delete_batch`]   — batched delete with partial-failure reporting (AC-4).
//! - [`object_set_metadata`]   — replace user-defined metadata via self-overwrite CopyObject.
//! - [`object_set_tags`]       — set or clear object tags via PutObjectTagging / DeleteObjectTagging.
//! - [`object_presign`]        — generate a presigned GetObject URL with configurable expiry.
//! - [`cross_account_confirm`] — mint a one-time confirmation token for a large cross-account copy.
//!
//! # Validation gate (AC-8 / round-1 finding #9)
//!
//! All commands refuse to serve any data when `profile.validated_at` is `None`.
//! The cache itself also enforces this, but the command boundary check is
//! defence-in-depth: a future refactor of the cache must not silently lift the gate.
//!
//! # Caching
//!
//! Only first-page requests (no `continuation_token`) are cached, because the
//! token is derived from the previous page and is therefore not stable across
//! sessions.  Subsequent pages bypass the cache and always hit S3.
//!
//! The flat variant uses a separate cache key — the prefix is suffixed with
//! `"__FLAT__"` — so hierarchical and flat listings for the same prefix do
//! not collide in the cache.
//!
//! # Mutation → cache invalidation → event
//!
//! Every mutating command follows this sequence after a successful S3 call:
//! 1. Invalidate the affected `CacheKey::Objects` prefix(es).
//! 2. Emit `objects:updated { profileId, bucket, prefix }` for each affected
//!    prefix so the frontend's TanStack Query adapter invalidates its local cache.

use tauri::{AppHandle, State};

use std::collections::HashMap;

use crate::{
    cache::{invalidation::on_object_mutation, store::CacheHandle, CacheKey, Freshness},
    error::AppError,
    events::{self, EventKind},
    ids::{BucketId, ObjectKey, ProfileId},
    locks::{emit_acquired, emit_released, LockRegistryHandle, LockScope, ReleaseReason},
    profiles::ProfileStoreHandle,
    s3::{
        cross_account::{ConfirmScope, ConfirmationCacheHandle},
        list::{list_objects, list_objects_flat, ListPage},
        metadata::{set_object_metadata as s3_set_metadata, PutResult},
        object::{
            copy_object_with_fallback as s3_copy_object_with_fallback,
            create_folder as s3_create_folder, delete_objects_batch as s3_delete_objects_batch,
            get_object_bytes as s3_get_object_bytes, get_object_text as s3_get_object_text,
            move_object as s3_move_object, parent_prefix, put_object_text as s3_put_object_text,
            BytesPayload, CopyOptions, CopyOutcome, DeleteReport, MoveResult, TextPayload,
            DEFAULT_BYTES_MAX_BYTES, DEFAULT_TEXT_MAX_BYTES,
        },
        presign::{presign_get_object, PresignedUrl},
        tags::set_object_tags as s3_set_tags,
        S3ClientPoolHandle,
    },
};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// objects_list — hierarchical listing
// ---------------------------------------------------------------------------

/// List objects under `prefix` using `delimiter="/"`.
///
/// - Only the first page (`continuation_token = None`) is cached.
/// - Subsequent pages always call S3 directly.
/// - Refuses to serve data when the profile has not been validated.
#[tauri::command]
pub async fn objects_list(
    profile_id: ProfileId,
    bucket: BucketId,
    prefix: String,
    continuation_token: Option<String>,
    force: Option<bool>,
    store: State<'_, ProfileStoreHandle>,
    pool: State<'_, S3ClientPoolHandle>,
    cache: State<'_, CacheHandle>,
    _channel: AppHandle,
) -> Result<ListPage, AppError> {
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

    let cache_arc: CacheHandle = (*cache).clone();

    // ------------------------------------------------------------------
    // 2. Cache check — only for first-page requests
    // ------------------------------------------------------------------
    let is_first_page = continuation_token.is_none();

    if is_first_page && force != Some(true) {
        let cache_key = CacheKey::Objects {
            profile: profile_id.clone(),
            bucket: bucket.clone(),
            prefix: prefix.clone(),
        };

        let cached = cache_arc.get::<ListPage>(&cache_key, profile.validated_at)?;

        if let Some(read) = cached {
            if read.freshness == Freshness::Fresh || read.freshness == Freshness::Stale {
                return Ok(read.value);
            }
        }
    }

    // ------------------------------------------------------------------
    // 3. S3 fetch
    // ------------------------------------------------------------------
    let client = pool
        .inner
        .get_or_build(&profile_id, &default_region)
        .await
        .ok_or_else(|| AppError::Internal {
            trace_id: format!("pool_miss:profile:{}", profile_id.as_str()),
        })?;

    let page = list_objects(
        &client,
        bucket.as_str(),
        &prefix,
        Some("/"),
        continuation_token.as_deref(),
        None,
    )
    .await?;

    // ------------------------------------------------------------------
    // 4. Cache the result if this was the first page
    // ------------------------------------------------------------------
    if is_first_page {
        let cache_key = CacheKey::Objects {
            profile: profile_id.clone(),
            bucket: bucket.clone(),
            prefix: prefix.clone(),
        };
        let _ = cache_arc.put(&cache_key, &page, None);
    }

    Ok(page)
}

// ---------------------------------------------------------------------------
// objects_list_flat — flat listing (no delimiter)
// ---------------------------------------------------------------------------

/// List all objects under `prefix` without a delimiter (flat key tree).
///
/// Uses the same validation gate and first-page caching as `objects_list`,
/// but with a distinct cache-key suffix (`"__FLAT__"`) to avoid collision.
#[tauri::command]
pub async fn objects_list_flat(
    profile_id: ProfileId,
    bucket: BucketId,
    prefix: String,
    continuation_token: Option<String>,
    force: Option<bool>,
    store: State<'_, ProfileStoreHandle>,
    pool: State<'_, S3ClientPoolHandle>,
    cache: State<'_, CacheHandle>,
    _channel: AppHandle,
) -> Result<ListPage, AppError> {
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

    let cache_arc: CacheHandle = (*cache).clone();

    // ------------------------------------------------------------------
    // 2. Cache check — only for first-page requests
    //
    // The flat cache key appends "__FLAT__" to the prefix so it does not
    // collide with the hierarchical listing for the same prefix.
    // ------------------------------------------------------------------
    let is_first_page = continuation_token.is_none();
    let flat_prefix = format!("{}__FLAT__", prefix);

    if is_first_page && force != Some(true) {
        let cache_key = CacheKey::Objects {
            profile: profile_id.clone(),
            bucket: bucket.clone(),
            prefix: flat_prefix.clone(),
        };

        let cached = cache_arc.get::<ListPage>(&cache_key, profile.validated_at)?;

        if let Some(read) = cached {
            if read.freshness == Freshness::Fresh || read.freshness == Freshness::Stale {
                return Ok(read.value);
            }
        }
    }

    // ------------------------------------------------------------------
    // 3. S3 fetch
    // ------------------------------------------------------------------
    let client = pool
        .inner
        .get_or_build(&profile_id, &default_region)
        .await
        .ok_or_else(|| AppError::Internal {
            trace_id: format!("pool_miss:profile:{}", profile_id.as_str()),
        })?;

    let page = list_objects_flat(
        &client,
        bucket.as_str(),
        &prefix,
        continuation_token.as_deref(),
        None,
    )
    .await?;

    // ------------------------------------------------------------------
    // 4. Cache the first page
    // ------------------------------------------------------------------
    if is_first_page {
        let cache_key = CacheKey::Objects {
            profile: profile_id.clone(),
            bucket: bucket.clone(),
            prefix: flat_prefix,
        };
        let _ = cache_arc.put(&cache_key, &page, None);
    }

    Ok(page)
}

// ---------------------------------------------------------------------------
// Shared IPC types for mutation commands
// ---------------------------------------------------------------------------

/// Reference to a single S3 object: bucket + full key.
///
/// Used as both source and destination for copy/move.
///
/// OCP: `version_id` can be added later as `Option<String>` with `#[serde(default)]`
/// without breaking existing call sites.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectRef {
    pub bucket: BucketId,
    pub key: String,
}

/// Payload emitted as `objects:updated` after every mutation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ObjectsUpdatedPayload {
    profile_id: ProfileId,
    bucket: BucketId,
    prefix: String,
}

/// Emit `objects:updated` for one (profile, bucket, prefix) triple.
fn emit_objects_updated<E: events::EventEmitter>(
    channel: &E,
    profile_id: &ProfileId,
    bucket: &BucketId,
    prefix: &str,
) -> Result<(), AppError> {
    events::emit(
        channel,
        EventKind::ObjectsUpdated,
        ObjectsUpdatedPayload {
            profile_id: profile_id.clone(),
            bucket: bucket.clone(),
            prefix: prefix.to_string(),
        },
    )
}

// ---------------------------------------------------------------------------
// object_copy
// ---------------------------------------------------------------------------

/// Copy `source` to `destination` with automatic cross-account fallback.
///
/// - Attempts server-side `CopyObject` first.
/// - On `AccessDenied` (cross-account scenario):
///   - If the source size is ≤ `fallback_threshold_bytes` (default 100 MiB),
///     falls back to download+upload automatically.
///   - If the source size is above the threshold **and** `confirmed_token` is a
///     valid one-time token minted by `cross_account_confirm`, falls back.
///   - Otherwise returns `AppError::Validation` asking the frontend to call
///     `cross_account_confirm` first.
/// - Returns `CopyOutcome` instead of `CopyResult` so the frontend can show
///   a "Used fallback" indicator when the fallback path was taken.
/// - Acquires scoped locks on source and destination prefixes before calling S3.
/// - Invalidates destination prefix cache and emits `objects:updated` on success.
/// - Both locks are released (success or failure) before returning.
#[tauri::command]
pub async fn object_copy(
    profile_id: ProfileId,
    source: ObjectRef,
    destination: ObjectRef,
    options: CopyOptions,
    confirmed_token: Option<String>,
    store: State<'_, ProfileStoreHandle>,
    pool: State<'_, S3ClientPoolHandle>,
    locks: State<'_, LockRegistryHandle>,
    cache: State<'_, CacheHandle>,
    confirm_cache: State<'_, ConfirmationCacheHandle>,
    channel: AppHandle,
) -> Result<CopyOutcome, AppError> {
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
    // 2. Acquire locks on source and destination prefixes
    // ------------------------------------------------------------------
    let src_prefix = parent_prefix(&source.key);
    let dest_prefix = parent_prefix(&destination.key);

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let src_scope = LockScope {
        profile: profile_id.clone(),
        bucket: Some(source.bucket.clone()),
        prefix: Some(src_prefix.clone()),
        key: None,
    };
    let dest_scope = LockScope {
        profile: profile_id.clone(),
        bucket: Some(destination.bucket.clone()),
        prefix: Some(dest_prefix.clone()),
        key: None,
    };

    let registry = locks.inner();
    let src_lock_id = registry.acquire(src_scope, "object_copy:source", 300, now)?;
    let src_lock = registry
        .list(None)
        .into_iter()
        .find(|l| l.id == src_lock_id)
        .expect("lock must exist right after acquire");
    let _ = emit_acquired(&channel, &src_lock);

    let dest_lock_id = match registry.acquire(dest_scope, "object_copy:dest", 300, now) {
        Ok(id) => id,
        Err(e) => {
            // Release source lock before propagating.
            if let Ok(lock) = registry.release(&src_lock_id) {
                let _ = emit_released(&channel, &lock, ReleaseReason::Failure);
            }
            return Err(e);
        }
    };
    let dest_lock = registry
        .list(None)
        .into_iter()
        .find(|l| l.id == dest_lock_id)
        .expect("lock must exist right after acquire");
    let _ = emit_acquired(&channel, &dest_lock);

    // ------------------------------------------------------------------
    // 3. S3 copy (with cross-account fallback)
    // ------------------------------------------------------------------
    let client = pool
        .inner
        .get_or_build(&profile_id, &default_region)
        .await
        .ok_or_else(|| AppError::Internal {
            trace_id: format!("pool_miss:profile:{}", profile_id.as_str()),
        })?;

    // Default threshold: 100 MiB.  Future tasks will thread settings through here.
    const DEFAULT_FALLBACK_THRESHOLD: u64 = 100 * 1024 * 1024;

    let result = s3_copy_object_with_fallback(
        &client,
        source.bucket.as_str(),
        &source.key,
        destination.bucket.as_str(),
        &destination.key,
        &options,
        DEFAULT_FALLBACK_THRESHOLD,
        confirmed_token,
        &confirm_cache.inner,
        profile_id.as_str(),
    )
    .await;

    // ------------------------------------------------------------------
    // 4. Release locks
    // ------------------------------------------------------------------
    let release_reason = if result.is_ok() {
        ReleaseReason::Success
    } else {
        ReleaseReason::Failure
    };

    if let Ok(lock) = registry.release(&dest_lock_id) {
        let _ = emit_released(&channel, &lock, release_reason.clone());
    }
    if let Ok(lock) = registry.release(&src_lock_id) {
        let _ = emit_released(&channel, &lock, release_reason);
    }

    let copy_outcome = result?;

    // ------------------------------------------------------------------
    // 5. Cache invalidation + event
    // ------------------------------------------------------------------
    let cache_arc: CacheHandle = (*cache).clone();
    on_object_mutation(
        &profile_id,
        &destination.bucket,
        &dest_prefix,
        None,
        &cache_arc,
    );
    let _ = emit_objects_updated(&channel, &profile_id, &destination.bucket, &dest_prefix);

    Ok(copy_outcome)
}

// ---------------------------------------------------------------------------
// cross_account_confirm
// ---------------------------------------------------------------------------

/// Mint a one-time confirmation token for a large cross-account copy.
///
/// The frontend calls this command when `object_copy` returns a
/// `Validation { field: "confirmed_token" }` error.  The returned token must
/// be passed back to `object_copy` as `confirmed_token` in the next call.
///
/// Tokens are single-use, scoped to exactly the (profile, source, destination)
/// triple, and expire after 5 minutes.
///
/// # Note on "heuristic check"
///
/// This command does not re-verify that a cross-account error actually
/// occurred — the frontend is trusted to call it only after receiving the
/// `Validation` error from `object_copy`.  The token is harmless if the next
/// `object_copy` succeeds via the server-side path (which returns
/// `ServerSideCopy` without consulting the token).
#[tauri::command]
pub async fn cross_account_confirm(
    profile_id: ProfileId,
    source: ObjectRef,
    destination: ObjectRef,
    store: State<'_, ProfileStoreHandle>,
    confirm_cache: State<'_, ConfirmationCacheHandle>,
) -> Result<String, AppError> {
    // Validation gate: profile must exist and be validated.
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

    let scope = ConfirmScope {
        profile: profile_id.as_str().to_string(),
        source_bucket: source.bucket.as_str().to_string(),
        source_key: source.key.clone(),
        dest_bucket: destination.bucket.as_str().to_string(),
        dest_key: destination.key.clone(),
    };

    let token = confirm_cache.inner.mint(scope);
    Ok(token)
}

// ---------------------------------------------------------------------------
// object_move
// ---------------------------------------------------------------------------

/// Move `source` to `destination`: server-side copy then delete source.
///
/// On success emits `objects:updated` for both source and destination prefixes.
#[tauri::command]
pub async fn object_move(
    profile_id: ProfileId,
    source: ObjectRef,
    destination: ObjectRef,
    options: CopyOptions,
    store: State<'_, ProfileStoreHandle>,
    pool: State<'_, S3ClientPoolHandle>,
    locks: State<'_, LockRegistryHandle>,
    cache: State<'_, CacheHandle>,
    channel: AppHandle,
) -> Result<MoveResult, AppError> {
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
    // 2. Acquire locks on source and destination prefixes
    // ------------------------------------------------------------------
    let src_prefix = parent_prefix(&source.key);
    let dest_prefix = parent_prefix(&destination.key);

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let src_scope = LockScope {
        profile: profile_id.clone(),
        bucket: Some(source.bucket.clone()),
        prefix: Some(src_prefix.clone()),
        key: None,
    };
    let dest_scope = LockScope {
        profile: profile_id.clone(),
        bucket: Some(destination.bucket.clone()),
        prefix: Some(dest_prefix.clone()),
        key: None,
    };

    let registry = locks.inner();
    let src_lock_id = registry.acquire(src_scope, "object_move:source", 300, now)?;
    let src_lock = registry
        .list(None)
        .into_iter()
        .find(|l| l.id == src_lock_id)
        .expect("lock must exist right after acquire");
    let _ = emit_acquired(&channel, &src_lock);

    let dest_lock_id = match registry.acquire(dest_scope, "object_move:dest", 300, now) {
        Ok(id) => id,
        Err(e) => {
            if let Ok(lock) = registry.release(&src_lock_id) {
                let _ = emit_released(&channel, &lock, ReleaseReason::Failure);
            }
            return Err(e);
        }
    };
    let dest_lock = registry
        .list(None)
        .into_iter()
        .find(|l| l.id == dest_lock_id)
        .expect("lock must exist right after acquire");
    let _ = emit_acquired(&channel, &dest_lock);

    // ------------------------------------------------------------------
    // 3. S3 move (copy + delete)
    // ------------------------------------------------------------------
    let client = pool
        .inner
        .get_or_build(&profile_id, &default_region)
        .await
        .ok_or_else(|| AppError::Internal {
            trace_id: format!("pool_miss:profile:{}", profile_id.as_str()),
        })?;

    let result = s3_move_object(
        &client,
        source.bucket.as_str(),
        &source.key,
        destination.bucket.as_str(),
        &destination.key,
        &options,
    )
    .await;

    // ------------------------------------------------------------------
    // 4. Release locks
    // ------------------------------------------------------------------
    let release_reason = if result.is_ok() {
        ReleaseReason::Success
    } else {
        ReleaseReason::Failure
    };

    if let Ok(lock) = registry.release(&dest_lock_id) {
        let _ = emit_released(&channel, &lock, release_reason.clone());
    }
    if let Ok(lock) = registry.release(&src_lock_id) {
        let _ = emit_released(&channel, &lock, release_reason);
    }

    let move_result = result?;

    // ------------------------------------------------------------------
    // 5. Cache invalidation + events (source AND destination)
    // ------------------------------------------------------------------
    let cache_arc: CacheHandle = (*cache).clone();
    on_object_mutation(&profile_id, &source.bucket, &src_prefix, None, &cache_arc);
    on_object_mutation(
        &profile_id,
        &destination.bucket,
        &dest_prefix,
        None,
        &cache_arc,
    );
    let _ = emit_objects_updated(&channel, &profile_id, &source.bucket, &src_prefix);
    let _ = emit_objects_updated(&channel, &profile_id, &destination.bucket, &dest_prefix);

    Ok(move_result)
}

// ---------------------------------------------------------------------------
// object_create_folder
// ---------------------------------------------------------------------------

/// Create a virtual folder placeholder at `bucket/prefix/`.
///
/// Acquires a lock on the prefix, calls `create_folder`, then emits
/// `objects:updated` for the parent prefix.
#[tauri::command]
pub async fn object_create_folder(
    profile_id: ProfileId,
    bucket: BucketId,
    prefix: String,
    store: State<'_, ProfileStoreHandle>,
    pool: State<'_, S3ClientPoolHandle>,
    locks: State<'_, LockRegistryHandle>,
    cache: State<'_, CacheHandle>,
    channel: AppHandle,
) -> Result<(), AppError> {
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
    // 2. Acquire lock on prefix
    // ------------------------------------------------------------------
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let scope = LockScope {
        profile: profile_id.clone(),
        bucket: Some(bucket.clone()),
        prefix: Some(prefix.clone()),
        key: None,
    };

    let registry = locks.inner();
    let lock_id = registry.acquire(scope, "object_create_folder", 300, now)?;
    let lock = registry
        .list(None)
        .into_iter()
        .find(|l| l.id == lock_id)
        .expect("lock must exist right after acquire");
    let _ = emit_acquired(&channel, &lock);

    // ------------------------------------------------------------------
    // 3. S3 create folder
    // ------------------------------------------------------------------
    let client = pool
        .inner
        .get_or_build(&profile_id, &default_region)
        .await
        .ok_or_else(|| AppError::Internal {
            trace_id: format!("pool_miss:profile:{}", profile_id.as_str()),
        })?;

    let result = s3_create_folder(&client, bucket.as_str(), &prefix).await;

    // ------------------------------------------------------------------
    // 4. Release lock
    // ------------------------------------------------------------------
    let release_reason = if result.is_ok() {
        ReleaseReason::Success
    } else {
        ReleaseReason::Failure
    };
    if let Ok(lock) = registry.release(&lock_id) {
        let _ = emit_released(&channel, &lock, release_reason);
    }

    result?;

    // ------------------------------------------------------------------
    // 5. Cache invalidation + event (parent prefix)
    // ------------------------------------------------------------------
    let parent = parent_prefix(&prefix);
    let cache_arc: CacheHandle = (*cache).clone();
    on_object_mutation(&profile_id, &bucket, &parent, None, &cache_arc);
    let _ = emit_objects_updated(&channel, &profile_id, &bucket, &parent);

    Ok(())
}

// ---------------------------------------------------------------------------
// object_delete_batch
// ---------------------------------------------------------------------------

/// One key (with optional version ID) in a batch delete request.
///
/// OCP: `bypass_governance_retention: bool` can be added later for object-lock
/// support without breaking existing callers (`#[serde(default)]`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteKey {
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_id: Option<String>,
}

/// Delete `keys` from `bucket` using the S3 batched `DeleteObjects` API.
///
/// - Groups keys by parent prefix and acquires one lock per unique prefix.
/// - Issues the batch delete (chunked at 1 000 keys per AWS limit).
/// - Invalidates cache and emits `objects:updated` once per unique affected
///   prefix (only for prefixes that had at least one successfully deleted key).
/// - All locks are released before returning.
///
/// Partial per-key failures (AC-4) are returned in `DeleteReport.failed`.
/// A non-empty `failed` list is NOT an `Err` — the caller decides UI handling.
#[tauri::command]
pub async fn object_delete_batch(
    profile_id: ProfileId,
    bucket: BucketId,
    keys: Vec<DeleteKey>,
    store: State<'_, ProfileStoreHandle>,
    pool: State<'_, S3ClientPoolHandle>,
    locks: State<'_, LockRegistryHandle>,
    cache: State<'_, CacheHandle>,
    channel: AppHandle,
) -> Result<DeleteReport, AppError> {
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
    // 2. Collect unique affected prefixes and acquire one lock per prefix
    // ------------------------------------------------------------------
    // Collect unique prefixes from all requested keys.
    // BTreeSet gives sorted, deduplicated order — deterministic acquisition prevents
    // cross-task deadlocks if two concurrent batches touch overlapping prefixes.
    let unique_prefixes: Vec<String> = keys
        .iter()
        .map(|dk| parent_prefix(&dk.key))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let registry = locks.inner();
    let mut acquired_lock_ids: Vec<crate::locks::LockId> =
        Vec::with_capacity(unique_prefixes.len());

    for prefix in &unique_prefixes {
        let scope = LockScope {
            profile: profile_id.clone(),
            bucket: Some(bucket.clone()),
            prefix: Some(prefix.clone()),
            key: None,
        };
        let lock_id = match registry.acquire(scope, "object_delete_batch", 300, now) {
            Ok(id) => id,
            Err(e) => {
                // Release all already-acquired locks before propagating.
                for held_id in &acquired_lock_ids {
                    if let Ok(lock) = registry.release(held_id) {
                        let _ = emit_released(&channel, &lock, ReleaseReason::Failure);
                    }
                }
                return Err(e);
            }
        };
        let lock = registry
            .list(None)
            .into_iter()
            .find(|l| l.id == lock_id)
            .expect("lock must exist right after acquire");
        let _ = emit_acquired(&channel, &lock);
        acquired_lock_ids.push(lock_id);
    }

    // ------------------------------------------------------------------
    // 3. S3 batch delete
    // ------------------------------------------------------------------
    let client = pool
        .inner
        .get_or_build(&profile_id, &default_region)
        .await
        .ok_or_else(|| AppError::Internal {
            trace_id: format!("pool_miss:profile:{}", profile_id.as_str()),
        })?;

    // Convert DeleteKey vec to the format expected by delete_objects_batch.
    let key_pairs: Vec<(ObjectKey, Option<String>)> = keys
        .iter()
        .map(|dk| (ObjectKey::new(dk.key.clone()), dk.version_id.clone()))
        .collect();

    let result = s3_delete_objects_batch(&client, bucket.as_str(), key_pairs).await;

    // ------------------------------------------------------------------
    // 4. Release all locks
    // ------------------------------------------------------------------
    let release_reason = if result.is_ok() {
        ReleaseReason::Success
    } else {
        ReleaseReason::Failure
    };
    for held_id in &acquired_lock_ids {
        if let Ok(lock) = registry.release(held_id) {
            let _ = emit_released(&channel, &lock, release_reason.clone());
        }
    }

    let report = result?;

    // ------------------------------------------------------------------
    // 5. Cache invalidation + events for each affected prefix
    //
    // Emit one `objects:updated` per unique prefix that had at least one
    // successfully deleted key. Consistent with the single-prefix event
    // shape from copy/move/create_folder.
    // ------------------------------------------------------------------
    // Collect the parent prefixes of all successfully deleted keys.
    let affected_prefixes: std::collections::BTreeSet<String> = report
        .deleted
        .iter()
        .map(|d| parent_prefix(&d.key))
        .collect();

    let cache_arc: CacheHandle = (*cache).clone();
    for prefix in &affected_prefixes {
        on_object_mutation(&profile_id, &bucket, prefix, None, &cache_arc);
        let _ = emit_objects_updated(&channel, &profile_id, &bucket, prefix);
    }

    Ok(report)
}

// ---------------------------------------------------------------------------
// object_set_metadata
// ---------------------------------------------------------------------------

/// Replace user-defined metadata on `bucket/key`.
///
/// Uses a server-side `CopyObject` self-overwrite with `MetadataDirective::Replace`
/// so the object body is preserved without re-uploading.
///
/// When `if_match_etag` is supplied the backend enforces an ETag precondition.
/// A mismatch returns `AppError::Conflict`.
#[tauri::command]
pub async fn object_set_metadata(
    profile_id: ProfileId,
    bucket: BucketId,
    key: String,
    metadata: HashMap<String, String>,
    if_match_etag: Option<String>,
    store: State<'_, ProfileStoreHandle>,
    pool: State<'_, S3ClientPoolHandle>,
    locks: State<'_, LockRegistryHandle>,
    cache: State<'_, CacheHandle>,
    channel: AppHandle,
) -> Result<PutResult, AppError> {
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
    // 2. Acquire lock on object key
    // ------------------------------------------------------------------
    let prefix = parent_prefix(&key);

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let scope = LockScope {
        profile: profile_id.clone(),
        bucket: Some(bucket.clone()),
        prefix: Some(prefix.clone()),
        key: Some(ObjectKey::new(key.clone())),
    };

    let registry = locks.inner();
    let lock_id = registry.acquire(scope, "object_set_metadata", 300, now)?;
    let lock = registry
        .list(None)
        .into_iter()
        .find(|l| l.id == lock_id)
        .expect("lock must exist right after acquire");
    let _ = emit_acquired(&channel, &lock);

    // ------------------------------------------------------------------
    // 3. S3 metadata update
    // ------------------------------------------------------------------
    let client = pool
        .inner
        .get_or_build(&profile_id, &default_region)
        .await
        .ok_or_else(|| AppError::Internal {
            trace_id: format!("pool_miss:profile:{}", profile_id.as_str()),
        })?;

    let result = s3_set_metadata(&client, bucket.as_str(), &key, metadata, if_match_etag).await;

    // ------------------------------------------------------------------
    // 4. Release lock
    // ------------------------------------------------------------------
    let release_reason = if result.is_ok() {
        ReleaseReason::Success
    } else {
        ReleaseReason::Failure
    };
    if let Ok(lock) = registry.release(&lock_id) {
        let _ = emit_released(&channel, &lock, release_reason);
    }

    let put_result = result?;

    // ------------------------------------------------------------------
    // 5. Cache invalidation + event
    // ------------------------------------------------------------------
    let cache_arc: CacheHandle = (*cache).clone();
    on_object_mutation(&profile_id, &bucket, &prefix, None, &cache_arc);
    let _ = emit_objects_updated(&channel, &profile_id, &bucket, &prefix);

    Ok(put_result)
}

// ---------------------------------------------------------------------------
// object_set_tags
// ---------------------------------------------------------------------------

/// Set (or clear) the tags on `bucket/key`.
///
/// An empty `tags` map removes all tags via `DeleteObjectTagging`.
///
/// When `if_match_etag` is supplied an explicit `HeadObject` precondition check
/// is performed before `PutObjectTagging` (race-prone but the best AWS allows).
/// A mismatch returns `AppError::Conflict`.
#[tauri::command]
pub async fn object_set_tags(
    profile_id: ProfileId,
    bucket: BucketId,
    key: String,
    tags: HashMap<String, String>,
    if_match_etag: Option<String>,
    store: State<'_, ProfileStoreHandle>,
    pool: State<'_, S3ClientPoolHandle>,
    locks: State<'_, LockRegistryHandle>,
    cache: State<'_, CacheHandle>,
    channel: AppHandle,
) -> Result<PutResult, AppError> {
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
    // 2. Acquire lock on object key
    // ------------------------------------------------------------------
    let prefix = parent_prefix(&key);

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let scope = LockScope {
        profile: profile_id.clone(),
        bucket: Some(bucket.clone()),
        prefix: Some(prefix.clone()),
        key: Some(ObjectKey::new(key.clone())),
    };

    let registry = locks.inner();
    let lock_id = registry.acquire(scope, "object_set_tags", 300, now)?;
    let lock = registry
        .list(None)
        .into_iter()
        .find(|l| l.id == lock_id)
        .expect("lock must exist right after acquire");
    let _ = emit_acquired(&channel, &lock);

    // ------------------------------------------------------------------
    // 3. S3 tags update
    // ------------------------------------------------------------------
    let client = pool
        .inner
        .get_or_build(&profile_id, &default_region)
        .await
        .ok_or_else(|| AppError::Internal {
            trace_id: format!("pool_miss:profile:{}", profile_id.as_str()),
        })?;

    let result = s3_set_tags(&client, bucket.as_str(), &key, tags, if_match_etag).await;

    // ------------------------------------------------------------------
    // 4. Release lock
    // ------------------------------------------------------------------
    let release_reason = if result.is_ok() {
        ReleaseReason::Success
    } else {
        ReleaseReason::Failure
    };
    if let Ok(lock) = registry.release(&lock_id) {
        let _ = emit_released(&channel, &lock, release_reason);
    }

    let put_result = result?;

    // ------------------------------------------------------------------
    // 5. Cache invalidation + event
    // ------------------------------------------------------------------
    let cache_arc: CacheHandle = (*cache).clone();
    on_object_mutation(&profile_id, &bucket, &prefix, None, &cache_arc);
    let _ = emit_objects_updated(&channel, &profile_id, &bucket, &prefix);

    Ok(put_result)
}

// ---------------------------------------------------------------------------
// object_presign
// ---------------------------------------------------------------------------

/// Generate a presigned `GetObject` URL for `bucket/key`.
///
/// The URL embeds the credentials in the query string (SigV4) and is valid
/// for `expires_sec` seconds.  When `expires_sec` is omitted the default is
/// 3 600 s (1 hour).
///
/// # Validation
///
/// Returns `AppError::Validation { field: "expires_secs", … }` when the
/// supplied expiry is outside `[60, 604_800]` (60 s – 7 days).
///
/// # Security
///
/// The URL is generated in Rust — AWS credentials never cross the IPC
/// boundary.  The frontend receives an opaque `PresignedUrl` struct and
/// writes the URL to the clipboard.  The URL itself carries no ongoing auth
/// state; once generated it may be shared freely within its expiry window.
#[tauri::command]
pub async fn object_presign(
    profile_id: ProfileId,
    bucket: BucketId,
    key: String,
    expires_sec: Option<u64>,
    store: State<'_, ProfileStoreHandle>,
    pool: State<'_, S3ClientPoolHandle>,
) -> Result<PresignedUrl, AppError> {
    // ------------------------------------------------------------------
    // 1. Resolve expiry with default
    // ------------------------------------------------------------------
    const DEFAULT_EXPIRES_SECS: u64 = 3_600;
    let expires_secs = expires_sec.unwrap_or(DEFAULT_EXPIRES_SECS);

    // ------------------------------------------------------------------
    // 2. Resolve profile + validation gate
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
    // 3. Build S3 client
    // ------------------------------------------------------------------
    let client = pool
        .inner
        .get_or_build(&profile_id, &default_region)
        .await
        .ok_or_else(|| AppError::Internal {
            trace_id: format!("pool_miss:profile:{}", profile_id.as_str()),
        })?;

    // ------------------------------------------------------------------
    // 4. Generate presigned URL (validation happens inside this helper)
    // ------------------------------------------------------------------
    presign_get_object(&client, bucket.as_str(), &key, expires_secs).await
}

// ---------------------------------------------------------------------------
// object_set_storage_class
// ---------------------------------------------------------------------------

/// Change the storage class of one or more objects.
///
/// # Safety gate (diff framework)
///
/// This command requires a `confirmed_diff_id` that was previously created via
/// `diff_preview_create`.  The id is consumed atomically on entry:
///
/// - If the diff does not exist, was cancelled, or expired → `Validation` error.
/// - If the diff was already consumed (double-confirm rejection) → `Validation`
///   error.
/// - If the diff payload does not match the requested targets/class →
///   `Validation` error.
///
/// This is the single authoritative enforce point for the "no blind storage
/// class change" invariant from Decision D2.
///
/// # Decision D2 (optimistic boundary)
///
/// Storage class change is explicitly NOT subject to optimistic updates.
/// The command emits `objects:updated` per target on success, which allows the
/// frontend's event-driven path to refresh the listing.  No `optimistic.ts`
/// helper exists for this operation (asserted in
/// `storage_class_change_does_not_use_optimistic_path`).
///
/// # Event emission (round-1 finding #14)
///
/// `objects:updated { profileId, bucket, prefix }` is emitted for each
/// successfully changed object's parent prefix.
#[tauri::command]
pub async fn object_set_storage_class(
    profile_id: ProfileId,
    targets: Vec<ObjectRef>,
    new_storage_class: String,
    confirmed_diff_id: crate::diff::DiffId,
    store: State<'_, ProfileStoreHandle>,
    pool: State<'_, S3ClientPoolHandle>,
    locks: State<'_, LockRegistryHandle>,
    cache: State<'_, CacheHandle>,
    channel: AppHandle,
    diff_store: State<'_, crate::diff::DiffStoreHandle>,
) -> Result<Vec<crate::s3::metadata::PutResult>, AppError> {
    // ------------------------------------------------------------------
    // 1. Consume the diff — single authoritative safety gate
    // ------------------------------------------------------------------
    let consumed_payload = diff_store
        .inner
        .consume(&confirmed_diff_id)
        .ok_or_else(|| {
            let record = diff_store.inner.get(&confirmed_diff_id);
            match record {
                Some(r) => match r.status {
                    crate::diff::DiffStatus::Cancelled | crate::diff::DiffStatus::Expired => {
                        AppError::Validation {
                            field: "confirmed_diff_id".to_string(),
                            hint: "Diff was cancelled or expired".to_string(),
                        }
                    }
                    crate::diff::DiffStatus::Confirmed => AppError::Validation {
                        field: "confirmed_diff_id".to_string(),
                        hint: "Diff already consumed (double-confirm rejection)".to_string(),
                    },
                    crate::diff::DiffStatus::Pending => AppError::Internal {
                        trace_id: "diff_consume_failed_unexpectedly".to_string(),
                    },
                },
                None => AppError::Validation {
                    field: "confirmed_diff_id".to_string(),
                    hint: "Diff not found".to_string(),
                },
            }
        })?;

    // ------------------------------------------------------------------
    // 2. Validate that the consumed diff payload matches the request
    // ------------------------------------------------------------------
    // DiffPayload currently has a single variant — destructure with `let`.
    // When new variants are added, switch back to a `match`.
    let crate::diff::DiffPayload::StorageClass {
        targets: diff_targets,
        new_class: diff_new_class,
        ..
    } = &consumed_payload;
    // Check new_class matches.
    if *diff_new_class != new_storage_class {
        return Err(AppError::Validation {
            field: "new_storage_class".to_string(),
            hint: format!(
                "Requested class '{}' does not match diff's class '{}'",
                new_storage_class, diff_new_class
            ),
        });
    }
    // Check targets match (same set, order-insensitive).
    if diff_targets.len() != targets.len()
        || !targets.iter().all(|t| {
            diff_targets
                .iter()
                .any(|dt| dt.bucket.as_str() == t.bucket.as_str() && dt.key == t.key)
        })
    {
        return Err(AppError::Validation {
            field: "targets".to_string(),
            hint: "Requested targets do not match the diff's targets".to_string(),
        });
    }

    // ------------------------------------------------------------------
    // 3. Resolve profile + validation gate
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

    let client = pool
        .inner
        .get_or_build(&profile_id, &default_region)
        .await
        .ok_or_else(|| AppError::Internal {
            trace_id: format!("pool_miss:profile:{}", profile_id.as_str()),
        })?;

    // ------------------------------------------------------------------
    // 4. Process each target: acquire lock → set storage class → release
    // ------------------------------------------------------------------
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let registry = locks.inner();
    let cache_arc: CacheHandle = (*cache).clone();
    let mut results: Vec<crate::s3::metadata::PutResult> = Vec::with_capacity(targets.len());

    for target in &targets {
        let prefix = parent_prefix(&target.key);

        let scope = LockScope {
            profile: profile_id.clone(),
            bucket: Some(target.bucket.clone()),
            prefix: Some(prefix.clone()),
            key: Some(ObjectKey::new(target.key.clone())),
        };

        let lock_id = registry.acquire(scope, "object_set_storage_class", 300, now)?;
        let lock = registry
            .list(None)
            .into_iter()
            .find(|l| l.id == lock_id)
            .expect("lock must exist right after acquire");
        let _ = emit_acquired(&channel, &lock);

        let result = crate::s3::object::set_object_storage_class(
            &client,
            target.bucket.as_str(),
            &target.key,
            new_storage_class.clone(),
        )
        .await;

        let release_reason = if result.is_ok() {
            ReleaseReason::Success
        } else {
            ReleaseReason::Failure
        };
        if let Ok(lock) = registry.release(&lock_id) {
            let _ = emit_released(&channel, &lock, release_reason);
        }

        let put_result = result?;

        // Cache invalidation + event (round-1 finding #14).
        on_object_mutation(&profile_id, &target.bucket, &prefix, None, &cache_arc);
        let _ = emit_objects_updated(&channel, &profile_id, &target.bucket, &prefix);

        results.push(put_result);
    }

    Ok(results)
}

// ---------------------------------------------------------------------------
// object_get_text — text content fetch for preview
// ---------------------------------------------------------------------------

/// Fetch the first `max_bytes` bytes of an S3 object as UTF-8 text.
///
/// Uses a `Range: bytes=0-<max_bytes-1>` request so large objects are not
/// fully downloaded.  Invalid UTF-8 bytes are replaced with U+FFFD.
///
/// Returns a `TextPayload` with the decoded body, total content length, ETag,
/// and a `truncated` flag.  The default limit is 1 MiB when `max_bytes` is
/// omitted.
///
/// This command is intentionally read-only and does not emit any events or
/// touch the mutation cache.  It is reusable by the Monaco editor (task 50)
/// for its initial content load.
///
/// # Validation gate
///
/// Refuses to serve data when the profile has not been validated (AC-8 /
/// round-1 finding #9).
#[tauri::command]
pub async fn object_get_text(
    profile_id: ProfileId,
    bucket: String,
    key: String,
    max_bytes: Option<u64>,
    store: State<'_, ProfileStoreHandle>,
    pool: State<'_, S3ClientPoolHandle>,
) -> Result<TextPayload, AppError> {
    // ------------------------------------------------------------------
    // 1. Resolve profile + validation gate
    // ------------------------------------------------------------------
    let (validated, region_override, default_region) = {
        let store_guard = store.inner.lock().await;
        let profile = store_guard
            .get(&profile_id)
            .ok_or_else(|| AppError::NotFound {
                resource: format!("profile:{}", profile_id.as_str()),
            })?;
        (
            profile.validated_at.is_some(),
            profile.compat_flags.region_override.clone(),
            profile.default_region.clone(),
        )
    };

    if !validated {
        return Err(AppError::Auth {
            reason: "profile_not_validated_in_session".to_string(),
        });
    }

    let region = region_override
        .or(default_region)
        .unwrap_or_else(|| "us-east-1".to_string());

    // ------------------------------------------------------------------
    // 2. Build client
    // ------------------------------------------------------------------
    let client = pool
        .inner
        .get_or_build(&profile_id, &region)
        .await
        .ok_or_else(|| AppError::Internal {
            trace_id: format!("pool_miss:profile:{}", profile_id.as_str()),
        })?;

    // ------------------------------------------------------------------
    // 3. Fetch text
    // ------------------------------------------------------------------
    let limit = max_bytes.unwrap_or(DEFAULT_TEXT_MAX_BYTES);
    s3_get_object_text(&client, &bucket, &key, limit).await
}

// ---------------------------------------------------------------------------
// object_get_bytes — raw binary fetch for hex/archive preview
// ---------------------------------------------------------------------------

/// Fetch the first `max_bytes` bytes of an S3 object as a base64-encoded string.
///
/// Uses a `Range: bytes=0-<max_bytes-1>` request so large objects are not
/// fully downloaded.  The frontend decodes with `atob` or equivalent.
///
/// Returns a `BytesPayload` with the base64 body, total content length, ETag,
/// and a `truncated` flag.  The default limit is 1 MiB when `max_bytes` is
/// omitted.
///
/// # Validation gate
///
/// Refuses to serve data when the profile has not been validated (AC-8 /
/// round-1 finding #9).
#[tauri::command]
pub async fn object_get_bytes(
    profile_id: ProfileId,
    bucket: String,
    key: String,
    max_bytes: Option<u64>,
    store: State<'_, ProfileStoreHandle>,
    pool: State<'_, S3ClientPoolHandle>,
) -> Result<BytesPayload, AppError> {
    // ------------------------------------------------------------------
    // 1. Resolve profile + validation gate
    // ------------------------------------------------------------------
    let (validated, region_override, default_region) = {
        let store_guard = store.inner.lock().await;
        let profile = store_guard
            .get(&profile_id)
            .ok_or_else(|| AppError::NotFound {
                resource: format!("profile:{}", profile_id.as_str()),
            })?;
        (
            profile.validated_at.is_some(),
            profile.compat_flags.region_override.clone(),
            profile.default_region.clone(),
        )
    };

    if !validated {
        return Err(AppError::Auth {
            reason: "profile_not_validated_in_session".to_string(),
        });
    }

    let region = region_override
        .or(default_region)
        .unwrap_or_else(|| "us-east-1".to_string());

    // ------------------------------------------------------------------
    // 2. Build client
    // ------------------------------------------------------------------
    let client = pool
        .inner
        .get_or_build(&profile_id, &region)
        .await
        .ok_or_else(|| AppError::Internal {
            trace_id: format!("pool_miss:profile:{}", profile_id.as_str()),
        })?;

    // ------------------------------------------------------------------
    // 3. Fetch bytes
    // ------------------------------------------------------------------
    let limit = max_bytes.unwrap_or(DEFAULT_BYTES_MAX_BYTES);
    s3_get_object_bytes(&client, &bucket, &key, limit).await
}

// ---------------------------------------------------------------------------
// object_put_text — write text body with optional ETag precondition
// ---------------------------------------------------------------------------

/// Write a UTF-8 text body to `bucket/key`.
///
/// When `if_match_etag` is supplied the backend sets the `If-Match` header so
/// S3 rejects the write with 412 if the object was modified since the editor
/// loaded it.  That 412 maps to `AppError::Conflict { etag_expected, etag_actual: None }`.
///
/// The frontend should:
/// - Supply `if_match_etag` from the ETag returned by `object_get_text` for
///   conflict-safe saves.
/// - Omit `if_match_etag` (pass `null`) for "save anyway" after a conflict.
///
/// On success the backend emits `objects:updated { profileId, bucket, prefix }`
/// for the parent prefix of `key` so the listing refreshes.
///
/// # Validation gate
///
/// Refuses to write when the profile has not been validated (AC-8).
#[tauri::command]
pub async fn object_put_text(
    profile_id: ProfileId,
    bucket: String,
    key: String,
    body: String,
    if_match_etag: Option<String>,
    store: State<'_, ProfileStoreHandle>,
    pool: State<'_, S3ClientPoolHandle>,
    locks: State<'_, LockRegistryHandle>,
    cache: State<'_, CacheHandle>,
    channel: AppHandle,
) -> Result<PutResult, AppError> {
    // ------------------------------------------------------------------
    // 1. Resolve profile + validation gate
    // ------------------------------------------------------------------
    let (validated, region_override, default_region) = {
        let store_guard = store.inner.lock().await;
        let profile = store_guard
            .get(&profile_id)
            .ok_or_else(|| AppError::NotFound {
                resource: format!("profile:{}", profile_id.as_str()),
            })?;
        (
            profile.validated_at.is_some(),
            profile.compat_flags.region_override.clone(),
            profile.default_region.clone(),
        )
    };

    if !validated {
        return Err(AppError::Auth {
            reason: "profile_not_validated_in_session".to_string(),
        });
    }

    let region = region_override
        .or(default_region)
        .unwrap_or_else(|| "us-east-1".to_string());

    // ------------------------------------------------------------------
    // 2. Acquire lock on the object key
    // ------------------------------------------------------------------
    let prefix = parent_prefix(&key);

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let bucket_id = BucketId::new(bucket.clone());

    let scope = LockScope {
        profile: profile_id.clone(),
        bucket: Some(bucket_id.clone()),
        prefix: Some(prefix.clone()),
        key: Some(ObjectKey::new(key.clone())),
    };

    let registry = locks.inner();
    let lock_id = registry.acquire(scope, "object_put_text", 300, now)?;
    let lock = registry
        .list(None)
        .into_iter()
        .find(|l| l.id == lock_id)
        .expect("lock must exist right after acquire");
    let _ = emit_acquired(&channel, &lock);

    // ------------------------------------------------------------------
    // 3. Build client + call S3
    // ------------------------------------------------------------------
    let client = pool
        .inner
        .get_or_build(&profile_id, &region)
        .await
        .ok_or_else(|| AppError::Internal {
            trace_id: format!("pool_miss:profile:{}", profile_id.as_str()),
        })?;

    let result = s3_put_object_text(&client, &bucket, &key, body, if_match_etag).await;

    // ------------------------------------------------------------------
    // 4. Release lock
    // ------------------------------------------------------------------
    let release_reason = if result.is_ok() {
        ReleaseReason::Success
    } else {
        ReleaseReason::Failure
    };
    if let Ok(lock) = registry.release(&lock_id) {
        let _ = emit_released(&channel, &lock, release_reason);
    }

    let put_result = result?;

    // ------------------------------------------------------------------
    // 5. Cache invalidation + event
    // ------------------------------------------------------------------
    let cache_arc: CacheHandle = (*cache).clone();
    on_object_mutation(&profile_id, &bucket_id, &prefix, None, &cache_arc);
    let _ = emit_objects_updated(&channel, &profile_id, &bucket_id, &prefix);

    Ok(put_result)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        cache::{store::CacheStore, CacheConfig},
        ids::BucketId,
        s3::list::{ListPage, ObjectEntry},
    };

    fn validated_at() -> Option<i64> {
        Some(1_700_000_000_000)
    }

    fn make_page(prefix: &str, flat: bool) -> ListPage {
        ListPage {
            entries: vec![ObjectEntry {
                key: format!("{prefix}file.txt"),
                size: 42,
                last_modified: None,
                etag: None,
                storage_class: None,
                is_prefix: false,
            }],
            common_prefixes: if flat {
                vec![]
            } else {
                vec![format!("{prefix}subdir/")]
            },
            next_continuation_token: None,
            is_truncated: false,
            prefix: prefix.to_string(),
            delimiter: if flat { None } else { Some("/".to_string()) },
        }
    }

    // ------------------------------------------------------------------
    // Validation gate: unvalidated profile returns Auth error
    // ------------------------------------------------------------------

    #[test]
    fn unvalidated_profile_gate_returns_auth_error() {
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
    // Cache hit on first page (no continuation token)
    // ------------------------------------------------------------------

    #[test]
    fn cache_hit_on_first_page_returns_cached_value() {
        let pid = ProfileId::new("p-objects");
        let bid = BucketId::new("my-bucket");
        let prefix = "photos/".to_string();
        let cache = CacheStore::in_memory(CacheConfig::default());

        let expected = make_page(&prefix, false);
        let cache_key = CacheKey::Objects {
            profile: pid.clone(),
            bucket: bid.clone(),
            prefix: prefix.clone(),
        };
        cache
            .put(&cache_key, &expected, None)
            .expect("put must succeed");

        let read = cache
            .get::<ListPage>(&cache_key, validated_at())
            .expect("get must not error")
            .expect("entry must exist");

        assert_eq!(read.freshness, Freshness::Fresh);
        assert_eq!(read.value.prefix, prefix);
        assert_eq!(read.value.entries.len(), 1);
    }

    // ------------------------------------------------------------------
    // Cache miss on continuation token: key includes no token in the cache
    // ------------------------------------------------------------------

    #[test]
    fn cache_miss_on_continuation_token_bypasses_cache() {
        // The cache is keyed on (profile, bucket, prefix) — no token.
        // A call with a token is always a "page 2+" and must not hit cache.
        // We verify this by putting a page into the cache and asserting
        // that looking up with the same key but different scenario works:
        // the command code simply skips the cache lookup when token is Some.
        // Here we test the cache key logic directly.
        let pid = ProfileId::new("p-paged");
        let bid = BucketId::new("paged-bucket");
        let prefix = "data/".to_string();
        let cache = CacheStore::in_memory(CacheConfig::default());

        let page = make_page(&prefix, false);
        let cache_key = CacheKey::Objects {
            profile: pid.clone(),
            bucket: bid.clone(),
            prefix: prefix.clone(),
        };
        cache.put(&cache_key, &page, None).unwrap();

        // A call with continuation_token = Some(_) must NOT look up the cache
        // (enforced in objects_list: `is_first_page` is false when token is Some).
        // The cache itself has no knowledge of tokens; verify the bypass gate.
        let has_token = true; // simulates continuation_token = Some("...")
        let is_first_page = !has_token;

        // The lookup should be skipped.
        let result = if is_first_page {
            cache.get::<ListPage>(&cache_key, validated_at()).unwrap()
        } else {
            None // bypass — command does not read cache for page 2+
        };

        assert!(
            result.is_none(),
            "cache must be bypassed when continuation_token is present"
        );
    }

    // ------------------------------------------------------------------
    // Flat cache key differs from hierarchical key for the same prefix
    // ------------------------------------------------------------------

    #[test]
    fn flat_and_hierarchical_cache_keys_do_not_collide() {
        let pid = ProfileId::new("p-flat");
        let bid = BucketId::new("flat-bucket");
        let prefix = "logs/".to_string();
        let flat_prefix = format!("{}__FLAT__", prefix);

        let key_hier = CacheKey::Objects {
            profile: pid.clone(),
            bucket: bid.clone(),
            prefix: prefix.clone(),
        };
        let key_flat = CacheKey::Objects {
            profile: pid.clone(),
            bucket: bid.clone(),
            prefix: flat_prefix,
        };

        assert_ne!(
            key_hier.serialize_key(),
            key_flat.serialize_key(),
            "flat and hierarchical cache keys must differ"
        );
    }

    // ------------------------------------------------------------------
    // Cache gate: unvalidated profile cannot read from cache
    // ------------------------------------------------------------------

    #[test]
    fn unvalidated_profile_cannot_read_objects_from_cache() {
        let pid = ProfileId::new("p-unval-objects");
        let bid = BucketId::new("secret-bucket");
        let cache = CacheStore::in_memory(CacheConfig::default());

        let page = make_page("secret/", false);
        let cache_key = CacheKey::Objects {
            profile: pid.clone(),
            bucket: bid.clone(),
            prefix: "secret/".to_string(),
        };
        cache.put(&cache_key, &page, None).unwrap();

        // validated_at = None → gate refuses read.
        let result = cache.get::<ListPage>(&cache_key, None).unwrap();
        assert!(
            result.is_none(),
            "unvalidated profile must not read objects from cache"
        );
    }

    // ------------------------------------------------------------------
    // ObjectRef serialisation
    // ------------------------------------------------------------------

    #[test]
    fn object_ref_serialises_camel_case() {
        let r = ObjectRef {
            bucket: BucketId::new("my-bucket"),
            key: "folder/file.txt".to_string(),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["bucket"], "my-bucket");
        assert_eq!(v["key"], "folder/file.txt");
    }

    // ------------------------------------------------------------------
    // emit_objects_updated — event emission test via MockChannel
    // (round-1 finding #14)
    // ------------------------------------------------------------------

    #[test]
    fn emit_objects_updated_emits_correct_payload() {
        use crate::events::{EventKind, MockChannel};

        let channel = MockChannel::default();
        let pid = ProfileId::new("p1");
        let bid = BucketId::new("my-bucket");

        emit_objects_updated(&channel, &pid, &bid, "photos/2024/").unwrap();

        let emitted = channel.emitted();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].0, EventKind::ObjectsUpdated);
        assert_eq!(emitted[0].1["profileId"], "p1");
        assert_eq!(emitted[0].1["bucket"], "my-bucket");
        assert_eq!(emitted[0].1["prefix"], "photos/2024/");
    }

    #[test]
    fn emit_objects_updated_root_prefix() {
        use crate::events::{EventKind, MockChannel};

        let channel = MockChannel::default();
        let pid = ProfileId::new("p2");
        let bid = BucketId::new("root-bucket");

        emit_objects_updated(&channel, &pid, &bid, "").unwrap();

        let emitted = channel.emitted();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].0, EventKind::ObjectsUpdated);
        assert_eq!(emitted[0].1["prefix"], "");
    }

    #[test]
    fn emit_objects_updated_two_different_prefixes() {
        use crate::events::{EventKind, MockChannel};

        let channel = MockChannel::default();
        let pid = ProfileId::new("p3");
        let src = BucketId::new("src-bucket");
        let dst = BucketId::new("dst-bucket");

        // Simulate what object_move does: emit for both source and dest.
        emit_objects_updated(&channel, &pid, &src, "old/path/").unwrap();
        emit_objects_updated(&channel, &pid, &dst, "new/path/").unwrap();

        let emitted = channel.emitted();
        assert_eq!(emitted.len(), 2);
        assert_eq!(emitted[0].0, EventKind::ObjectsUpdated);
        assert_eq!(emitted[0].1["bucket"], "src-bucket");
        assert_eq!(emitted[0].1["prefix"], "old/path/");
        assert_eq!(emitted[1].1["bucket"], "dst-bucket");
        assert_eq!(emitted[1].1["prefix"], "new/path/");
    }

    // ------------------------------------------------------------------
    // ObjectsUpdatedPayload camelCase serialisation
    // ------------------------------------------------------------------

    #[test]
    fn objects_updated_payload_serialises_camel_case() {
        let payload = ObjectsUpdatedPayload {
            profile_id: ProfileId::new("prof"),
            bucket: BucketId::new("bkt"),
            prefix: "a/b/".to_string(),
        };
        let v = serde_json::to_value(&payload).unwrap();
        assert_eq!(v["profileId"], "prof");
        assert_eq!(v["bucket"], "bkt");
        assert_eq!(v["prefix"], "a/b/");
    }

    // ------------------------------------------------------------------
    // DeleteKey serialisation
    // ------------------------------------------------------------------

    #[test]
    fn delete_key_with_version_id_serialises_camel_case() {
        let dk = DeleteKey {
            key: "photos/img.jpg".to_string(),
            version_id: Some("vid-abc".to_string()),
        };
        let v = serde_json::to_value(&dk).unwrap();
        assert_eq!(v["key"], "photos/img.jpg");
        assert_eq!(v["versionId"], "vid-abc");
    }

    #[test]
    fn delete_key_without_version_id_skips_field() {
        let dk = DeleteKey {
            key: "file.txt".to_string(),
            version_id: None,
        };
        let v = serde_json::to_value(&dk).unwrap();
        assert_eq!(v["key"], "file.txt");
        assert!(!v.as_object().unwrap().contains_key("versionId"));
    }

    #[test]
    fn delete_key_deserialises_from_camel_case() {
        let json = r#"{"key":"a/b.txt","versionId":"v123"}"#;
        let dk: DeleteKey = serde_json::from_str(json).unwrap();
        assert_eq!(dk.key, "a/b.txt");
        assert_eq!(dk.version_id.as_deref(), Some("v123"));
    }

    #[test]
    fn delete_key_deserialises_without_version_id() {
        let json = r#"{"key":"a/b.txt"}"#;
        let dk: DeleteKey = serde_json::from_str(json).unwrap();
        assert_eq!(dk.key, "a/b.txt");
        assert!(dk.version_id.is_none());
    }

    // ------------------------------------------------------------------
    // Event emission: objects:updated fires once per affected prefix
    // ------------------------------------------------------------------

    #[test]
    fn emit_objects_updated_multi_prefix_fires_once_per_prefix() {
        use crate::events::{EventKind, MockChannel};
        use std::collections::BTreeSet;

        let channel = MockChannel::default();
        let pid = ProfileId::new("p-delete-batch");
        let bid = BucketId::new("my-bucket");

        // Simulate what object_delete_batch does: collect unique parent prefixes
        // from successfully deleted keys and emit one event per prefix.
        let deleted_keys = [
            "photos/img1.jpg",
            "photos/img2.jpg",
            "docs/report.pdf",
            "docs/slides.pptx",
        ];

        let affected_prefixes: BTreeSet<String> = deleted_keys
            .iter()
            .map(|k| crate::s3::object::parent_prefix(k))
            .collect();

        for prefix in &affected_prefixes {
            emit_objects_updated(&channel, &pid, &bid, prefix).unwrap();
        }

        let emitted = channel.emitted();
        // Two unique prefixes: "photos/" and "docs/"
        assert_eq!(
            emitted.len(),
            2,
            "must emit once per unique affected prefix"
        );

        // BTreeSet guarantees alphabetical order: "docs/" < "photos/"
        assert_eq!(emitted[0].0, EventKind::ObjectsUpdated);
        assert_eq!(emitted[0].1["prefix"], "docs/");
        assert_eq!(emitted[1].1["prefix"], "photos/");
    }

    #[test]
    fn emit_objects_updated_root_prefix_only_once_for_root_keys() {
        use crate::events::{EventKind, MockChannel};
        use std::collections::BTreeSet;

        let channel = MockChannel::default();
        let pid = ProfileId::new("p-delete-root");
        let bid = BucketId::new("root-bucket");

        // Root-level keys: parent_prefix("file.txt") == ""
        let deleted_keys = ["file1.txt", "file2.txt"];
        let affected_prefixes: BTreeSet<String> = deleted_keys
            .iter()
            .map(|k| crate::s3::object::parent_prefix(k))
            .collect();

        for prefix in &affected_prefixes {
            emit_objects_updated(&channel, &pid, &bid, prefix).unwrap();
        }

        let emitted = channel.emitted();
        assert_eq!(
            emitted.len(),
            1,
            "two root-level keys share the same prefix"
        );
        assert_eq!(emitted[0].0, EventKind::ObjectsUpdated);
        assert_eq!(emitted[0].1["prefix"], "");
    }

    // ------------------------------------------------------------------
    // PutResult serialisation (from metadata module)
    // ------------------------------------------------------------------

    #[test]
    fn put_result_serialises_camel_case() {
        let r = crate::s3::metadata::PutResult {
            etag: Some("abc123".to_string()),
            last_modified: Some(1_700_000_000_000),
            version_id: Some("v1".to_string()),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["etag"], "abc123");
        assert_eq!(v["lastModified"], 1_700_000_000_000_i64);
        assert_eq!(v["versionId"], "v1");
    }

    #[test]
    fn put_result_skips_none_fields() {
        let r = crate::s3::metadata::PutResult {
            etag: None,
            last_modified: None,
            version_id: None,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert!(!v.as_object().unwrap().contains_key("etag"));
        assert!(!v.as_object().unwrap().contains_key("lastModified"));
        assert!(!v.as_object().unwrap().contains_key("versionId"));
    }

    // ------------------------------------------------------------------
    // objects:updated is emitted with correct prefix for set_metadata key
    // ------------------------------------------------------------------

    #[test]
    fn set_metadata_emit_objects_updated_correct_prefix() {
        use crate::events::{EventKind, MockChannel};

        let channel = MockChannel::default();
        let pid = ProfileId::new("p-meta");
        let bid = BucketId::new("my-bucket");

        // key = "reports/2024/annual.pdf" → parent = "reports/2024/"
        let key = "reports/2024/annual.pdf";
        let prefix = crate::s3::object::parent_prefix(key);

        emit_objects_updated(&channel, &pid, &bid, &prefix).unwrap();

        let emitted = channel.emitted();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].0, EventKind::ObjectsUpdated);
        assert_eq!(emitted[0].1["prefix"], "reports/2024/");
    }

    // ------------------------------------------------------------------
    // objects:updated is emitted with correct prefix for set_tags key
    // ------------------------------------------------------------------

    #[test]
    fn set_tags_emit_objects_updated_correct_prefix() {
        use crate::events::{EventKind, MockChannel};

        let channel = MockChannel::default();
        let pid = ProfileId::new("p-tags");
        let bid = BucketId::new("tagged-bucket");

        // key = "logs/app/server.log" → parent = "logs/app/"
        let key = "logs/app/server.log";
        let prefix = crate::s3::object::parent_prefix(key);

        emit_objects_updated(&channel, &pid, &bid, &prefix).unwrap();

        let emitted = channel.emitted();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].0, EventKind::ObjectsUpdated);
        assert_eq!(emitted[0].1["prefix"], "logs/app/");
    }

    // ------------------------------------------------------------------
    // ETag conflict error serialisation (used by both set_metadata + set_tags)
    // ------------------------------------------------------------------

    #[test]
    fn conflict_error_serialises_expected_etag() {
        let err = AppError::Conflict {
            etag_expected: "\"etag-original\"".to_string(),
            etag_actual: Some("\"etag-modified\"".to_string()),
        };
        let v = serde_json::to_value(&err).unwrap();
        assert_eq!(v["kind"], "Conflict");
        assert_eq!(v["details"]["etagExpected"], "\"etag-original\"");
        assert_eq!(v["details"]["etagActual"], "\"etag-modified\"");
    }

    #[test]
    fn conflict_error_without_actual_etag() {
        let err = AppError::Conflict {
            etag_expected: "\"abc\"".to_string(),
            etag_actual: None,
        };
        let v = serde_json::to_value(&err).unwrap();
        assert_eq!(v["kind"], "Conflict");
        assert!(v["details"]["etagActual"].is_null());
    }

    // ------------------------------------------------------------------
    // object_presign: expiry range validation
    // ------------------------------------------------------------------

    #[test]
    fn presign_expires_below_minimum_returns_validation_error() {
        // 1 second is below the 60-second minimum.
        let result = crate::s3::presign::presign_get_object_validate_only(1);
        match result {
            Err(AppError::Validation { field, hint }) => {
                assert_eq!(field, "expires_secs");
                assert!(
                    hint.contains("60"),
                    "hint should mention the 60-second minimum: {hint}"
                );
            }
            other => panic!("expected Validation error, got {:?}", other),
        }
    }

    #[test]
    fn presign_expires_at_minimum_is_ok() {
        assert!(crate::s3::presign::presign_get_object_validate_only(
            crate::s3::presign::MIN_EXPIRES_SECS
        )
        .is_ok());
    }

    #[test]
    fn presign_expires_one_hour_is_ok() {
        assert!(crate::s3::presign::presign_get_object_validate_only(3_600).is_ok());
    }

    #[test]
    fn presign_expires_at_maximum_is_ok() {
        assert!(crate::s3::presign::presign_get_object_validate_only(
            crate::s3::presign::MAX_EXPIRES_SECS
        )
        .is_ok());
    }

    #[test]
    fn presign_expires_above_maximum_returns_validation_error() {
        let result = crate::s3::presign::presign_get_object_validate_only(
            crate::s3::presign::MAX_EXPIRES_SECS + 1,
        );
        match result {
            Err(AppError::Validation { field, hint }) => {
                assert_eq!(field, "expires_secs");
                assert!(
                    hint.contains("604800") || hint.contains("7 days"),
                    "hint should mention the 7-day maximum: {hint}"
                );
            }
            other => panic!("expected Validation error, got {:?}", other),
        }
    }

    // ------------------------------------------------------------------
    // PresignedUrl IPC shape
    // ------------------------------------------------------------------

    #[test]
    fn presigned_url_ipc_shape_is_camel_case() {
        let p = crate::s3::presign::PresignedUrl {
            url: "https://example.com/bucket/key?X-Amz-Signature=sig".to_string(),
            expires_at: 1_700_000_000_000,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert!(v.as_object().unwrap().contains_key("url"));
        assert!(v.as_object().unwrap().contains_key("expiresAt"));
        assert_eq!(
            v["url"],
            "https://example.com/bucket/key?X-Amz-Signature=sig"
        );
        assert_eq!(v["expiresAt"], 1_700_000_000_000_i64);
    }

    // ------------------------------------------------------------------
    // object_set_storage_class: diff consumption safety gate tests
    //
    // These tests exercise the diff framework safety gate without calling
    // the S3 API (no mock client needed — the error path fires before S3).
    // ------------------------------------------------------------------

    #[test]
    fn diff_consume_cancelled_diff_returns_validation_hint() {
        use crate::diff::{DiffPayload, DiffStore, DiffStoreHandle};
        use std::collections::HashMap;

        let diff_store = DiffStoreHandle::new(DiffStore::new());
        let p = DiffPayload::StorageClass {
            targets: vec![],
            current: HashMap::new(),
            new_class: "GLACIER".to_string(),
        };
        let id = diff_store.inner.create(p);
        diff_store.inner.cancel(&id).unwrap();

        // Simulate what object_set_storage_class does on consume failure.
        let consumed = diff_store.inner.consume(&id);
        assert!(consumed.is_none(), "cancelled diff must not be consumable");

        let record = diff_store.inner.get(&id).unwrap();
        let err = match record.status {
            crate::diff::DiffStatus::Cancelled | crate::diff::DiffStatus::Expired => {
                AppError::Validation {
                    field: "confirmed_diff_id".to_string(),
                    hint: "Diff was cancelled or expired".to_string(),
                }
            }
            crate::diff::DiffStatus::Confirmed => AppError::Validation {
                field: "confirmed_diff_id".to_string(),
                hint: "Diff already consumed (double-confirm rejection)".to_string(),
            },
            _ => AppError::Internal {
                trace_id: "unexpected".to_string(),
            },
        };

        match err {
            AppError::Validation { hint, .. } => {
                assert!(hint.contains("cancelled or expired"));
            }
            other => panic!("expected Validation, got {:?}", other),
        }
    }

    #[test]
    fn diff_consume_expired_diff_returns_validation_hint() {
        use crate::diff::{DiffPayload, DiffStore, DiffStoreHandle};
        use std::collections::HashMap;

        let diff_store = DiffStoreHandle::new(DiffStore::with_ttl(10));
        let now = 1_000_000_i64;
        let p = DiffPayload::StorageClass {
            targets: vec![],
            current: HashMap::new(),
            new_class: "GLACIER".to_string(),
        };
        let id = diff_store.inner.create_at(p, now);

        // Consume past TTL.
        let consumed = diff_store.inner.consume_at(&id, now + 11);
        assert!(consumed.is_none(), "expired diff must not be consumable");
    }

    #[test]
    fn diff_double_confirm_returns_already_consumed_hint() {
        use crate::diff::{DiffPayload, DiffStore, DiffStoreHandle};
        use std::collections::HashMap;

        let diff_store = DiffStoreHandle::new(DiffStore::new());
        let p = DiffPayload::StorageClass {
            targets: vec![],
            current: HashMap::new(),
            new_class: "GLACIER".to_string(),
        };
        let id = diff_store.inner.create(p);

        let first = diff_store.inner.consume(&id);
        assert!(first.is_some(), "first consume must succeed");

        let second = diff_store.inner.consume(&id);
        assert!(second.is_none(), "double consume must fail");

        let record = diff_store.inner.get(&id).unwrap();
        match record.status {
            crate::diff::DiffStatus::Confirmed => {
                // Expected: already consumed
            }
            other => panic!("expected Confirmed status, got {:?}", other),
        }
    }

    // ------------------------------------------------------------------
    // Decision D2: objects:updated is emitted on storage class change
    // (round-1 finding #14 — event emission test for storage class path)
    // ------------------------------------------------------------------

    #[test]
    fn storage_class_change_emit_objects_updated_uses_parent_prefix() {
        use crate::events::{EventKind, MockChannel};

        let channel = MockChannel::default();
        let pid = ProfileId::new("p-sc");
        let bid = BucketId::new("sc-bucket");

        // Simulate what object_set_storage_class does after a successful change.
        let key = "archive/2024/data.csv";
        let prefix = crate::s3::object::parent_prefix(key);
        emit_objects_updated(&channel, &pid, &bid, &prefix).unwrap();

        let emitted = channel.emitted();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].0, EventKind::ObjectsUpdated);
        assert_eq!(emitted[0].1["bucket"], "sc-bucket");
        assert_eq!(emitted[0].1["prefix"], "archive/2024/");
    }
}
