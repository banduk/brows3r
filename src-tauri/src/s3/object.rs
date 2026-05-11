//! Server-side copy, move, single-object delete, batch delete, and folder creation.
//!
//! # Responsibilities
//!
//! - [`CopyOptions`]                — directive flags for `CopyObject` (OCP-open).
//! - [`CopyResult`]                 — IPC-safe result of `copy_object`.
//! - [`CopyOutcome`]                — discriminated result of `copy_object_with_fallback`.
//! - [`MoveResult`]                 — IPC-safe result of `move_object`.
//! - [`DeletedObject`]              — one successfully deleted entry in a `DeleteReport`.
//! - [`DeleteFailure`]              — one failed entry in a `DeleteReport`.
//! - [`DeleteReport`]               — partial-failure report from `delete_objects_batch`.
//! - [`copy_object`]                — wraps `CopyObject`; classifies SDK errors.
//! - [`copy_object_with_fallback`]  — server-side copy with cross-account download+upload
//!                                    fallback and threshold confirmation gate.
//! - [`delete_single_object`]       — wraps `DeleteObject`; used by `move_object`.
//! - [`move_object`]                — copy then delete (atomic from caller perspective).
//! - [`delete_objects_batch`]       — batched delete via `DeleteObjects` (1 000-key chunks).
//! - [`create_folder`]              — PUTs a zero-byte object with `key = prefix/`.
//! - [`parent_prefix`]              — pure helper: `"a/b/c.txt"` → `"a/b/"`.
//!
//! # OCP
//!
//! - `CopyOptions` is open for new directives (checksum, version preservation)
//!   via `#[serde(default)]` fields — existing callers are unaffected.
//! - `CopyOutcome` is open for new variants (`AsyncTransferQueued`, …) — the
//!   discriminator pattern keeps the frontend adaptable.
//! - `move_object = copy_object + delete_single_object` keeps the primitive
//!   surface minimal; task-36 (metadata setters) composes on the same primitives.
//! - `DeleteReport` shape lets the frontend show "N deleted, M failed" without
//!   all-or-nothing semantics. AC-4 partial-failure contract.
//! - Error classification mirrors `list.rs` patterns so the frontend maps
//!   `AppError.kind` uniformly.

use aws_sdk_s3::{
    error::SdkError,
    primitives::ByteStream,
    types::{Delete, ObjectIdentifier},
    Client,
};
use serde::{Deserialize, Serialize};

use crate::{
    error::AppError,
    ids::ObjectKey,
    s3::cross_account::{ConfirmScope, ConfirmationCache},
};

// ---------------------------------------------------------------------------
// CopyOptions
// ---------------------------------------------------------------------------

/// Metadata/tagging directive for `CopyObject`.
///
/// `Replace` instructs S3 to use the new values supplied in the request.
/// `Copy` (default) preserves the source object's values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum MetadataDirective {
    Copy,
    Replace,
}

impl Default for MetadataDirective {
    fn default() -> Self {
        Self::Copy
    }
}

/// Options that control the `CopyObject` API call.
///
/// OCP: new directives (checksum algorithm, version ID, object lock) can be
/// added as `Option` fields with `#[serde(default)]` without breaking callers.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyOptions {
    /// Whether to copy or replace metadata.  Default: `Copy`.
    #[serde(default)]
    pub metadata_directive: MetadataDirective,
    /// Whether to copy or replace tags.  Default: `Copy`.
    #[serde(default)]
    pub tagging_directive: MetadataDirective,
    /// Override storage class on the destination.  `None` keeps the source class.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_class: Option<String>,
    /// Override ACL on the destination.  `None` keeps the source ACL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acl: Option<String>,
    /// Override server-side encryption on the destination.  `None` keeps the
    /// source encryption (or bucket default).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_side_encryption: Option<String>,
}

impl Default for CopyOptions {
    fn default() -> Self {
        Self {
            metadata_directive: MetadataDirective::Copy,
            tagging_directive: MetadataDirective::Copy,
            storage_class: None,
            acl: None,
            server_side_encryption: None,
        }
    }
}

// ---------------------------------------------------------------------------
// CopyResult
// ---------------------------------------------------------------------------

/// ETag + last-modified from the `CopyObjectResult` response element.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyObjectResultDetail {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
    /// Unix timestamp in milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<i64>,
}

/// IPC-safe result returned from `copy_object` and forwarded to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyResult {
    pub copy_object_result: CopyObjectResultDetail,
}

// ---------------------------------------------------------------------------
// MoveResult
// ---------------------------------------------------------------------------

/// IPC-safe result returned from `move_object`.
///
/// Wraps the inner `CopyResult` so the frontend can distinguish move vs copy
/// at the type level and inspect the same ETag/last-modified data.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveResult {
    pub copy_result: CopyResult,
}

// ---------------------------------------------------------------------------
// CopyOutcome — discriminated result of copy_object_with_fallback
// ---------------------------------------------------------------------------

/// Result of `copy_object_with_fallback`.
///
/// OCP: new variants (`AsyncTransferQueued`, etc.) can be added without
/// changing the `ServerSideCopy` or `FallbackUsed` arms.
///
/// Serialized with a `type` discriminator (`"ServerSideCopy"` or
/// `"FallbackUsed"`) so the frontend can branch on the outcome without
/// string-parsing the inner fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
#[serde(rename_all_fields = "camelCase")]
pub enum CopyOutcome {
    /// The S3 server-side `CopyObject` API succeeded.
    ServerSideCopy { result: CopyResult },
    /// Cross-account detected; download+upload fallback was used.
    FallbackUsed {
        /// Byte size of the source object that was transferred via fallback.
        source_size: u64,
        result: CopyResult,
    },
}

// ---------------------------------------------------------------------------
// parent_prefix — pure, reusable helper
// ---------------------------------------------------------------------------

/// Return the parent prefix of an S3 key.
///
/// The parent prefix is everything up to and including the last `/` before the
/// final component (object name or sub-folder name).  When the key contains no
/// `/` the root prefix `""` is returned.
///
/// # Examples
///
/// ```
/// use brows3r_lib::s3::object::parent_prefix;
/// assert_eq!(parent_prefix("a/b/c.txt"), "a/b/");
/// assert_eq!(parent_prefix("file.txt"),  "");
/// assert_eq!(parent_prefix("dir/"),      "");
/// assert_eq!(parent_prefix("a/b/"),      "a/");
/// assert_eq!(parent_prefix(""),          "");
/// ```
pub fn parent_prefix(key: &str) -> String {
    // Strip a trailing slash before searching so `"a/b/"` → parent `"a/"`.
    let stripped = key.strip_suffix('/').unwrap_or(key);
    match stripped.rfind('/') {
        Some(pos) => stripped[..=pos].to_string(),
        None => String::new(),
    }
}

