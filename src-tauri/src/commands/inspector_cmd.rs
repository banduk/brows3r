//! Tauri commands for bucket and object inspection and capability cache management.
//!
//! # Commands
//!
//! - `bucket_inspect`   — aggregate all read-only bucket properties into a
//!                        `BucketInspectorReport`; each section reports
//!                        `value | denied | unsupported | deferred`.
//! - `object_inspect`   — aggregate per-object properties (head + tags + acl
//!                        summary + restore status) into an
//!                        `ObjectInspectorReport`; sections degrade gracefully
//!                        on `AccessDenied` or unsupported APIs.
//! - `capability_get`   — return the known capability map for a profile
//!                        (optionally scoped to one bucket or op).
//! - `capability_clear` — manually reset cached capabilities for a profile.

use tauri::State;

use crate::{
    cache::capability::{CapabilityHandle, CapabilityMap, ClearScope},
    error::AppError,
    ids::{BucketId, ProfileId},
    profiles::ProfileStoreHandle,
    s3::{
        inspector::{
            head_object, inspect_bucket, inspect_object, BucketInspectorReport, ObjectHead,
            ObjectInspectorReport,
        },
        S3ClientPoolHandle,
    },
};

// ---------------------------------------------------------------------------
// bucket_inspect
// ---------------------------------------------------------------------------

/// Inspect a bucket and return an aggregated `BucketInspectorReport`.
///
/// Each section in the report carries one of:
/// - `{ kind: "value", value: T }` — successful fetch.
/// - `{ kind: "denied", iamAction }` — IAM permission denied.
/// - `{ kind: "unsupported", reason }` — provider does not implement the API.
/// - `{ kind: "deferred", reason }` — intentionally absent in v1.
///
/// `bucket_policy` is always `Deferred { reason: "Deferred from v1" }` per the
/// v1 non-goals in the proposal.
///
/// All `AccessDenied` outcomes are automatically recorded into the
/// `CapabilityCache` so future UI renders show disabled reasons without re-
/// querying.
#[tauri::command]
pub async fn bucket_inspect(
    profile_id: ProfileId,
    bucket: String,
    store: State<'_, ProfileStoreHandle>,
    pool: State<'_, S3ClientPoolHandle>,
    capability_cache: State<'_, CapabilityHandle>,
) -> Result<BucketInspectorReport, AppError> {
    // Validation gate: refuse to serve data for unvalidated profiles (AC-8 /
    // round-1 finding #9). The capability cache is also gated, but this is
    // defence-in-depth.
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
            reason: "Profile has not been validated".to_string(),
        });
    }

    // Resolve the per-bucket client. Use the profile's region override or
    // default region if set; fall back to us-east-1 otherwise. Background
    // region discovery (task 23) refines this for region-redirected clients.
    let region = region_override
        .or(default_region)
        .unwrap_or_else(|| "us-east-1".to_string());
    let client = pool
        .inner
        .get_or_build(&profile_id, &region)
        .await
        .ok_or_else(|| AppError::Internal {
            trace_id: uuid::Uuid::new_v4().to_string(),
        })?;

    inspect_bucket(&client, &bucket, capability_cache.inner(), &profile_id).await
}

// ---------------------------------------------------------------------------
// object_inspect
// ---------------------------------------------------------------------------

/// Inspect a single S3 object and return an aggregated `ObjectInspectorReport`.
///
/// The report includes:
/// - `head` — all `HeadObject` properties including user-defined metadata.
/// - `tags` — object tags from `GetObjectTagging`.
/// - `acl_summary` — ACL summary from `GetObjectAcl`.
/// - `restore_status` — Glacier/Deep Archive restore status parsed from the
///   `Restore` header on `HeadObject`.
/// - `version_id` — version ID from `HeadObject` (also on `head.version_id`).
/// - `checksum_sha256`, `checksum_md5`, `checksum_crc32` — checksums when
///   available.
///
/// `AccessDenied` on tags or ACL degrades to `SectionResult::Denied` rather
/// than a hard error, and the denial is cached so the UI shows disabled
/// reasons without re-querying.
#[tauri::command]
pub async fn object_inspect(
    profile_id: ProfileId,
    bucket: String,
    key: String,
    version_id: Option<String>,
    store: State<'_, ProfileStoreHandle>,
    pool: State<'_, S3ClientPoolHandle>,
    capability_cache: State<'_, CapabilityHandle>,
) -> Result<ObjectInspectorReport, AppError> {
    // Validation gate: same as bucket_inspect (AC-8 / round-1 finding #9).
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
            reason: "Profile has not been validated".to_string(),
        });
    }

    let region = region_override
        .or(default_region)
        .unwrap_or_else(|| "us-east-1".to_string());
    let client = pool
        .inner
        .get_or_build(&profile_id, &region)
        .await
        .ok_or_else(|| AppError::Internal {
            trace_id: uuid::Uuid::new_v4().to_string(),
        })?;

    inspect_object(
        &client,
        &bucket,
        &key,
        version_id,
        capability_cache.inner(),
        &profile_id,
    )
    .await
}