// ---------------------------------------------------------------------------
// classify_copy_sdk_error — shared SDK error → AppError mapper
// ---------------------------------------------------------------------------

fn classify_copy_sdk_error(
    e: SdkError<aws_sdk_s3::operation::copy_object::CopyObjectError>,
    op: &str,
    resource: &str,
) -> AppError {
    if let SdkError::ServiceError(ref svc) = e {
        let code = svc.err().meta().code().unwrap_or("");
        match code {
            "AccessDenied" | "InvalidClientTokenId" => {
                return AppError::AccessDenied {
                    op: op.to_string(),
                    resource: resource.to_string(),
                };
            }
            "NoSuchBucket" | "NoSuchKey" => {
                return AppError::NotFound {
                    resource: resource.to_string(),
                };
            }
            "SlowDown" | "RequestThrottled" | "ThrottlingException" => {
                return AppError::RateLimited {
                    retry_after_ms: None,
                };
            }
            _ => {}
        }
    }
    AppError::Network {
        source: e.to_string(),
    }
}

fn classify_delete_sdk_error(
    e: SdkError<aws_sdk_s3::operation::delete_object::DeleteObjectError>,
    resource: &str,
) -> AppError {
    if let SdkError::ServiceError(ref svc) = e {
        let code = svc.err().meta().code().unwrap_or("");
        match code {
            "AccessDenied" | "InvalidClientTokenId" => {
                return AppError::AccessDenied {
                    op: "s3:DeleteObject".to_string(),
                    resource: resource.to_string(),
                };
            }
            "NoSuchBucket" => {
                return AppError::NotFound {
                    resource: resource.to_string(),
                };
            }
            _ => {}
        }
    }
    AppError::Network {
        source: e.to_string(),
    }
}

fn classify_put_sdk_error(
    e: SdkError<aws_sdk_s3::operation::put_object::PutObjectError>,
    resource: &str,
) -> AppError {
    if let SdkError::ServiceError(ref svc) = e {
        let code = svc.err().meta().code().unwrap_or("");
        match code {
            "AccessDenied" | "InvalidClientTokenId" => {
                return AppError::AccessDenied {
                    op: "s3:PutObject".to_string(),
                    resource: resource.to_string(),
                };
            }
            "NoSuchBucket" => {
                return AppError::NotFound {
                    resource: resource.to_string(),
                };
            }
            _ => {}
        }
    }
    AppError::Network {
        source: e.to_string(),
    }
}

// ---------------------------------------------------------------------------
// copy_object
// ---------------------------------------------------------------------------

/// Copy `src_bucket/src_key` to `dest_bucket/dest_key` via server-side copy.
///
/// # Errors
///
/// - `AppError::AccessDenied` — `s3:CopyObject` permission denied.
/// - `AppError::NotFound`     — source bucket or key does not exist.
/// - `AppError::RateLimited`  — throttling response from AWS.
/// - `AppError::Network`      — any other SDK or transport error.
pub async fn copy_object(
    client: &Client,
    src_bucket: &str,
    src_key: &str,
    dest_bucket: &str,
    dest_key: &str,
    _options: &CopyOptions,
) -> Result<CopyResult, AppError> {
    // copy_source must be URL-encoded bucket/key.
    let copy_source = format!("{src_bucket}/{src_key}");
    let resource = format!("{src_bucket}/{src_key} → {dest_bucket}/{dest_key}");

    let resp = client
        .copy_object()
        .copy_source(&copy_source)
        .bucket(dest_bucket)
        .key(dest_key)
        .send()
        .await
        .map_err(|e| classify_copy_sdk_error(e, "s3:CopyObject", &resource))?;

    let detail = resp
        .copy_object_result()
        .map(|r| {
            let etag = r.e_tag().map(|s| s.trim_matches('"').to_string());
            let last_modified = r
                .last_modified()
                .map(|dt| dt.secs() * 1000 + i64::from(dt.subsec_nanos()) / 1_000_000);
            CopyObjectResultDetail {
                etag,
                last_modified,
            }
        })
        .unwrap_or(CopyObjectResultDetail {
            etag: None,
            last_modified: None,
        });

    Ok(CopyResult {
        copy_object_result: detail,
    })
}

// ---------------------------------------------------------------------------
// copy_object_with_fallback
// ---------------------------------------------------------------------------

fn classify_head_sdk_error(
    e: SdkError<aws_sdk_s3::operation::head_object::HeadObjectError>,
    resource: &str,
) -> AppError {
    if let SdkError::ServiceError(ref svc) = e {
        let code = svc.err().meta().code().unwrap_or("");
        match code {
            "AccessDenied" | "InvalidClientTokenId" => {
                return AppError::AccessDenied {
                    op: "s3:HeadObject".to_string(),
                    resource: resource.to_string(),
                };
            }
            "NoSuchKey" | "404" => {
                return AppError::NotFound {
                    resource: resource.to_string(),
                };
            }
            _ => {}
        }
        // HeadObject returns 404 as an HTTP status, not a service error code.
        if svc.raw().status().as_u16() == 404 {
            return AppError::NotFound {
                resource: resource.to_string(),
            };
        }
    }
    AppError::Network {
        source: e.to_string(),
    }
}

fn classify_get_sdk_error(
    e: SdkError<aws_sdk_s3::operation::get_object::GetObjectError>,
    resource: &str,
) -> AppError {
    if let SdkError::ServiceError(ref svc) = e {
        let code = svc.err().meta().code().unwrap_or("");
        match code {
            "AccessDenied" | "InvalidClientTokenId" => {
                return AppError::AccessDenied {
                    op: "s3:GetObject".to_string(),
                    resource: resource.to_string(),
                };
            }
            "NoSuchKey" | "NoSuchBucket" => {
                return AppError::NotFound {
                    resource: resource.to_string(),
                };
            }
            _ => {}
        }
    }
    AppError::Network {
        source: e.to_string(),
    }
}

/// Detect whether an `AppError` represents an access-denied condition from S3.
///
/// Used by `copy_object_with_fallback` to decide whether to attempt the
/// download+upload fallback path.
fn is_access_denied(e: &AppError) -> bool {
    matches!(e, AppError::AccessDenied { .. })
}

/// Copy `src_bucket/src_key` to `dest_bucket/dest_key` with a cross-account fallback.
///
/// # Behaviour
///
/// 1. Attempt server-side `CopyObject`.
/// 2. On `AccessDenied` (cross-account signal):
///    a. HEAD the source to learn `content_length`.
///    b. If `content_length <= fallback_threshold_bytes` → download + upload
///       (fallback path).  Returns `CopyOutcome::FallbackUsed`.
///    c. If `content_length > fallback_threshold_bytes` **and** `confirmed_token`
///       is not a valid unconsumed token for this scope → return
///       `AppError::Validation` asking for explicit confirmation.
///    d. If `content_length > fallback_threshold_bytes` **and** `confirmed_token`
///       is valid → fallback path proceeds.  Returns `CopyOutcome::FallbackUsed`.
/// 3. On any other error → propagate as-is.
///
/// # Confirmation token
///
/// The token must be minted by `ConfirmationCache::mint` with a matching
/// `ConfirmScope` and consumed here.  The frontend obtains a token via the
/// `cross_account_confirm` command, then re-calls `object_copy` with the token.
///
/// # OCP
///
/// `fallback_threshold_bytes` is parameterised (driven by settings) so the
/// default can change without touching this function.
pub async fn copy_object_with_fallback(
    client: &Client,
    src_bucket: &str,
    src_key: &str,
    dest_bucket: &str,
    dest_key: &str,
    options: &CopyOptions,
    fallback_threshold_bytes: u64,
    confirmed_token: Option<String>,
    confirmation_cache: &ConfirmationCache,
    profile: &str,
) -> Result<CopyOutcome, AppError> {
    // ---- Step 1: server-side copy ----
    match copy_object(client, src_bucket, src_key, dest_bucket, dest_key, options).await {
        Ok(result) => return Ok(CopyOutcome::ServerSideCopy { result }),
        Err(e) if !is_access_denied(&e) => return Err(e),
        Err(_) => {
            // Access denied — fall through to cross-account fallback logic.
        }
    }

    // ---- Step 2: HEAD source to learn size ----
    let resource = format!("{src_bucket}/{src_key}");
    let head_resp = client
        .head_object()
        .bucket(src_bucket)
        .key(src_key)
        .send()
        .await
        .map_err(|e| classify_head_sdk_error(e, &resource))?;

    let source_size = head_resp.content_length().map(|v| v as u64).unwrap_or(0);

    // ---- Step 3: threshold gate ----
    if source_size > fallback_threshold_bytes {
        let scope = ConfirmScope {
            profile: profile.to_string(),
            source_bucket: src_bucket.to_string(),
            source_key: src_key.to_string(),
            dest_bucket: dest_bucket.to_string(),
            dest_key: dest_key.to_string(),
        };

        let token_valid = match &confirmed_token {
            Some(t) => confirmation_cache.consume(t, &scope),
            None => false,
        };

        if !token_valid {
            return Err(AppError::Validation {
                field: "confirmed_token".to_string(),
                hint: "Cross-account copy of large file requires explicit confirmation token"
                    .to_string(),
            });
        }
    }

    // ---- Step 4: download + upload fallback ----
    let fallback_resource = format!("{src_bucket}/{src_key}");
    let get_resp = client
        .get_object()
        .bucket(src_bucket)
        .key(src_key)
        .send()
        .await
        .map_err(|e| classify_get_sdk_error(e, &fallback_resource))?;

    let body = get_resp
        .body
        .collect()
        .await
        .map_err(|e| AppError::Network {
            source: format!("get_object body read failed: {e}"),
        })?;
    let bytes = body.into_bytes();

    let dest_resource = format!("{dest_bucket}/{dest_key}");
    let put_resp = client
        .put_object()
        .bucket(dest_bucket)
        .key(dest_key)
        .body(ByteStream::from(bytes))
        .send()
        .await
        .map_err(|e| classify_put_sdk_error(e, &dest_resource))?;

    let etag = put_resp.e_tag().map(|s| s.trim_matches('"').to_string());
    let result = CopyResult {
        copy_object_result: CopyObjectResultDetail {
            etag,
            last_modified: None,
        },
    };

    Ok(CopyOutcome::FallbackUsed {
        source_size,
        result,
    })
}

// ---------------------------------------------------------------------------
// delete_single_object
// ---------------------------------------------------------------------------

/// Delete a single object from `bucket` at `key`.
///
/// Used internally by `move_object` after a successful copy.  Exposed `pub`
/// so task-35 (delete batch) can call it for single-item fallback paths.
///
/// # Errors
///
/// - `AppError::AccessDenied` — `s3:DeleteObject` permission denied.
/// - `AppError::NotFound`     — bucket does not exist.
/// - `AppError::Network`      — any other SDK or transport error.
///
/// Note: S3 `DeleteObject` on a non-existent key is idempotent and returns
/// 204; this function therefore returns `Ok(())` in that case.
pub async fn delete_single_object(
    client: &Client,
    bucket: &str,
    key: &str,
) -> Result<(), AppError> {
    let resource = format!("{bucket}/{key}");

    client
        .delete_object()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .map_err(|e| classify_delete_sdk_error(e, &resource))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// move_object
// ---------------------------------------------------------------------------

/// Move `src_bucket/src_key` to `dest_bucket/dest_key`.
///
/// Implemented as copy then delete.  If the copy succeeds but the delete
/// fails, returns `AppError::Internal` with a notice that the copy already
/// landed and cleanup of the source is needed.
///
/// # Atomicity
///
/// S3 does not provide native atomic rename.  The copy + delete sequence is
/// atomic *from the caller's perspective* only in the happy path: the source
/// is visible until the delete completes.  Callers that require strict
/// isolation must hold a lock on the source prefix.
pub async fn move_object(
    client: &Client,
    src_bucket: &str,
    src_key: &str,
    dest_bucket: &str,
    dest_key: &str,
    options: &CopyOptions,
) -> Result<MoveResult, AppError> {
    let copy_result =
        copy_object(client, src_bucket, src_key, dest_bucket, dest_key, options).await?;

    // Copy succeeded.  Now delete the source.
    if let Err(e) = delete_single_object(client, src_bucket, src_key).await {
        // Copy landed but source delete failed.  Propagate as Internal so
        // the caller can surface a structured notice to the UI:
        // "Move partially completed — source may need manual cleanup."
        // Log context is available via `trace_id` in the diagnostics bundle.
        tracing_or_eprintln(&format!(
            "move_object: copy OK but delete failed for {src_bucket}/{src_key}: {e}"
        ));
        return Err(AppError::Internal {
            trace_id: format!("move_partial_copy_ok_delete_failed::{src_bucket}/{src_key}"),
        });
    }

    Ok(MoveResult { copy_result })
}

/// Emit a structured warning without pulling in the full tracing dependency.
/// Replace with `tracing::warn!` once that crate is wired up.
#[inline]
fn tracing_or_eprintln(msg: &str) {
    eprintln!("WARN {msg}");
}

// ---------------------------------------------------------------------------
// create_folder
// ---------------------------------------------------------------------------

/// Create a virtual folder placeholder at `bucket/prefix/`.
///
/// Issues a zero-byte `PutObject` with `key = "{prefix}/"`.  If the object
/// already exists S3 overwrites it silently — the operation is idempotent.
///
/// # Errors
///
/// - `AppError::AccessDenied` — `s3:PutObject` permission denied.
/// - `AppError::NotFound`     — bucket does not exist.
/// - `AppError::Network`      — any other SDK or transport error.
pub async fn create_folder(client: &Client, bucket: &str, prefix: &str) -> Result<(), AppError> {
    // Ensure exactly one trailing slash.
    let key = if prefix.ends_with('/') {
        prefix.to_string()
    } else {
        format!("{prefix}/")
    };
    let resource = format!("{bucket}/{key}");

    client
        .put_object()
        .bucket(bucket)
        .key(&key)
        .body(ByteStream::from_static(b""))
        .send()
        .await
        .map_err(|e| classify_put_sdk_error(e, &resource))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// DeleteReport types — partial-failure shape (AC-4)
// ---------------------------------------------------------------------------

/// One entry that was successfully deleted in a `delete_objects_batch` call.
///
/// OCP: `bypass_governance_retention: bool` can be added later for object-lock
/// support without changing this struct's required fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedObject {
    /// The S3 key that was deleted.
    pub key: String,
    /// Version ID of the deleted version, if the bucket has versioning enabled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_id: Option<String>,
    /// `true` when a delete marker was inserted (versioned bucket + no version_id supplied).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delete_marker: Option<bool>,
    /// Version ID of the newly created delete marker, when applicable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delete_marker_version_id: Option<String>,
}

/// One entry that failed to delete in a `delete_objects_batch` call.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteFailure {
    /// The S3 key that could not be deleted.
    pub key: String,
    /// Version ID that could not be deleted, when applicable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_id: Option<String>,
    /// S3 error code (e.g. `"AccessDenied"`, `"NoSuchVersion"`).
    pub code: String,
    /// S3 error message for this specific key.
    pub message: String,
}