// ---------------------------------------------------------------------------
// CapabilityScope
// ---------------------------------------------------------------------------

/// Scope selector for `capability_get`.
///
/// `All` returns every capability for the profile; `Bucket` and `Op` act as
/// filters.  These are distinct from `ClearScope` because future variants may
/// differ between read and write paths.
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CapabilityScope {
    /// Return every capability for the profile.
    All,
    /// Return only capabilities for the given bucket.
    Bucket { bucket_id: BucketId },
    /// Return only capabilities for the given operation string.
    Op { op: String },
}

// ---------------------------------------------------------------------------
// capability_get
// ---------------------------------------------------------------------------

/// Return the cached capability map for `profile_id`, optionally filtered by
/// `scope`.
///
/// The returned `CapabilityMap` keys are `"<bucket>/<op>"` where `<bucket>` is
/// empty for profile-level operations.
#[tauri::command]
pub async fn capability_get(
    profile_id: ProfileId,
    scope: CapabilityScope,
    cap: State<'_, CapabilityHandle>,
) -> Result<CapabilityMap, AppError> {
    let cache = cap.inner();
    let full_map = cache.get_map(&profile_id);

    let filtered = match scope {
        CapabilityScope::All => full_map,
        CapabilityScope::Bucket { bucket_id } => {
            let prefix = format!("{}/", bucket_id.as_str());
            full_map
                .into_iter()
                .filter(|(k, _)| k.starts_with(&prefix))
                .collect()
        }
        CapabilityScope::Op { op } => {
            let suffix = format!("/{op}");
            full_map
                .into_iter()
                .filter(|(k, _)| k.ends_with(&suffix))
                .collect()
        }
    };

    Ok(filtered)
}

// ---------------------------------------------------------------------------
// capability_clear
// ---------------------------------------------------------------------------

/// Clear cached capabilities for `profile_id`.
///
/// When `scope` is `None` all entries for the profile are removed (equivalent
/// to `ClearScope::All`).
#[tauri::command]
pub async fn capability_clear(
    profile_id: ProfileId,
    scope: Option<ClearScopeDto>,
    cap: State<'_, CapabilityHandle>,
) -> Result<(), AppError> {
    let clear_scope = match scope {
        None | Some(ClearScopeDto::All) => ClearScope::All,
        Some(ClearScopeDto::Bucket { bucket_id }) => ClearScope::Bucket(bucket_id),
        Some(ClearScopeDto::Op { op }) => ClearScope::Op(op),
    };
    cap.inner().clear(&profile_id, &clear_scope);
    Ok(())
}

// ---------------------------------------------------------------------------
// ClearScopeDto — IPC-friendly version of ClearScope
// ---------------------------------------------------------------------------

/// IPC-friendly discriminated union for `capability_clear`.
///
/// Mirrors `ClearScope` but uses serde-tagged form so the frontend can pass
/// `{ kind: "bucket", bucketId: "my-bucket" }` etc.
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ClearScopeDto {
    All,
    Bucket { bucket_id: BucketId },
    Op { op: String },
}

// ---------------------------------------------------------------------------
// object_head
// ---------------------------------------------------------------------------

/// Fetch HEAD-only metadata for a single S3 object.
///
/// Lighter than `object_inspect` — only calls `HeadObject`, no tag or ACL
/// fetches.  Used by the preview pane to obtain `contentLength` (for the size-
/// limit check) and `contentType` (for MIME routing) without the overhead of
/// the full inspector report.
///
/// # Validation gate
///
/// Refuses to serve data for profiles that have not been validated in the
/// current session (AC-8 / round-1 finding #9).
#[tauri::command]
pub async fn object_head(
    profile_id: ProfileId,
    bucket: String,
    key: String,
    version_id: Option<String>,
    store: State<'_, ProfileStoreHandle>,
    pool: State<'_, S3ClientPoolHandle>,
) -> Result<ObjectHead, AppError> {
    // Validation gate.
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
            reason: "Profile has not been validated".to_string(),
        });
    }

    let region = region_override
        .or(default_region)
        .unwrap_or_else(|| "us-east-1".to_string());
    let client = pool
        .inner
        .get_or_build(&profile_id, &region)
        .await
        .ok_or_else(|| AppError::Internal {
            trace_id: uuid::Uuid::new_v4().to_string(),
        })?;

    head_object(&client, &bucket, &key, version_id).await
}