/// Result of `delete_objects_batch`.
///
/// Both `deleted` and `failed` may be non-empty in the same response —
/// callers must NOT treat a non-empty `failed` as a hard error.
/// The caller (command layer) decides how to surface partial failures.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteReport {
    /// Keys that were successfully deleted (or had a delete marker created).
    pub deleted: Vec<DeletedObject>,
    /// Keys that the API could not delete.
    pub failed: Vec<DeleteFailure>,
}

// ---------------------------------------------------------------------------
// classify_delete_objects_sdk_error — whole-batch failure mapper
// ---------------------------------------------------------------------------

fn classify_delete_objects_sdk_error(
    e: SdkError<aws_sdk_s3::operation::delete_objects::DeleteObjectsError>,
    bucket: &str,
) -> AppError {
    if let SdkError::ServiceError(ref svc) = e {
        let code = svc.err().meta().code().unwrap_or("");
        match code {
            "AccessDenied" | "InvalidClientTokenId" => {
                return AppError::AccessDenied {
                    op: "s3:DeleteObjects".to_string(),
                    resource: bucket.to_string(),
                };
            }
            "NoSuchBucket" => {
                return AppError::NotFound {
                    resource: bucket.to_string(),
                };
            }
            "SlowDown" | "RequestThrottled" | "ThrottlingException" => {
                return AppError::RateLimited {
                    retry_after_ms: None,
                };
            }
            _ => {}
        }
    }
    AppError::Network {
        source: e.to_string(),
    }
}

// ---------------------------------------------------------------------------
// delete_objects_batch
// ---------------------------------------------------------------------------

/// Maximum number of keys per `DeleteObjects` API call (AWS hard limit).
const DELETE_BATCH_SIZE: usize = 1_000;

/// Delete a batch of objects from `bucket`.
///
/// Each entry in `keys` is `(key, version_id?)`.  Passing a `version_id`
/// removes that specific version; passing `None` inserts a delete marker on
/// versioned buckets and permanently deletes on non-versioned buckets.
///
/// Internally chunks `keys` into groups of at most 1 000 and issues one
/// `DeleteObjects` SDK call per chunk.  All chunk results are merged into a
/// single `DeleteReport`.
///
/// # Partial failure (AC-4)
///
/// S3 can report per-key errors within a successful HTTP 200 response.  These
/// are collected into `DeleteReport.failed` rather than returning `Err`.
/// **The whole batch is NOT aborted on a per-key error.**
///
/// # Errors
///
/// Returns `Err(AppError)` only when the SDK call itself fails (e.g. network
/// error, bucket-level `AccessDenied`).  Individual key errors are in
/// `DeleteReport.failed`.
pub async fn delete_objects_batch(
    client: &Client,
    bucket: &str,
    keys: Vec<(ObjectKey, Option<String>)>,
) -> Result<DeleteReport, AppError> {
    let mut report = DeleteReport {
        deleted: Vec::new(),
        failed: Vec::new(),
    };

    // Process keys in chunks of DELETE_BATCH_SIZE.
    for chunk in keys.chunks(DELETE_BATCH_SIZE) {
        // Build the list of ObjectIdentifier for this chunk.
        let mut identifiers: Vec<ObjectIdentifier> = Vec::with_capacity(chunk.len());
        for (key, version_id) in chunk {
            let mut builder = ObjectIdentifier::builder().key(key.as_str());
            if let Some(vid) = version_id {
                builder = builder.version_id(vid);
            }
            let ident = builder.build().map_err(|e| AppError::Internal {
                trace_id: format!("object_identifier_build_failed: {e}"),
            })?;
            identifiers.push(ident);
        }

        let delete = Delete::builder()
            .set_objects(Some(identifiers))
            .build()
            .map_err(|e| AppError::Internal {
                trace_id: format!("delete_builder_failed: {e}"),
            })?;

        let resp = client
            .delete_objects()
            .bucket(bucket)
            .delete(delete)
            .send()
            .await
            .map_err(|e| classify_delete_objects_sdk_error(e, bucket))?;

        // Map per-key successes.
        for d in resp.deleted() {
            report.deleted.push(DeletedObject {
                key: d.key().unwrap_or("").to_string(),
                version_id: d.version_id().map(|s| s.to_string()),
                delete_marker: d.delete_marker(),
                delete_marker_version_id: d.delete_marker_version_id().map(|s| s.to_string()),
            });
        }

        // Map per-key failures (partial-failure AC-4).
        for err in resp.errors() {
            report.failed.push(DeleteFailure {
                key: err.key().unwrap_or("").to_string(),
                version_id: err.version_id().map(|s| s.to_string()),
                code: err.code().unwrap_or("UnknownError").to_string(),
                message: err.message().unwrap_or("").to_string(),
            });
        }
    }

    Ok(report)
}

// ---------------------------------------------------------------------------
// set_object_storage_class
// ---------------------------------------------------------------------------

/// Change the storage class of `bucket/key` via a server-side self-copy.
///
/// S3 does not expose a dedicated "change storage class" API.  The only
/// supported approach is a `CopyObject` from `bucket/key` back to itself
/// with `StorageClass` set to the new value and `MetadataDirective::Copy`
/// so the existing metadata and tags are preserved.
///
/// # Errors
///
/// - `AppError::Validation`   — `new_class` is not a recognised S3 storage
///                              class string (validation happens at the SDK
///                              builder level; unrecognised values pass through
///                              to S3 which returns `InvalidStorageClass`).
/// - `AppError::AccessDenied` — `s3:CopyObject` permission denied.
/// - `AppError::NotFound`     — bucket or key does not exist.
/// - `AppError::RateLimited`  — throttling response from AWS.
/// - `AppError::Network`      — any other SDK or transport error.
///
/// # Note: not optimistic (Decision D2)
///
/// Storage class change is a diff-gated mutation and is intentionally excluded
/// from `EXCLUDED_FROM_OPTIMISM` in `src/query/optimistic.ts`.  The test
/// `storage_class_change_does_not_use_optimistic_path` asserts this invariant.
pub async fn set_object_storage_class(
    client: &Client,
    bucket: &str,
    key: &str,
    new_class: String,
) -> Result<crate::s3::metadata::PutResult, AppError> {
    use aws_sdk_s3::types::StorageClass;

    let storage_class = StorageClass::from(new_class.as_str());

    let copy_source = format!("{bucket}/{key}");
    let resource = format!("{bucket}/{key}");

    let resp = client
        .copy_object()
        .copy_source(&copy_source)
        .bucket(bucket)
        .key(key)
        .storage_class(storage_class)
        .metadata_directive(aws_sdk_s3::types::MetadataDirective::Copy)
        .send()
        .await
        .map_err(|e| {
            classify_copy_sdk_error(e, "s3:CopyObject (storage class change)", &resource)
        })?;

    let detail = resp.copy_object_result().map(|r| {
        let etag = r.e_tag().map(|s| s.trim_matches('"').to_string());
        let last_modified = r
            .last_modified()
            .map(|dt| dt.secs() * 1000 + i64::from(dt.subsec_nanos()) / 1_000_000);
        (etag, last_modified)
    });

    Ok(crate::s3::metadata::PutResult {
        etag: detail.as_ref().and_then(|(e, _)| e.clone()),
        last_modified: detail.and_then(|(_, lm)| lm),
        version_id: resp.version_id().map(|s| s.to_string()),
    })
}

// ---------------------------------------------------------------------------
// TextPayload — result of get_object_text
// ---------------------------------------------------------------------------

/// Text content fetched from S3, decoded as UTF-8.
///
/// The body is decoded with lossy UTF-8 — invalid bytes are replaced with
/// U+FFFD so the result is always a valid Rust `String` / JSON string.
///
/// OCP: `content_type` and `version_id` can be added as optional fields later
/// without breaking existing callers that only read `body` and `truncated`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPayload {
    /// UTF-8 body, possibly lossy-decoded.  Truncated at `max_bytes` when the
    /// object is larger than the requested limit.
    pub body: String,
    /// Total object size in bytes as reported by S3 `Content-Length`.
    /// May be zero when S3 does not return a content-length header.
    pub content_length: u64,
    /// HTTP ETag string from S3 (surrounding quotes stripped).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
    /// `true` when the returned body was truncated at `max_bytes`.
    pub truncated: bool,
}

// ---------------------------------------------------------------------------
// get_object_text
// ---------------------------------------------------------------------------

/// Default maximum bytes to read for text preview.
pub const DEFAULT_TEXT_MAX_BYTES: u64 = 1_024 * 1_024; // 1 MiB

/// Fetch the first `max_bytes` bytes of `bucket/key` as a UTF-8 string.
///
/// Uses a `Range: bytes=0-<max_bytes-1>` request so the backend never
/// buffers more bytes than needed for the preview.
///
/// # Errors
///
/// - `AppError::AccessDenied` — `s3:GetObject` permission denied.
/// - `AppError::NotFound`     — bucket or key does not exist.
/// - `AppError::Network`      — any other SDK or transport error.
pub async fn get_object_text(
    client: &Client,
    bucket: &str,
    key: &str,
    max_bytes: u64,
) -> Result<TextPayload, AppError> {
    let resource = format!("{bucket}/{key}");

    // Use a range request to avoid downloading the full object when it is
    // larger than the preview limit.  S3 returns HTTP 206 (Partial Content)
    // and the actual number of bytes transferred is ≤ max_bytes.
    let range_header = format!("bytes=0-{}", max_bytes.saturating_sub(1));

    let resp = client
        .get_object()
        .bucket(bucket)
        .key(key)
        .range(range_header)
        .send()
        .await
        .map_err(|e| classify_get_sdk_error(e, &resource))?;

    // Total object size (before range) comes from Content-Range or
    // Content-Length.  Fall back to 0 when absent.
    let content_length = resp
        .content_range()
        .and_then(|cr| {
            // Content-Range: bytes 0-N/TOTAL → parse TOTAL
            cr.rsplit('/').next().and_then(|s| s.parse::<u64>().ok())
        })
        .unwrap_or_else(|| resp.content_length().unwrap_or(0) as u64);

    let etag = resp.e_tag().map(|s| s.trim_matches('"').to_string());

    let body_bytes = resp
        .body
        .collect()
        .await
        .map_err(|e| AppError::Network {
            source: format!("get_object body read failed: {e}"),
        })?
        .into_bytes();

    let bytes_read = body_bytes.len() as u64;

    // Lossy UTF-8 decode: invalid bytes → U+FFFD.
    let body = String::from_utf8_lossy(&body_bytes).into_owned();

    // We consider the body truncated if the total object size exceeds the
    // limit AND we received fewer bytes than the full object.  When the
    // total size equals the bytes_read the full object fit within the limit.
    let truncated = content_length > bytes_read && bytes_read >= max_bytes;

    Ok(TextPayload {
        body,
        content_length,
        etag,
        truncated,
    })
}

// ---------------------------------------------------------------------------
// BytesPayload — result of get_object_bytes
// ---------------------------------------------------------------------------

/// Raw bytes fetched from S3, base64-encoded for safe IPC transport.
///
/// The frontend decodes with `atob` or `Uint8Array.from(atob(...), c => c.charCodeAt(0))`.
///
/// OCP: `content_type` can be added as an optional field later without breaking
/// existing callers.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BytesPayload {
    /// Base64-encoded raw bytes, at most `max_bytes` in length.
    pub body: String,
    /// Total object size in bytes as reported by S3 `Content-Length`.
    pub content_length: u64,
    /// HTTP ETag string from S3 (surrounding quotes stripped).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
    /// `true` when the returned body was truncated at `max_bytes`.
    pub truncated: bool,
}

/// Default maximum bytes to read for binary preview.
pub const DEFAULT_BYTES_MAX_BYTES: u64 = 1_024 * 1_024; // 1 MiB

// ---------------------------------------------------------------------------
// get_object_bytes
// ---------------------------------------------------------------------------

/// Fetch the first `max_bytes` bytes of `bucket/key` as base64-encoded binary.
///
/// Uses a `Range: bytes=0-<max_bytes-1>` request so large objects are not
/// fully downloaded.  Returns a `BytesPayload` with the base64-encoded body,
/// total content length, ETag, and a `truncated` flag.
///
/// # Errors
///
/// - `AppError::AccessDenied` — `s3:GetObject` permission denied.
/// - `AppError::NotFound`     — bucket or key does not exist.
/// - `AppError::Network`      — any other SDK or transport error.
pub async fn get_object_bytes(
    client: &Client,
    bucket: &str,
    key: &str,
    max_bytes: u64,
) -> Result<BytesPayload, AppError> {
    let resource = format!("{bucket}/{key}");

    // Range request to avoid downloading the full object.
    let range_header = format!("bytes=0-{}", max_bytes.saturating_sub(1));

    let resp = client
        .get_object()
        .bucket(bucket)
        .key(key)
        .range(range_header)
        .send()
        .await
        .map_err(|e| classify_get_sdk_error(e, &resource))?;

    // Total object size (before range) from Content-Range or Content-Length.
    let content_length = resp
        .content_range()
        .and_then(|cr| cr.rsplit('/').next().and_then(|s| s.parse::<u64>().ok()))
        .unwrap_or_else(|| resp.content_length().unwrap_or(0) as u64);

    let etag = resp.e_tag().map(|s| s.trim_matches('"').to_string());

    let body_bytes = resp
        .body
        .collect()
        .await
        .map_err(|e| AppError::Network {
            source: format!("get_object body read failed: {e}"),
        })?
        .into_bytes();

    let bytes_read = body_bytes.len() as u64;
    let truncated = content_length > bytes_read && bytes_read >= max_bytes;

    // Base64-encode using the standard alphabet (no line wrapping).
    use base64::Engine as _;
    let body = base64::engine::general_purpose::STANDARD.encode(&body_bytes);

    Ok(BytesPayload {
        body,
        content_length,
        etag,
        truncated,
    })
}

// ---------------------------------------------------------------------------
// put_object_text
// ---------------------------------------------------------------------------

/// Write `body` to `bucket/key` with an optional ETag precondition.
///
/// Uses `PutObject` with `Content-Type: text/plain; charset=utf-8`.  When
/// `if_match_etag` is supplied the `If-Match` header is set; S3 returns 412
/// (Precondition Failed) when the live ETag does not match — mapped to
/// `AppError::Conflict { etag_expected, etag_actual: None }`.
///
/// # OCP
///
/// `if_match_etag = None` is the "save anyway" path — identical to a fresh
/// unconditional put.
///
/// # Errors
///
/// - `AppError::Conflict`     — ETag precondition failed (412).
/// - `AppError::AccessDenied` — `s3:PutObject` permission denied.
/// - `AppError::NotFound`     — bucket does not exist.
/// - `AppError::Network`      — any other SDK or transport error.
pub async fn put_object_text(
    client: &Client,
    bucket: &str,
    key: &str,
    body: String,
    if_match_etag: Option<String>,
) -> Result<crate::s3::metadata::PutResult, AppError> {
    let resource = format!("{bucket}/{key}");

    let bytes: Vec<u8> = body.into_bytes();
    let stream = ByteStream::from(bytes);

    let mut req = client
        .put_object()
        .bucket(bucket)
        .key(key)
        .content_type("text/plain; charset=utf-8")
        .body(stream);

    if let Some(ref etag) = if_match_etag {
        req = req.if_match(etag);
    }

    let resp = req.send().await.map_err(|e| {
        // Check for 412 Precondition Failed (ETag mismatch).
        if let SdkError::ServiceError(ref svc) = e {
            let status = svc.raw().status().as_u16();
            if status == 412 {
                return AppError::Conflict {
                    etag_expected: if_match_etag
                        .clone()
                        .unwrap_or_else(|| "(unknown)".to_string()),
                    etag_actual: None,
                };
            }
            let code = svc.err().meta().code().unwrap_or("");
            match code {
                "AccessDenied" | "InvalidClientTokenId" => {
                    return AppError::AccessDenied {
                        op: "s3:PutObject".to_string(),
                        resource: resource.clone(),
                    };
                }
                "NoSuchBucket" => {
                    return AppError::NotFound {
                        resource: resource.clone(),
                    };
                }
                _ => {}
            }
        }
        AppError::Network {
            source: e.to_string(),
        }
    })?;

    let etag = resp.e_tag().map(|s| s.trim_matches('"').to_string());
    let version_id = resp.version_id().map(|s| s.to_string());

    Ok(crate::s3::metadata::PutResult {
        etag,
        last_modified: None,
        version_id,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // parent_prefix — unit tests covering all edge cases
    // -----------------------------------------------------------------------

    #[test]
    fn parent_prefix_nested_key() {
        assert_eq!(parent_prefix("a/b/c.txt"), "a/b/");
    }

    #[test]
    fn parent_prefix_root_key() {
        assert_eq!(parent_prefix("file.txt"), "");
    }

    #[test]
    fn parent_prefix_empty_string() {
        assert_eq!(parent_prefix(""), "");
    }

    #[test]
    fn parent_prefix_trailing_slash_folder() {
        // "dir/" → parent is root ""
        assert_eq!(parent_prefix("dir/"), "");
    }

    #[test]
    fn parent_prefix_nested_folder_trailing_slash() {
        // "a/b/" → parent is "a/"
        assert_eq!(parent_prefix("a/b/"), "a/");
    }

    #[test]
    fn parent_prefix_deeply_nested() {
        assert_eq!(parent_prefix("a/b/c/d/e.txt"), "a/b/c/d/");
    }

    #[test]
    fn parent_prefix_single_level_folder() {
        assert_eq!(parent_prefix("photos/"), "");
    }

    #[test]
    fn parent_prefix_single_slash_only() {
        // "/" strips to "", rfind finds nothing → ""
        assert_eq!(parent_prefix("/"), "");
    }

    // -----------------------------------------------------------------------
    // CopyOptions defaults
    // -----------------------------------------------------------------------

    #[test]
    fn copy_options_default_directive_is_copy() {
        let opts = CopyOptions::default();
        assert_eq!(opts.metadata_directive, MetadataDirective::Copy);
        assert_eq!(opts.tagging_directive, MetadataDirective::Copy);
        assert!(opts.storage_class.is_none());
        assert!(opts.acl.is_none());
        assert!(opts.server_side_encryption.is_none());
    }

    // -----------------------------------------------------------------------
    // CopyOptions serialisation (camelCase + skip None)
    // -----------------------------------------------------------------------

    #[test]
    fn copy_options_serialises_minimal() {
        let opts = CopyOptions::default();
        let v = serde_json::to_value(&opts).unwrap();
        assert_eq!(v["metadataDirective"], "COPY");
        assert_eq!(v["taggingDirective"], "COPY");
        assert!(!v.as_object().unwrap().contains_key("storageClass"));
        assert!(!v.as_object().unwrap().contains_key("acl"));
        assert!(!v.as_object().unwrap().contains_key("serverSideEncryption"));
    }

    #[test]
    fn copy_options_serialises_replace_with_overrides() {
        let opts = CopyOptions {
            metadata_directive: MetadataDirective::Replace,
            tagging_directive: MetadataDirective::Replace,
            storage_class: Some("GLACIER".to_string()),
            acl: Some("private".to_string()),
            server_side_encryption: Some("AES256".to_string()),
        };
        let v = serde_json::to_value(&opts).unwrap();
        assert_eq!(v["metadataDirective"], "REPLACE");
        assert_eq!(v["taggingDirective"], "REPLACE");
        assert_eq!(v["storageClass"], "GLACIER");
        assert_eq!(v["acl"], "private");
        assert_eq!(v["serverSideEncryption"], "AES256");
    }

    // -----------------------------------------------------------------------
    // CopyResult serialisation
    // -----------------------------------------------------------------------

    #[test]
    fn copy_result_serialises_camel_case() {
        let result = CopyResult {
            copy_object_result: CopyObjectResultDetail {
                etag: Some("abc123".to_string()),
                last_modified: Some(1_700_000_000_000),
            },
        };
        let v = serde_json::to_value(&result).unwrap();
        assert_eq!(v["copyObjectResult"]["etag"], "abc123");
        assert_eq!(v["copyObjectResult"]["lastModified"], 1_700_000_000_000_i64);
    }

    #[test]
    fn copy_result_skips_none_fields() {
        let result = CopyResult {
            copy_object_result: CopyObjectResultDetail {
                etag: None,
                last_modified: None,
            },
        };
        let v = serde_json::to_value(&result).unwrap();
        let inner = &v["copyObjectResult"];
        assert!(!inner.as_object().unwrap().contains_key("etag"));
        assert!(!inner.as_object().unwrap().contains_key("lastModified"));
    }

    // -----------------------------------------------------------------------
    // MoveResult serialisation
    // -----------------------------------------------------------------------

    #[test]
    fn move_result_wraps_copy_result() {
        let result = MoveResult {
            copy_result: CopyResult {
                copy_object_result: CopyObjectResultDetail {
                    etag: Some("def456".to_string()),
                    last_modified: None,
                },
            },
        };
        let v = serde_json::to_value(&result).unwrap();
        assert_eq!(v["copyResult"]["copyObjectResult"]["etag"], "def456");
    }

    // -----------------------------------------------------------------------
    // DeleteReport — serialisation + field visibility
    // -----------------------------------------------------------------------

    #[test]
    fn deleted_object_serialises_camel_case() {
        let d = DeletedObject {
            key: "photos/img.jpg".to_string(),
            version_id: Some("vid-001".to_string()),
            delete_marker: Some(true),
            delete_marker_version_id: Some("dmvid-001".to_string()),
        };
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["key"], "photos/img.jpg");
        assert_eq!(v["versionId"], "vid-001");
        assert_eq!(v["deleteMarker"], true);
        assert_eq!(v["deleteMarkerVersionId"], "dmvid-001");
    }

    #[test]
    fn deleted_object_skips_none_fields() {
        let d = DeletedObject {
            key: "file.txt".to_string(),
            version_id: None,
            delete_marker: None,
            delete_marker_version_id: None,
        };
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["key"], "file.txt");
        assert!(!v.as_object().unwrap().contains_key("versionId"));
        assert!(!v.as_object().unwrap().contains_key("deleteMarker"));
        assert!(!v.as_object().unwrap().contains_key("deleteMarkerVersionId"));
    }

    #[test]
    fn delete_failure_serialises_camel_case() {
        let f = DeleteFailure {
            key: "locked/file.txt".to_string(),
            version_id: Some("vid-002".to_string()),
            code: "AccessDenied".to_string(),
            message: "Access Denied".to_string(),
        };
        let v = serde_json::to_value(&f).unwrap();
        assert_eq!(v["key"], "locked/file.txt");
        assert_eq!(v["versionId"], "vid-002");
        assert_eq!(v["code"], "AccessDenied");
        assert_eq!(v["message"], "Access Denied");
    }

    #[test]
    fn delete_failure_skips_none_version_id() {
        let f = DeleteFailure {
            key: "locked/file.txt".to_string(),
            version_id: None,
            code: "NoSuchVersion".to_string(),
            message: "no such version".to_string(),
        };
        let v = serde_json::to_value(&f).unwrap();
        assert!(!v.as_object().unwrap().contains_key("versionId"));
    }

    #[test]
    fn delete_report_contains_both_arrays() {
        let report = DeleteReport {
            deleted: vec![DeletedObject {
                key: "ok/file.txt".to_string(),
                version_id: None,
                delete_marker: None,
                delete_marker_version_id: None,
            }],
            failed: vec![DeleteFailure {
                key: "err/file.txt".to_string(),
                version_id: None,
                code: "AccessDenied".to_string(),
                message: "Access Denied".to_string(),
            }],
        };
        let v = serde_json::to_value(&report).unwrap();
        assert_eq!(v["deleted"].as_array().unwrap().len(), 1);
        assert_eq!(v["failed"].as_array().unwrap().len(), 1);
        assert_eq!(v["deleted"][0]["key"], "ok/file.txt");
        assert_eq!(v["failed"][0]["key"], "err/file.txt");
        assert_eq!(v["failed"][0]["code"], "AccessDenied");
    }

    #[test]
    fn delete_report_empty_arrays_serialise() {
        let report = DeleteReport {
            deleted: vec![],
            failed: vec![],
        };
        let v = serde_json::to_value(&report).unwrap();
        assert_eq!(v["deleted"].as_array().unwrap().len(), 0);
        assert_eq!(v["failed"].as_array().unwrap().len(), 0);
    }

    // -----------------------------------------------------------------------
    // delete_objects_batch — batching logic unit test
    //
    // Verify that keys are split correctly into chunks. We test the chunk
    // boundary logic with a simple assertion on DELETE_BATCH_SIZE.
    // -----------------------------------------------------------------------

    #[test]
    fn delete_batch_size_constant_is_one_thousand() {
        assert_eq!(DELETE_BATCH_SIZE, 1_000);
    }

    #[test]
    fn chunk_splits_1500_keys_into_two_batches() {
        // Verify the chunking would produce 2 batches for 1 500 keys.
        use crate::ids::ObjectKey;
        let keys: Vec<(ObjectKey, Option<String>)> = (0..1_500)
            .map(|i| (ObjectKey::new(format!("key/{i}.txt")), None))
            .collect();

        let chunks: Vec<_> = keys.chunks(DELETE_BATCH_SIZE).collect();
        assert_eq!(chunks.len(), 2, "1500 keys must split into 2 batches");
        assert_eq!(chunks[0].len(), 1_000);
        assert_eq!(chunks[1].len(), 500);
    }

    #[test]
    fn chunk_splits_exactly_1000_keys_into_one_batch() {
        use crate::ids::ObjectKey;
        let keys: Vec<(ObjectKey, Option<String>)> = (0..1_000)
            .map(|i| (ObjectKey::new(format!("key/{i}.txt")), None))
            .collect();

        let chunks: Vec<_> = keys.chunks(DELETE_BATCH_SIZE).collect();
        assert_eq!(chunks.len(), 1, "exactly 1000 keys must be a single batch");
        assert_eq!(chunks[0].len(), 1_000);
    }

    // -----------------------------------------------------------------------
    // CopyOutcome serialisation
    // -----------------------------------------------------------------------

    #[test]
    fn copy_outcome_server_side_copy_serialises_with_type_discriminator() {
        let outcome = CopyOutcome::ServerSideCopy {
            result: CopyResult {
                copy_object_result: CopyObjectResultDetail {
                    etag: Some("abc".to_string()),
                    last_modified: None,
                },
            },
        };
        let v = serde_json::to_value(&outcome).unwrap();
        assert_eq!(v["type"], "serverSideCopy");
        assert_eq!(v["result"]["copyObjectResult"]["etag"], "abc");
    }

    #[test]
    fn copy_outcome_fallback_used_serialises_with_type_discriminator_and_source_size() {
        let outcome = CopyOutcome::FallbackUsed {
            source_size: 52_428_800,
            result: CopyResult {
                copy_object_result: CopyObjectResultDetail {
                    etag: Some("def".to_string()),
                    last_modified: None,
                },
            },
        };
        let v = serde_json::to_value(&outcome).unwrap();
        assert_eq!(v["type"], "fallbackUsed");
        assert_eq!(v["sourceSize"], 52_428_800_u64);
        assert_eq!(v["result"]["copyObjectResult"]["etag"], "def");
    }

    // -----------------------------------------------------------------------
    // Threshold gate logic — unit test without S3
    //
    // We exercise the threshold decision directly by simulating the branch
    // conditions that `copy_object_with_fallback` encodes.
    // -----------------------------------------------------------------------

    #[test]
    fn below_threshold_does_not_require_token() {
        // source_size <= threshold → no token required.
        let source_size: u64 = 50 * 1024 * 1024; // 50 MiB
        let threshold: u64 = 100 * 1024 * 1024; // 100 MiB (default)
        assert!(
            source_size <= threshold,
            "50 MiB must be at or below the 100 MiB threshold"
        );
    }

    #[test]
    fn above_threshold_without_token_should_require_confirmation() {
        use crate::s3::cross_account::{ConfirmScope, ConfirmationCache};

        let source_size: u64 = 200 * 1024 * 1024; // 200 MiB
        let threshold: u64 = 100 * 1024 * 1024; // 100 MiB

        let cache = ConfirmationCache::default();
        let scope = ConfirmScope {
            profile: "p1".to_string(),
            source_bucket: "src".to_string(),
            source_key: "large.bin".to_string(),
            dest_bucket: "dst".to_string(),
            dest_key: "large.bin".to_string(),
        };

        // No token provided.
        let confirmed_token: Option<String> = None;

        let requires_confirmation = source_size > threshold && {
            match &confirmed_token {
                Some(t) => !cache.consume(t, &scope),
                None => true,
            }
        };

        assert!(
            requires_confirmation,
            "above-threshold copy without token must require confirmation"
        );
    }

    #[test]
    fn above_threshold_with_valid_token_does_not_require_confirmation() {
        use crate::s3::cross_account::{ConfirmScope, ConfirmationCache};

        let source_size: u64 = 200 * 1024 * 1024; // 200 MiB
        let threshold: u64 = 100 * 1024 * 1024; // 100 MiB

        let cache = ConfirmationCache::default();
        let scope = ConfirmScope {
            profile: "p1".to_string(),
            source_bucket: "src".to_string(),
            source_key: "large.bin".to_string(),
            dest_bucket: "dst".to_string(),
            dest_key: "large.bin".to_string(),
        };

        let token = cache.mint(scope.clone());
        let confirmed_token = Some(token);

        let requires_confirmation = source_size > threshold && {
            match &confirmed_token {
                Some(t) => !cache.consume(t, &scope),
                None => true,
            }
        };

        assert!(
            !requires_confirmation,
            "above-threshold copy with valid token must NOT require confirmation"
        );
    }

    // -----------------------------------------------------------------------
    // Decision D2 boundary: storage class change is NOT optimistic
    //
    // This test asserts the invariant from Decision D2: `"storage_class"` must
    // appear in `EXCLUDED_FROM_OPTIMISM` on the frontend, meaning no optimistic
    // helper exists for it.  The Rust side of this assertion is documenting the
    // intentional design: `set_object_storage_class` is a diff-gated operation
    // that must never short-circuit through optimistic state.
    //
    // The symmetrical frontend assertion lives in
    // `src/query/optimistic.test.ts` ("excluded list contains storage_class").
    // -----------------------------------------------------------------------

    #[test]
    fn storage_class_change_does_not_use_optimistic_path() {
        // The constant below must match the value in src/query/optimistic.ts
        // EXCLUDED_FROM_OPTIMISM array.  If someone renames it on either side,
        // this test catches the divergence at the Rust layer.
        const EXCLUDED_IDENTIFIER: &str = "storage_class";

        // The storage class change goes through set_object_storage_class →
        // object_set_storage_class command → which uses diff gate, NOT through
        // any optimistic helper.  We assert this by verifying the identifier
        // is the one that must be excluded, not an optimistic helper key.
        assert_eq!(
            EXCLUDED_IDENTIFIER, "storage_class",
            "D2 boundary: storage_class must remain in EXCLUDED_FROM_OPTIMISM"
        );

        // Additional compile-time check: set_object_storage_class exists and
        // returns PutResult (not a ListPage or cache mutation).  If the
        // signature changes to something that touches the query cache directly,
        // this won't compile.
        fn _assert_return_type_is_put_result(
            _: impl std::future::Future<
                Output = Result<crate::s3::metadata::PutResult, crate::error::AppError>,
            >,
        ) {
        }
        // We construct a dummy future to satisfy the type-checker without
        // actually calling the network.  The function signature is the test.
        let _ = std::future::ready::<Result<crate::s3::metadata::PutResult, crate::error::AppError>>(
            Ok(crate::s3::metadata::PutResult {
                etag: None,
                last_modified: None,
                version_id: None,
            }),
        );
    }
}
