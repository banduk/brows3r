//! Bucket inspector: aggregates read-only bucket properties in parallel.
//!
//! # Design
//!
//! Each bucket property is fetched as an independent S3 API call via
//! `tokio::join!`. Every call is classified into one of four outcomes:
//!
//! - `SectionResult::Value(T)` — the call succeeded and returned a value.
//! - `SectionResult::Denied { iam_action }` — `AccessDenied`; also recorded
//!   into `CapabilityCache` so the UI can render "Requires `s3:GetBucketX`".
//! - `SectionResult::Unsupported { reason }` — the provider does not
//!   implement this API (e.g. LocalStack free-tier, MinIO, R2).
//! - `SectionResult::Deferred { reason }` — intentionally omitted from v1
//!   (currently only `bucket_policy`).
//!
//! Any error that does not map to Denied or Unsupported is treated as a
//! critical failure and bubbles up as `Err(AppError)` for the whole call.
//! In practice, only `NoSuchBucket` (bucket deleted mid-inspect) is a hard
//! failure; all capability errors degrade gracefully at the section level.
//!
//! # OCP
//!
//! - Adding a new section: one new field on `BucketInspectorReport` + one
//!   parallel arm inside `inspect_bucket`. No existing sections change.
//! - Adding a new `SectionResult` discriminator: one variant + one arm in
//!   consumer `match` blocks. Existing variants are untouched.
//! - Capability cache writes happen automatically from `Denied` outcomes;
//!   the frontend never needs to call `capability_get` explicitly.

use std::collections::HashMap;

use aws_sdk_s3::{error::SdkError, Client};
use serde::{Deserialize, Serialize};

use crate::{
    cache::capability::{CapabilityCache, CapabilityClass},
    error::AppError,
    ids::{BucketId, ProfileId},
};

// ---------------------------------------------------------------------------
// SectionResult — discriminated outcome for each inspector section
// ---------------------------------------------------------------------------

/// The result of fetching one bucket property section.
///
/// Serializes with `tag = "kind"` and `rename_all = "camelCase"` so the
/// frontend discriminates by `section.kind`.
///
/// OCP: adding e.g. `Pending` is one new variant here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SectionResult<T> {
    /// The API succeeded and returned a value.
    Value { value: T },
    /// `AccessDenied` — IAM policy blocked this section.
    ///
    /// `iam_action` is the IAM action string from the error when available
    /// (e.g. `"s3:GetBucketVersioning"`).
    Denied {
        #[serde(rename = "iamAction")]
        iam_action: String,
    },
    /// The provider does not implement this API.
    Unsupported { reason: String },
    /// Intentionally omitted from v1 (per design non-goals).
    Deferred { reason: String },
}

// ---------------------------------------------------------------------------
// Section value types — all camelCase for IPC
// ---------------------------------------------------------------------------

/// Bucket versioning state.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum VersioningStatus {
    Enabled,
    Suspended,
    Disabled,
}

/// Summary of server-side encryption configuration (read-only in v1).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EncryptionConfig {
    /// Primary SSE algorithm, e.g. `"aws:kms"` or `"AES256"`.
    pub sse_algorithm: Option<String>,
    /// KMS key ID when `sse_algorithm` is `"aws:kms"`.
    pub kms_master_key_id: Option<String>,
}

/// A single lifecycle rule summary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleRule {
    pub id: Option<String>,
    pub status: String,
    /// Filter prefix for this rule, if any.
    pub prefix: Option<String>,
}

/// Object-lock configuration summary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ObjectLockConfig {
    pub object_lock_enabled: bool,
    /// Default lock mode, e.g. `"COMPLIANCE"` or `"GOVERNANCE"`.
    pub default_retention_mode: Option<String>,
    /// Default retention in days.
    pub default_retention_days: Option<i32>,
    /// Default retention in years.
    pub default_retention_years: Option<i32>,
}

/// Public access block configuration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PublicAccessBlockConfig {
    pub block_public_acls: bool,
    pub ignore_public_acls: bool,
    pub block_public_policy: bool,
    pub restrict_public_buckets: bool,
}

/// A single CORS rule summary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CorsRule {
    pub allowed_origins: Vec<String>,
    pub allowed_methods: Vec<String>,
    pub allowed_headers: Vec<String>,
    pub expose_headers: Vec<String>,
    pub max_age_seconds: Option<i32>,
}

/// Replication configuration summary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReplicationConfig {
    pub role: String,
    /// Destination bucket ARNs (one per rule).
    pub destination_buckets: Vec<String>,
}

/// Bucket logging configuration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoggingConfig {
    /// Target bucket for access logs.
    pub target_bucket: Option<String>,
    /// Key prefix for log objects.
    pub target_prefix: Option<String>,
}

/// Static website hosting configuration summary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WebsiteConfig {
    pub index_document: Option<String>,
    pub error_document: Option<String>,
    pub redirect_all_requests_to: Option<String>,
}

/// S3 event notification configuration summary.
///
/// Not the app's own notification system — these are S3-side event
/// notifications such as Lambda triggers, SQS queues, and SNS topics.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationConfig {
    pub lambda_count: usize,
    pub queue_count: usize,
    pub topic_count: usize,
}

/// Bucket ownership controls.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OwnershipControls {
    /// Ownership rule, e.g. `"BucketOwnerEnforced"` or `"ObjectWriter"`.
    pub rule: String,
}

// ---------------------------------------------------------------------------
// BucketInspectorReport — the aggregated report returned over IPC
// ---------------------------------------------------------------------------

/// Aggregated read-only properties of a bucket.
///
/// Every section uses `SectionResult<T>` so the frontend can render
/// `Value`, disabled `Denied`, `Unsupported`, or `Deferred` states
/// without treating capability gaps as errors.
///
/// OCP: adding a new section is one new field here + one parallel call in
/// `inspect_bucket`. No existing sections change.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BucketInspectorReport {
    pub region: SectionResult<String>,
    pub versioning: SectionResult<VersioningStatus>,
    /// Server-side encryption rules summary. Read-only in v1.
    pub encryption: SectionResult<EncryptionConfig>,
    pub lifecycle: SectionResult<Vec<LifecycleRule>>,
    pub object_lock: SectionResult<ObjectLockConfig>,
    pub public_access_block: SectionResult<PublicAccessBlockConfig>,
    pub cors: SectionResult<Vec<CorsRule>>,
    pub tags: SectionResult<HashMap<String, String>>,
    pub replication: SectionResult<ReplicationConfig>,
    pub logging: SectionResult<LoggingConfig>,
    pub website: SectionResult<WebsiteConfig>,
    /// S3 event notification configuration (Lambda, SQS, SNS triggers).
    pub notifications: SectionResult<NotificationConfig>,
    pub ownership_controls: SectionResult<OwnershipControls>,
    pub requester_pays: SectionResult<bool>,
    /// Intentionally absent in v1 — bucket policy viewer is a non-goal.
    pub bucket_policy: SectionResult<()>,
}

// ---------------------------------------------------------------------------
// inspect_bucket — main entry point
// ---------------------------------------------------------------------------

/// Fetch all supported bucket properties in parallel and return an aggregated
/// `BucketInspectorReport`.
///
/// - Successful sections → `SectionResult::Value`.
/// - `AccessDenied` → `SectionResult::Denied`; also recorded into the
///   `CapabilityCache` for the (profile, bucket, op) triple.
/// - `NotImplemented` / `UnsupportedOperation` / provider-specific
///   "not supported" codes → `SectionResult::Unsupported`.
/// - `bucket_policy` is hardcoded `Deferred` without calling the API.
///
/// Only `AppError::NotFound` (bucket deleted mid-inspect) propagates as a
/// hard failure; everything else degrades per-section.
pub async fn inspect_bucket(
    client: &Client,
    bucket: &str,
    capability_cache: &CapabilityCache,
    profile_id: &ProfileId,
) -> Result<BucketInspectorReport, AppError> {
    let bucket_id = BucketId::new(bucket);

    let (
        region_result,
        versioning_result,
        encryption_result,
        lifecycle_result,
        object_lock_result,
        pab_result,
        cors_result,
        tags_result,
        replication_result,
        logging_result,
        website_result,
        notification_result,
        ownership_result,
        requester_pays_result,
    ) = tokio::join!(
        fetch_region(client, bucket),
        fetch_versioning(client, bucket),
        fetch_encryption(client, bucket),
        fetch_lifecycle(client, bucket),
        fetch_object_lock(client, bucket),
        fetch_public_access_block(client, bucket),
        fetch_cors(client, bucket),
        fetch_tags(client, bucket),
        fetch_replication(client, bucket),
        fetch_logging(client, bucket),
        fetch_website(client, bucket),
        fetch_notifications(client, bucket),
        fetch_ownership_controls(client, bucket),
        fetch_requester_pays(client, bucket),
    );

    // Record AccessDenied outcomes into the capability cache.
    record_denied(
        capability_cache,
        profile_id,
        &bucket_id,
        "s3:GetBucketLocation",
        &region_result,
    );
    record_denied(
        capability_cache,
        profile_id,
        &bucket_id,
        "s3:GetBucketVersioning",
        &versioning_result,
    );
    record_denied(
        capability_cache,
        profile_id,
        &bucket_id,
        "s3:GetEncryptionConfiguration",
        &encryption_result,
    );
    record_denied(
        capability_cache,
        profile_id,
        &bucket_id,
        "s3:GetLifecycleConfiguration",
        &lifecycle_result,
    );
    record_denied(
        capability_cache,
        profile_id,
        &bucket_id,
        "s3:GetBucketObjectLockConfiguration",
        &object_lock_result,
    );
    record_denied(
        capability_cache,
        profile_id,
        &bucket_id,
        "s3:GetBucketPublicAccessBlock",
        &pab_result,
    );
    record_denied(
        capability_cache,
        profile_id,
        &bucket_id,
        "s3:GetBucketCORS",
        &cors_result,
    );
    record_denied(
        capability_cache,
        profile_id,
        &bucket_id,
        "s3:GetBucketTagging",
        &tags_result,
    );
    record_denied(
        capability_cache,
        profile_id,
        &bucket_id,
        "s3:GetReplicationConfiguration",
        &replication_result,
    );
    record_denied(
        capability_cache,
        profile_id,
        &bucket_id,
        "s3:GetBucketLogging",
        &logging_result,
    );
    record_denied(
        capability_cache,
        profile_id,
        &bucket_id,
        "s3:GetBucketWebsite",
        &website_result,
    );
    record_denied(
        capability_cache,
        profile_id,
        &bucket_id,
        "s3:GetBucketNotification",
        &notification_result,
    );
    record_denied(
        capability_cache,
        profile_id,
        &bucket_id,
        "s3:GetBucketOwnershipControls",
        &ownership_result,
    );
    record_denied(
        capability_cache,
        profile_id,
        &bucket_id,
        "s3:GetBucketRequestPayment",
        &requester_pays_result,
    );

    // Propagate hard failures (NoSuchBucket) from any section.
    let region = region_result?;
    let versioning = versioning_result?;
    let encryption = encryption_result?;
    let lifecycle = lifecycle_result?;
    let object_lock = object_lock_result?;
    let public_access_block = pab_result?;
    let cors = cors_result?;
    let tags = tags_result?;
    let replication = replication_result?;
    let logging = logging_result?;
    let website = website_result?;
    let notifications = notification_result?;
    let ownership_controls = ownership_result?;
    let requester_pays = requester_pays_result?;

    Ok(BucketInspectorReport {
        region,
        versioning,
        encryption,
        lifecycle,
        object_lock,
        public_access_block,
        cors,
        tags,
        replication,
        logging,
        website,
        notifications,
        ownership_controls,
        requester_pays,
        // Bucket policy is a v1 non-goal — never call the API.
        bucket_policy: SectionResult::Deferred {
            reason: "Deferred from v1".to_string(),
        },
    })
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/// Record a `Denied` capability into the cache when the section is `Denied`.
fn record_denied<T>(
    cache: &CapabilityCache,
    profile_id: &ProfileId,
    bucket_id: &BucketId,
    iam_action: &str,
    result: &Result<SectionResult<T>, AppError>,
) {
    if let Ok(SectionResult::Denied { .. }) = result {
        cache.record_capability(
            profile_id,
            Some(bucket_id),
            iam_action,
            CapabilityClass::Denied {
                iam_action: Some(iam_action.to_owned()),
            },
        );
    }
}

/// Classify a generic service-error code into `SectionResult`.
///
/// Returns `None` when the error is a hard failure that must propagate.
fn classify_service_error(code: &str, bucket: &str) -> Option<AppError> {
    match code {
        "NoSuchBucket" => Some(AppError::NotFound {
            resource: bucket.to_string(),
        }),
        _ => None,
    }
}

/// Return `true` for codes that indicate the API is not supported by this
/// provider (LocalStack free-tier, MinIO, R2, …).
fn is_unsupported_code(code: &str) -> bool {
    matches!(
        code,
        "NotImplemented"
            | "UnsupportedOperation"
            | "MethodNotAllowed"
            | "InvalidRequest"
            | "XNotImplemented"
            | "NoSuchWebsiteConfiguration"
            | "NoSuchCORSConfiguration"
            | "NoSuchLifecycleConfiguration"
            | "NoSuchReplicationConfiguration"
            | "ObjectLockConfigurationNotFoundError"
            | "OwnershipControlsNotFoundError"
            | "NoSuchPublicAccessBlockConfiguration"
    )
}

// ---------------------------------------------------------------------------
// Individual section fetchers
// ---------------------------------------------------------------------------

/// Fetch the bucket region via `GetBucketLocation`.
async fn fetch_region(client: &Client, bucket: &str) -> Result<SectionResult<String>, AppError> {
    match client.get_bucket_location().bucket(bucket).send().await {
        Ok(resp) => {
            let region = resp
                .location_constraint()
                .map(|lc| match lc.as_str() {
                    "" => "us-east-1".to_string(),
                    "EU" => "eu-west-1".to_string(),
                    s => s.to_string(),
                })
                .unwrap_or_else(|| "us-east-1".to_string());
            Ok(SectionResult::Value { value: region })
        }
        Err(SdkError::ServiceError(ref svc)) => {
            let code = svc.err().meta().code().unwrap_or("");
            if code == "AccessDenied" || code == "InvalidClientTokenId" {
                return Ok(SectionResult::Denied {
                    iam_action: "s3:GetBucketLocation".to_string(),
                });
            }
            if is_unsupported_code(code) {
                return Ok(SectionResult::Unsupported {
                    reason: code.to_string(),
                });
            }
            if let Some(hard) = classify_service_error(code, bucket) {
                return Err(hard);
            }
            Ok(SectionResult::Unsupported {
                reason: format!("GetBucketLocation: {code}"),
            })
        }
        Err(e) => Err(AppError::Network {
            source: format!("GetBucketLocation({bucket}): {e}"),
        }),
    }
}

/// Fetch versioning state via `GetBucketVersioning`.
async fn fetch_versioning(
    client: &Client,
    bucket: &str,
) -> Result<SectionResult<VersioningStatus>, AppError> {
    match client.get_bucket_versioning().bucket(bucket).send().await {
        Ok(resp) => {
            let status = match resp.status() {
                Some(s) if s.as_str() == "Enabled" => VersioningStatus::Enabled,
                Some(s) if s.as_str() == "Suspended" => VersioningStatus::Suspended,
                _ => VersioningStatus::Disabled,
            };
            Ok(SectionResult::Value { value: status })
        }
        Err(SdkError::ServiceError(ref svc)) => {
            let code = svc.err().meta().code().unwrap_or("");
            if code == "AccessDenied" || code == "InvalidClientTokenId" {
                return Ok(SectionResult::Denied {
                    iam_action: "s3:GetBucketVersioning".to_string(),
                });
            }
            if is_unsupported_code(code) {
                return Ok(SectionResult::Unsupported {
                    reason: code.to_string(),
                });
            }
            if let Some(hard) = classify_service_error(code, bucket) {
                return Err(hard);
            }
            Ok(SectionResult::Unsupported {
                reason: format!("GetBucketVersioning: {code}"),
            })
        }
        Err(e) => Err(AppError::Network {
            source: format!("GetBucketVersioning({bucket}): {e}"),
        }),
    }
}

/// Fetch SSE configuration via `GetBucketEncryption`.
async fn fetch_encryption(
    client: &Client,
    bucket: &str,
) -> Result<SectionResult<EncryptionConfig>, AppError> {
    match client.get_bucket_encryption().bucket(bucket).send().await {
        Ok(resp) => {
            let (sse_algorithm, kms_master_key_id) = resp
                .server_side_encryption_configuration()
                .and_then(|c| c.rules().first())
                .and_then(|rule| rule.apply_server_side_encryption_by_default())
                .map(|def| {
                    (
                        Some(def.sse_algorithm().as_str().to_string()),
                        def.kms_master_key_id().map(|k| k.to_string()),
                    )
                })
                .unwrap_or((None, None));
            Ok(SectionResult::Value {
                value: EncryptionConfig {
                    sse_algorithm,
                    kms_master_key_id,
                },
            })
        }
        Err(SdkError::ServiceError(ref svc)) => {
            let code = svc.err().meta().code().unwrap_or("");
            if code == "AccessDenied" || code == "InvalidClientTokenId" {
                return Ok(SectionResult::Denied {
                    iam_action: "s3:GetEncryptionConfiguration".to_string(),
                });
            }
            // "ServerSideEncryptionConfigurationNotFoundError" means no SSE
            // configured — that is a valid value (no encryption).
            if code == "ServerSideEncryptionConfigurationNotFoundError" {
                return Ok(SectionResult::Value {
                    value: EncryptionConfig {
                        sse_algorithm: None,
                        kms_master_key_id: None,
                    },
                });
            }
            if is_unsupported_code(code) {
                return Ok(SectionResult::Unsupported {
                    reason: code.to_string(),
                });
            }
            if let Some(hard) = classify_service_error(code, bucket) {
                return Err(hard);
            }
            Ok(SectionResult::Unsupported {
                reason: format!("GetBucketEncryption: {code}"),
            })
        }
        Err(e) => Err(AppError::Network {
            source: format!("GetBucketEncryption({bucket}): {e}"),
        }),
    }
}

/// Fetch lifecycle rules via `GetBucketLifecycleConfiguration`.
async fn fetch_lifecycle(
    client: &Client,
    bucket: &str,
) -> Result<SectionResult<Vec<LifecycleRule>>, AppError> {
    match client
        .get_bucket_lifecycle_configuration()
        .bucket(bucket)
        .send()
        .await
    {
        Ok(resp) => {
            let rules: Vec<LifecycleRule> = resp
                .rules()
                .iter()
                .map(|r| LifecycleRule {
                    id: r.id().map(|s| s.to_string()),
                    status: r.status().as_str().to_string(),
                    prefix: r.filter().and_then(|f| f.prefix()).map(|s| s.to_string()),
                })
                .collect();
            Ok(SectionResult::Value { value: rules })
        }
        Err(SdkError::ServiceError(ref svc)) => {
            let code = svc.err().meta().code().unwrap_or("");
            if code == "AccessDenied" || code == "InvalidClientTokenId" {
                return Ok(SectionResult::Denied {
                    iam_action: "s3:GetLifecycleConfiguration".to_string(),
                });
            }
            if code == "NoSuchLifecycleConfiguration" {
                return Ok(SectionResult::Value { value: vec![] });
            }
            if is_unsupported_code(code) {
                return Ok(SectionResult::Unsupported {
                    reason: code.to_string(),
                });
            }
            if let Some(hard) = classify_service_error(code, bucket) {
                return Err(hard);
            }
            Ok(SectionResult::Unsupported {
                reason: format!("GetBucketLifecycleConfiguration: {code}"),
            })
        }
        Err(e) => Err(AppError::Network {
            source: format!("GetBucketLifecycleConfiguration({bucket}): {e}"),
        }),
    }
}

/// Fetch object-lock configuration via `GetObjectLockConfiguration`.
async fn fetch_object_lock(
    client: &Client,
    bucket: &str,
) -> Result<SectionResult<ObjectLockConfig>, AppError> {
    match client
        .get_object_lock_configuration()
        .bucket(bucket)
        .send()
        .await
    {
        Ok(resp) => {
            let (mode, days, years) = resp
                .object_lock_configuration()
                .and_then(|c| c.rule())
                .and_then(|r| r.default_retention())
                .map(|ret| {
                    (
                        ret.mode().map(|m| m.as_str().to_string()),
                        ret.days(),
                        ret.years(),
                    )
                })
                .unwrap_or((None, None, None));
            let enabled = resp
                .object_lock_configuration()
                .and_then(|c| c.object_lock_enabled())
                .map(|e| e.as_str() == "Enabled")
                .unwrap_or(false);
            Ok(SectionResult::Value {
                value: ObjectLockConfig {
                    object_lock_enabled: enabled,
                    default_retention_mode: mode,
                    default_retention_days: days,
                    default_retention_years: years,
                },
            })
        }
        Err(SdkError::ServiceError(ref svc)) => {
            let code = svc.err().meta().code().unwrap_or("");
            if code == "AccessDenied" || code == "InvalidClientTokenId" {
                return Ok(SectionResult::Denied {
                    iam_action: "s3:GetBucketObjectLockConfiguration".to_string(),
                });
            }
            if code == "ObjectLockConfigurationNotFoundError" {
                return Ok(SectionResult::Value {
                    value: ObjectLockConfig {
                        object_lock_enabled: false,
                        default_retention_mode: None,
                        default_retention_days: None,
                        default_retention_years: None,
                    },
                });
            }
            if is_unsupported_code(code) {
                return Ok(SectionResult::Unsupported {
                    reason: code.to_string(),
                });
            }
            if let Some(hard) = classify_service_error(code, bucket) {
                return Err(hard);
            }
            Ok(SectionResult::Unsupported {
                reason: format!("GetObjectLockConfiguration: {code}"),
            })
        }
        Err(e) => Err(AppError::Network {
            source: format!("GetObjectLockConfiguration({bucket}): {e}"),
        }),
    }
}

/// Fetch public access block configuration via `GetPublicAccessBlock`.
async fn fetch_public_access_block(
    client: &Client,
    bucket: &str,
) -> Result<SectionResult<PublicAccessBlockConfig>, AppError> {
    match client.get_public_access_block().bucket(bucket).send().await {
        Ok(resp) => {
            let cfg = resp.public_access_block_configuration();
            Ok(SectionResult::Value {
                value: PublicAccessBlockConfig {
                    block_public_acls: cfg.and_then(|c| c.block_public_acls()).unwrap_or(false),
                    ignore_public_acls: cfg.and_then(|c| c.ignore_public_acls()).unwrap_or(false),
                    block_public_policy: cfg.and_then(|c| c.block_public_policy()).unwrap_or(false),
                    restrict_public_buckets: cfg
                        .and_then(|c| c.restrict_public_buckets())
                        .unwrap_or(false),
                },
            })
        }
        Err(SdkError::ServiceError(ref svc)) => {
            let code = svc.err().meta().code().unwrap_or("");
            if code == "AccessDenied" || code == "InvalidClientTokenId" {
                return Ok(SectionResult::Denied {
                    iam_action: "s3:GetBucketPublicAccessBlock".to_string(),
                });
            }
            if code == "NoSuchPublicAccessBlockConfiguration" {
                return Ok(SectionResult::Value {
                    value: PublicAccessBlockConfig {
                        block_public_acls: false,
                        ignore_public_acls: false,
                        block_public_policy: false,
                        restrict_public_buckets: false,
                    },
                });
            }
            if is_unsupported_code(code) {
                return Ok(SectionResult::Unsupported {
                    reason: code.to_string(),
                });
            }
            if let Some(hard) = classify_service_error(code, bucket) {
                return Err(hard);
            }
            Ok(SectionResult::Unsupported {
                reason: format!("GetPublicAccessBlock: {code}"),
            })
        }
        Err(e) => Err(AppError::Network {
            source: format!("GetPublicAccessBlock({bucket}): {e}"),
        }),
    }
}

/// Fetch CORS rules via `GetBucketCors`.
async fn fetch_cors(
    client: &Client,
    bucket: &str,
) -> Result<SectionResult<Vec<CorsRule>>, AppError> {
    match client.get_bucket_cors().bucket(bucket).send().await {
        Ok(resp) => {
            let rules: Vec<CorsRule> = resp
                .cors_rules()
                .iter()
                .map(|r| CorsRule {
                    allowed_origins: r.allowed_origins().iter().map(|s| s.to_string()).collect(),
                    allowed_methods: r.allowed_methods().iter().map(|s| s.to_string()).collect(),
                    allowed_headers: r.allowed_headers().iter().map(|s| s.to_string()).collect(),
                    expose_headers: r.expose_headers().iter().map(|s| s.to_string()).collect(),
                    max_age_seconds: r.max_age_seconds(),
                })
                .collect();
            Ok(SectionResult::Value { value: rules })
        }
        Err(SdkError::ServiceError(ref svc)) => {
            let code = svc.err().meta().code().unwrap_or("");
            if code == "AccessDenied" || code == "InvalidClientTokenId" {
                return Ok(SectionResult::Denied {
                    iam_action: "s3:GetBucketCORS".to_string(),
                });
            }
            if code == "NoSuchCORSConfiguration" {
                return Ok(SectionResult::Value { value: vec![] });
            }
            if is_unsupported_code(code) {
                return Ok(SectionResult::Unsupported {
                    reason: code.to_string(),
                });
            }
            if let Some(hard) = classify_service_error(code, bucket) {
                return Err(hard);
            }
            Ok(SectionResult::Unsupported {
                reason: format!("GetBucketCors: {code}"),
            })
        }
        Err(e) => Err(AppError::Network {
            source: format!("GetBucketCors({bucket}): {e}"),
        }),
    }
}

/// Fetch bucket tags via `GetBucketTagging`.
async fn fetch_tags(
    client: &Client,
    bucket: &str,
) -> Result<SectionResult<HashMap<String, String>>, AppError> {
    match client.get_bucket_tagging().bucket(bucket).send().await {
        Ok(resp) => {
            let map: HashMap<String, String> = resp
                .tag_set()
                .iter()
                .map(|t| (t.key().to_string(), t.value().to_string()))
                .collect();
            Ok(SectionResult::Value { value: map })
        }
        Err(SdkError::ServiceError(ref svc)) => {
            let code = svc.err().meta().code().unwrap_or("");
            if code == "AccessDenied" || code == "InvalidClientTokenId" {
                return Ok(SectionResult::Denied {
                    iam_action: "s3:GetBucketTagging".to_string(),
                });
            }
            // NoSuchTagSet means the bucket has no tags — valid empty state.
            if code == "NoSuchTagSet" {
                return Ok(SectionResult::Value {
                    value: HashMap::new(),
                });
            }
            if is_unsupported_code(code) {
                return Ok(SectionResult::Unsupported {
                    reason: code.to_string(),
                });
            }
            if let Some(hard) = classify_service_error(code, bucket) {
                return Err(hard);
            }
            Ok(SectionResult::Unsupported {
                reason: format!("GetBucketTagging: {code}"),
            })
        }
        Err(e) => Err(AppError::Network {
            source: format!("GetBucketTagging({bucket}): {e}"),
        }),
    }
}

/// Fetch replication configuration via `GetBucketReplication`.
async fn fetch_replication(
    client: &Client,
    bucket: &str,
) -> Result<SectionResult<ReplicationConfig>, AppError> {
    match client.get_bucket_replication().bucket(bucket).send().await {
        Ok(resp) => {
            let cfg = resp.replication_configuration();
            let role = cfg.map(|c| c.role().to_string()).unwrap_or_default();
            let destination_buckets: Vec<String> = cfg
                .map(|c| {
                    c.rules()
                        .iter()
                        .map(|r| {
                            r.destination()
                                .map(|d| d.bucket().to_string())
                                .unwrap_or_default()
                        })
                        .collect()
                })
                .unwrap_or_default();
            Ok(SectionResult::Value {
                value: ReplicationConfig {
                    role,
                    destination_buckets,
                },
            })
        }
        Err(SdkError::ServiceError(ref svc)) => {
            let code = svc.err().meta().code().unwrap_or("");
            if code == "AccessDenied" || code == "InvalidClientTokenId" {
                return Ok(SectionResult::Denied {
                    iam_action: "s3:GetReplicationConfiguration".to_string(),
                });
            }
            if code == "ReplicationConfigurationNotFoundError"
                || code == "NoSuchReplicationConfiguration"
            {
                return Ok(SectionResult::Value {
                    value: ReplicationConfig {
                        role: String::new(),
                        destination_buckets: vec![],
                    },
                });
            }
            if is_unsupported_code(code) {
                return Ok(SectionResult::Unsupported {
                    reason: code.to_string(),
                });
            }
            if let Some(hard) = classify_service_error(code, bucket) {
                return Err(hard);
            }
            Ok(SectionResult::Unsupported {
                reason: format!("GetBucketReplication: {code}"),
            })
        }
        Err(e) => Err(AppError::Network {
            source: format!("GetBucketReplication({bucket}): {e}"),
        }),
    }
}

/// Fetch logging configuration via `GetBucketLogging`.
async fn fetch_logging(
    client: &Client,
    bucket: &str,
) -> Result<SectionResult<LoggingConfig>, AppError> {
    match client.get_bucket_logging().bucket(bucket).send().await {
        Ok(resp) => {
            let (target_bucket, target_prefix) = resp
                .logging_enabled()
                .map(|le| {
                    (
                        Some(le.target_bucket().to_string()),
                        Some(le.target_prefix().to_string()),
                    )
                })
                .unwrap_or((None, None));
            Ok(SectionResult::Value {
                value: LoggingConfig {
                    target_bucket,
                    target_prefix,
                },
            })
        }
        Err(SdkError::ServiceError(ref svc)) => {
            let code = svc.err().meta().code().unwrap_or("");
            if code == "AccessDenied" || code == "InvalidClientTokenId" {
                return Ok(SectionResult::Denied {
                    iam_action: "s3:GetBucketLogging".to_string(),
                });
            }
            if is_unsupported_code(code) {
                return Ok(SectionResult::Unsupported {
                    reason: code.to_string(),
                });
            }
            if let Some(hard) = classify_service_error(code, bucket) {
                return Err(hard);
            }
            Ok(SectionResult::Unsupported {
                reason: format!("GetBucketLogging: {code}"),
            })
        }
        Err(e) => Err(AppError::Network {
            source: format!("GetBucketLogging({bucket}): {e}"),
        }),
    }
}

/// Fetch static website configuration via `GetBucketWebsite`.
async fn fetch_website(
    client: &Client,
    bucket: &str,
) -> Result<SectionResult<WebsiteConfig>, AppError> {
    match client.get_bucket_website().bucket(bucket).send().await {
        Ok(resp) => Ok(SectionResult::Value {
            value: WebsiteConfig {
                index_document: resp.index_document().map(|i| i.suffix().to_string()),
                error_document: resp.error_document().map(|e| e.key().to_string()),
                redirect_all_requests_to: resp
                    .redirect_all_requests_to()
                    .map(|r| r.host_name().to_string()),
            },
        }),
        Err(SdkError::ServiceError(ref svc)) => {
            let code = svc.err().meta().code().unwrap_or("");
            if code == "AccessDenied" || code == "InvalidClientTokenId" {
                return Ok(SectionResult::Denied {
                    iam_action: "s3:GetBucketWebsite".to_string(),
                });
            }
            if code == "NoSuchWebsiteConfiguration" {
                return Ok(SectionResult::Value {
                    value: WebsiteConfig {
                        index_document: None,
                        error_document: None,
                        redirect_all_requests_to: None,
                    },
                });
            }
            if is_unsupported_code(code) {
                return Ok(SectionResult::Unsupported {
                    reason: code.to_string(),
                });
            }
            if let Some(hard) = classify_service_error(code, bucket) {
                return Err(hard);
            }
            Ok(SectionResult::Unsupported {
                reason: format!("GetBucketWebsite: {code}"),
            })
        }
        Err(e) => Err(AppError::Network {
            source: format!("GetBucketWebsite({bucket}): {e}"),
        }),
    }
}

/// Fetch S3 event notification configuration via `GetBucketNotificationConfiguration`.
async fn fetch_notifications(
    client: &Client,
    bucket: &str,
) -> Result<SectionResult<NotificationConfig>, AppError> {
    match client
        .get_bucket_notification_configuration()
        .bucket(bucket)
        .send()
        .await
    {
        Ok(resp) => Ok(SectionResult::Value {
            value: NotificationConfig {
                lambda_count: resp.lambda_function_configurations().len(),
                queue_count: resp.queue_configurations().len(),
                topic_count: resp.topic_configurations().len(),
            },
        }),
        Err(SdkError::ServiceError(ref svc)) => {
            let code = svc.err().meta().code().unwrap_or("");
            if code == "AccessDenied" || code == "InvalidClientTokenId" {
                return Ok(SectionResult::Denied {
                    iam_action: "s3:GetBucketNotification".to_string(),
                });
            }
            if is_unsupported_code(code) {
                return Ok(SectionResult::Unsupported {
                    reason: code.to_string(),
                });
            }
            if let Some(hard) = classify_service_error(code, bucket) {
                return Err(hard);
            }
            Ok(SectionResult::Unsupported {
                reason: format!("GetBucketNotificationConfiguration: {code}"),
            })
        }
        Err(e) => Err(AppError::Network {
            source: format!("GetBucketNotificationConfiguration({bucket}): {e}"),
        }),
    }
}

/// Fetch ownership controls via `GetBucketOwnershipControls`.
async fn fetch_ownership_controls(
    client: &Client,
    bucket: &str,
) -> Result<SectionResult<OwnershipControls>, AppError> {
    match client
        .get_bucket_ownership_controls()
        .bucket(bucket)
        .send()
        .await
    {
        Ok(resp) => {
            let rule = resp
                .ownership_controls()
                .and_then(|oc| oc.rules().first())
                .map(|r| r.object_ownership().as_str().to_string())
                .unwrap_or_default();
            Ok(SectionResult::Value {
                value: OwnershipControls { rule },
            })
        }
        Err(SdkError::ServiceError(ref svc)) => {
            let code = svc.err().meta().code().unwrap_or("");
            if code == "AccessDenied" || code == "InvalidClientTokenId" {
                return Ok(SectionResult::Denied {
                    iam_action: "s3:GetBucketOwnershipControls".to_string(),
                });
            }
            if code == "OwnershipControlsNotFoundError" {
                return Ok(SectionResult::Value {
                    value: OwnershipControls {
                        rule: String::new(),
                    },
                });
            }
            if is_unsupported_code(code) {
                return Ok(SectionResult::Unsupported {
                    reason: code.to_string(),
                });
            }
            if let Some(hard) = classify_service_error(code, bucket) {
                return Err(hard);
            }
            Ok(SectionResult::Unsupported {
                reason: format!("GetBucketOwnershipControls: {code}"),
            })
        }
        Err(e) => Err(AppError::Network {
            source: format!("GetBucketOwnershipControls({bucket}): {e}"),
        }),
    }
}

/// Fetch requester-pays status via `GetBucketRequestPayment`.
async fn fetch_requester_pays(
    client: &Client,
    bucket: &str,
) -> Result<SectionResult<bool>, AppError> {
    match client
        .get_bucket_request_payment()
        .bucket(bucket)
        .send()
        .await
    {
        Ok(resp) => {
            let payer = resp.payer().map(|p| p.as_str()).unwrap_or("BucketOwner");
            Ok(SectionResult::Value {
                value: payer == "Requester",
            })
        }
        Err(SdkError::ServiceError(ref svc)) => {
            let code = svc.err().meta().code().unwrap_or("");
            if code == "AccessDenied" || code == "InvalidClientTokenId" {
                return Ok(SectionResult::Denied {
                    iam_action: "s3:GetBucketRequestPayment".to_string(),
                });
            }
            if is_unsupported_code(code) {
                return Ok(SectionResult::Unsupported {
                    reason: code.to_string(),
                });
            }
            if let Some(hard) = classify_service_error(code, bucket) {
                return Err(hard);
            }
            Ok(SectionResult::Unsupported {
                reason: format!("GetBucketRequestPayment: {code}"),
            })
        }
        Err(e) => Err(AppError::Network {
            source: format!("GetBucketRequestPayment({bucket}): {e}"),
        }),
    }
}

// ---------------------------------------------------------------------------
// ObjectHead — per-object property bag from HeadObject
// ---------------------------------------------------------------------------

/// All properties returned by `HeadObject` for a single S3 object.
///
/// User-defined metadata (`x-amz-meta-*`) is surfaced in `metadata`.
/// All fields are optional — not every object or provider returns every header.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ObjectHead {
    /// Object size in bytes.
    pub content_length: Option<i64>,
    /// MIME type, e.g. `"application/octet-stream"`.
    pub content_type: Option<String>,
    /// RFC 2822 last-modified timestamp as a Unix epoch (seconds).
    pub last_modified: Option<i64>,
    /// HTTP ETag string (including surrounding quotes from S3).
    pub etag: Option<String>,
    /// Version ID if the bucket has versioning enabled.
    pub version_id: Option<String>,
    /// S3 storage class, e.g. `"STANDARD"`, `"GLACIER"`.
    pub storage_class: Option<String>,
    /// Server-side encryption algorithm, e.g. `"aws:kms"` or `"AES256"`.
    pub server_side_encryption: Option<String>,
    /// KMS key ID when SSE-KMS is active.
    pub sse_kms_key_id: Option<String>,
    /// `Content-Encoding` header value, e.g. `"gzip"`.
    pub content_encoding: Option<String>,
    /// `Content-Disposition` header value.
    pub content_disposition: Option<String>,
    /// `Cache-Control` header value.
    pub cache_control: Option<String>,
    /// `Expires` header as Unix epoch (seconds), if present.
    pub expires: Option<i64>,
    /// User-defined metadata (keys stripped of the `x-amz-meta-` prefix).
    pub metadata: std::collections::HashMap<String, String>,
}

/// ACL summary: owner display name + total grant count.
///
/// Intentionally minimal — the full ACL grant list is not v1 scope.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AclSummary {
    /// Owner display name when available.
    pub owner_display_name: Option<String>,
    /// Total number of individual grants on this object.
    pub grants_count: usize,
}

/// Glacier / Deep Archive restore status for an object.
///
/// - `ongoing`: a restore is in progress but not yet complete.
/// - `expiry_secs`: Unix epoch when the restored copy expires (if already restored).
/// - Neither field set: the object is in a non-Glacier class or has no active restore.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RestoreStatus {
    /// `true` while an AWS Glacier restore job is in progress.
    pub ongoing: bool,
    /// Unix epoch (seconds) when the restored copy will expire, if restored.
    pub expiry_secs: Option<i64>,
}

// ---------------------------------------------------------------------------
// ObjectInspectorReport — the aggregated per-object report
// ---------------------------------------------------------------------------

/// Aggregated read-only properties for a single S3 object.
///
/// OCP: adding a new section (e.g. `legal_hold`, `retention`) is one new field
/// here plus one parallel arm in `inspect_object`. Existing sections are
/// untouched.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectInspectorReport {
    /// Properties from `HeadObject`.
    pub head: ObjectHead,
    /// Object tags from `GetObjectTagging`.
    pub tags: SectionResult<HashMap<String, String>>,
    /// ACL summary from `GetObjectAcl`.
    pub acl_summary: SectionResult<AclSummary>,
    /// Glacier/Deep Archive restore status.
    ///
    /// `Value(None)` means the object is in a non-Glacier class; no restore
    /// info is relevant. `Value(Some(…))` carries the parsed status.
    pub restore_status: SectionResult<Option<RestoreStatus>>,
    /// Version ID extracted from `HeadObject` — also available inline on
    /// `head.version_id` but mirrored here as a flat convenience field.
    pub version_id: Option<String>,
    /// SHA-256 checksum if returned by S3.
    pub checksum_sha256: Option<String>,
    /// MD5 checksum if returned by S3 (pre-SDK checksum header).
    pub checksum_md5: Option<String>,
    /// CRC-32 checksum if returned by S3.
    pub checksum_crc32: Option<String>,
}

// ---------------------------------------------------------------------------
// inspect_object — main entry point
// ---------------------------------------------------------------------------

/// Glacier-class storage class codes recognised for restore-status parsing.
fn is_glacier_class(storage_class: Option<&str>) -> bool {
    matches!(
        storage_class,
        Some("GLACIER") | Some("DEEP_ARCHIVE") | Some("GLACIER_IR") | Some("INTELLIGENT_TIERING")
    )
}

/// Parse the Glacier restore header string into a `RestoreStatus`.
///
/// S3 uses the form: `ongoing-request="true"` or
/// `ongoing-request="false", expiry-date="<RFC 2822 date>"`.
fn parse_restore_header(header: &str) -> RestoreStatus {
    let ongoing = header.contains("ongoing-request=\"true\"");
    // Extract expiry-date if present; parse to epoch seconds.
    let expiry_secs = header
        .find("expiry-date=\"")
        .and_then(|start| {
            let after = &header[start + 13..];
            after.find('"').map(|end| &after[..end])
        })
        .and_then(|date_str| {
            // httpdate / RFC 2822 — use a simple parser via chrono if available,
            // otherwise parse "Fri, 01 Jan 2027 00:00:00 GMT" style.
            parse_expiry_date(date_str)
        });
    RestoreStatus {
        ongoing,
        expiry_secs,
    }
}

/// Attempt to parse a Glacier restore expiry date to a Unix timestamp.
///
/// AWS returns HTTP-date strings such as `"Fri, 01 Jan 2027 00:00:00 GMT"`.
/// We parse via `aws_sdk_s3::primitives::DateTime` which is always available
/// as a re-export of `aws-smithy-types`.
///
/// Returns `None` on parse failure rather than panicking on unexpected formats.
fn parse_expiry_date(s: &str) -> Option<i64> {
    aws_sdk_s3::primitives::DateTime::from_str(s, aws_sdk_s3::primitives::DateTimeFormat::HttpDate)
        .ok()
        .map(|dt| dt.secs())
}

/// Fetch all object properties in parallel and return an `ObjectInspectorReport`.
///
/// - `HeadObject` is always called (hard failure if the key does not exist).
/// - `GetObjectTagging` and `GetObjectAcl` are called in parallel.
/// - Restore-status parsing reads the `Restore` header returned by `HeadObject`.
/// - `AccessDenied` on tagging/ACL → `SectionResult::Denied` recorded in the
///   capability cache so the UI can render disabled reasons.
pub async fn inspect_object(
    client: &Client,
    bucket: &str,
    key: &str,
    version_id: Option<String>,
    capability_cache: &CapabilityCache,
    profile_id: &ProfileId,
) -> Result<ObjectInspectorReport, AppError> {
    use crate::ids::BucketId;

    let bucket_id = BucketId::new(bucket);

    // --- HeadObject ---
    let mut head_req = client.head_object().bucket(bucket).key(key);
    if let Some(ref vid) = version_id {
        head_req = head_req.version_id(vid);
    }
    let head_resp = match head_req.send().await {
        Ok(r) => r,
        Err(SdkError::ServiceError(ref svc)) => {
            let code = svc.err().meta().code().unwrap_or("");
            return Err(if code == "NoSuchKey" || code == "404" {
                AppError::NotFound {
                    resource: format!("{bucket}/{key}"),
                }
            } else if code == "AccessDenied" || code == "InvalidClientTokenId" {
                AppError::Auth {
                    reason: format!("HeadObject denied: {code}"),
                }
            } else {
                AppError::Network {
                    source: format!("HeadObject({bucket}/{key}): {code}"),
                }
            });
        }
        Err(e) => {
            return Err(AppError::Network {
                source: format!("HeadObject({bucket}/{key}): {e}"),
            });
        }
    };

    // Extract checksum fields before moving head_resp.
    let checksum_sha256 = head_resp.checksum_sha256().map(|s| s.to_string());
    let checksum_md5 = head_resp.e_tag().map(|s| s.to_string()); // ETag is the MD5 for non-MPU
    let checksum_crc32 = head_resp.checksum_crc32().map(|s| s.to_string());
    let version_id_from_head = head_resp.version_id().map(|s| s.to_string());

    // Parse restore status from HeadObject response.
    let storage_class_str = head_resp.storage_class().map(|sc| sc.as_str().to_string());
    let restore_header = head_resp.restore().map(|s| s.to_string());
    let restore_status_value: Option<RestoreStatus> =
        if is_glacier_class(storage_class_str.as_deref()) {
            restore_header.as_deref().map(parse_restore_header)
        } else {
            None
        };

    // Build ObjectHead from the HeadObject response.
    let head = ObjectHead {
        content_length: head_resp.content_length(),
        content_type: head_resp.content_type().map(|s| s.to_string()),
        last_modified: head_resp.last_modified().map(|dt| dt.secs()),
        etag: head_resp.e_tag().map(|s| s.to_string()),
        version_id: version_id_from_head.clone(),
        storage_class: storage_class_str,
        server_side_encryption: head_resp
            .server_side_encryption()
            .map(|sse| sse.as_str().to_string()),
        sse_kms_key_id: head_resp.ssekms_key_id().map(|s| s.to_string()),
        content_encoding: head_resp.content_encoding().map(|s| s.to_string()),
        content_disposition: head_resp.content_disposition().map(|s| s.to_string()),
        cache_control: head_resp.cache_control().map(|s| s.to_string()),
        expires: head_resp.expires_string().and_then(parse_expiry_date),
        metadata: head_resp
            .metadata()
            .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default(),
    };

    // --- Parallel: GetObjectTagging + GetObjectAcl ---
    let (tags_result, acl_result) = tokio::join!(
        fetch_object_tags(client, bucket, key, version_id.as_deref()),
        fetch_object_acl(client, bucket, key, version_id.as_deref()),
    );

    // Record capability cache for denied sections.
    record_denied(
        capability_cache,
        profile_id,
        &bucket_id,
        "s3:GetObjectTagging",
        &tags_result,
    );
    record_denied(
        capability_cache,
        profile_id,
        &bucket_id,
        "s3:GetObjectAcl",
        &acl_result,
    );

    let tags = tags_result?;
    let acl_summary = acl_result?;

    Ok(ObjectInspectorReport {
        head,
        tags,
        acl_summary,
        restore_status: SectionResult::Value {
            value: restore_status_value,
        },
        version_id: version_id_from_head,
        checksum_sha256,
        checksum_md5,
        checksum_crc32,
    })
}

// ---------------------------------------------------------------------------
// head_object — lightweight HEAD-only path for the preview pane
// ---------------------------------------------------------------------------

/// Fetch only `HeadObject` for a single S3 object, returning an `ObjectHead`.
///
/// Lighter than `inspect_object` — no parallel `GetObjectTagging` or
/// `GetObjectAcl` calls.  Used by the preview pane for MIME-type detection and
/// size-limit checks before deciding which renderer to show.
///
/// # Errors
///
/// Returns `AppError::NotFound` if the key does not exist, `AppError::Auth` on
/// `AccessDenied`, and `AppError::Network` for other S3 errors.
pub async fn head_object(
    client: &Client,
    bucket: &str,
    key: &str,
    version_id: Option<String>,
) -> Result<ObjectHead, AppError> {
    let mut req = client.head_object().bucket(bucket).key(key);
    if let Some(ref vid) = version_id {
        req = req.version_id(vid);
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(SdkError::ServiceError(ref svc)) => {
            let code = svc.err().meta().code().unwrap_or("");
            return Err(if code == "NoSuchKey" || code == "404" {
                AppError::NotFound {
                    resource: format!("{bucket}/{key}"),
                }
            } else if code == "AccessDenied" || code == "InvalidClientTokenId" {
                AppError::Auth {
                    reason: format!("HeadObject denied: {code}"),
                }
            } else {
                AppError::Network {
                    source: format!("HeadObject({bucket}/{key}): {code}"),
                }
            });
        }
        Err(e) => {
            return Err(AppError::Network {
                source: format!("HeadObject({bucket}/{key}): {e}"),
            });
        }
    };

    let storage_class_str = resp.storage_class().map(|sc| sc.as_str().to_string());
    let head = ObjectHead {
        content_length: resp.content_length(),
        content_type: resp.content_type().map(|s| s.to_string()),
        last_modified: resp.last_modified().map(|dt| dt.secs()),
        etag: resp.e_tag().map(|s| s.to_string()),
        version_id: resp.version_id().map(|s| s.to_string()),
        storage_class: storage_class_str,
        server_side_encryption: resp
            .server_side_encryption()
            .map(|sse| sse.as_str().to_string()),
        sse_kms_key_id: resp.ssekms_key_id().map(|s| s.to_string()),
        content_encoding: resp.content_encoding().map(|s| s.to_string()),
        content_disposition: resp.content_disposition().map(|s| s.to_string()),
        cache_control: resp.cache_control().map(|s| s.to_string()),
        expires: resp.expires_string().and_then(parse_expiry_date),
        metadata: resp
            .metadata()
            .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default(),
    };

    Ok(head)
}

// ---------------------------------------------------------------------------
// Object section fetchers
// ---------------------------------------------------------------------------

/// Fetch object tags via `GetObjectTagging`.
async fn fetch_object_tags(
    client: &Client,
    bucket: &str,
    key: &str,
    version_id: Option<&str>,
) -> Result<SectionResult<HashMap<String, String>>, AppError> {
    let mut req = client.get_object_tagging().bucket(bucket).key(key);
    if let Some(vid) = version_id {
        req = req.version_id(vid);
    }
    match req.send().await {
        Ok(resp) => {
            let map: HashMap<String, String> = resp
                .tag_set()
                .iter()
                .map(|t| (t.key().to_string(), t.value().to_string()))
                .collect();
            Ok(SectionResult::Value { value: map })
        }
        Err(SdkError::ServiceError(ref svc)) => {
            let code = svc.err().meta().code().unwrap_or("");
            if code == "AccessDenied" || code == "InvalidClientTokenId" {
                return Ok(SectionResult::Denied {
                    iam_action: "s3:GetObjectTagging".to_string(),
                });
            }
            if code == "NoSuchKey" {
                return Err(AppError::NotFound {
                    resource: format!("{bucket}/{key}"),
                });
            }
            if is_unsupported_code(code) {
                return Ok(SectionResult::Unsupported {
                    reason: code.to_string(),
                });
            }
            Ok(SectionResult::Unsupported {
                reason: format!("GetObjectTagging: {code}"),
            })
        }
        Err(e) => Err(AppError::Network {
            source: format!("GetObjectTagging({bucket}/{key}): {e}"),
        }),
    }
}

/// Fetch object ACL summary via `GetObjectAcl`.
async fn fetch_object_acl(
    client: &Client,
    bucket: &str,
    key: &str,
    version_id: Option<&str>,
) -> Result<SectionResult<AclSummary>, AppError> {
    let mut req = client.get_object_acl().bucket(bucket).key(key);
    if let Some(vid) = version_id {
        req = req.version_id(vid);
    }
    match req.send().await {
        Ok(resp) => {
            let owner_display_name = resp
                .owner()
                .and_then(|o| o.display_name())
                .map(|s| s.to_string());
            let grants_count = resp.grants().len();
            Ok(SectionResult::Value {
                value: AclSummary {
                    owner_display_name,
                    grants_count,
                },
            })
        }
        Err(SdkError::ServiceError(ref svc)) => {
            let code = svc.err().meta().code().unwrap_or("");
            if code == "AccessDenied" || code == "InvalidClientTokenId" {
                return Ok(SectionResult::Denied {
                    iam_action: "s3:GetObjectAcl".to_string(),
                });
            }
            // When bucket uses BucketOwnerEnforced, ACL is disabled.
            if code == "AclNotSupported" || code == "IllegalLocationConstraintException" {
                return Ok(SectionResult::Unsupported {
                    reason: code.to_string(),
                });
            }
            if code == "NoSuchKey" {
                return Err(AppError::NotFound {
                    resource: format!("{bucket}/{key}"),
                });
            }
            if is_unsupported_code(code) {
                return Ok(SectionResult::Unsupported {
                    reason: code.to_string(),
                });
            }
            Ok(SectionResult::Unsupported {
                reason: format!("GetObjectAcl: {code}"),
            })
        }
        Err(e) => Err(AppError::Network {
            source: format!("GetObjectAcl({bucket}/{key}): {e}"),
        }),
    }
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn ser<T: Serialize>(v: &T) -> Value {
        serde_json::to_value(v).expect("must serialize")
    }

    // -- SectionResult serialization ------------------------------------------

    #[test]
    fn section_result_value_kind() {
        let r: SectionResult<String> = SectionResult::Value {
            value: "us-east-1".to_string(),
        };
        let v = ser(&r);
        assert_eq!(v["kind"], "value");
        assert_eq!(v["value"], "us-east-1");
    }

    #[test]
    fn section_result_denied_kind() {
        let r: SectionResult<String> = SectionResult::Denied {
            iam_action: "s3:GetBucketVersioning".to_string(),
        };
        let v = ser(&r);
        assert_eq!(v["kind"], "denied");
        assert_eq!(v["iamAction"], "s3:GetBucketVersioning");
    }

    #[test]
    fn section_result_unsupported_kind() {
        let r: SectionResult<String> = SectionResult::Unsupported {
            reason: "NotImplemented".to_string(),
        };
        let v = ser(&r);
        assert_eq!(v["kind"], "unsupported");
        assert_eq!(v["reason"], "NotImplemented");
    }

    #[test]
    fn section_result_deferred_kind() {
        let r: SectionResult<()> = SectionResult::Deferred {
            reason: "Deferred from v1".to_string(),
        };
        let v = ser(&r);
        assert_eq!(v["kind"], "deferred");
        assert_eq!(v["reason"], "Deferred from v1");
    }

    // -- BucketInspectorReport.bucket_policy is always Deferred --------------

    #[test]
    fn bucket_policy_is_always_deferred() {
        // Build a minimal report with a Value region and deferred policy.
        let report = BucketInspectorReport {
            region: SectionResult::Value {
                value: "us-east-1".to_string(),
            },
            versioning: SectionResult::Value {
                value: VersioningStatus::Disabled,
            },
            encryption: SectionResult::Unsupported {
                reason: "n/a".to_string(),
            },
            lifecycle: SectionResult::Value { value: vec![] },
            object_lock: SectionResult::Unsupported {
                reason: "n/a".to_string(),
            },
            public_access_block: SectionResult::Unsupported {
                reason: "n/a".to_string(),
            },
            cors: SectionResult::Value { value: vec![] },
            tags: SectionResult::Value {
                value: HashMap::new(),
            },
            replication: SectionResult::Unsupported {
                reason: "n/a".to_string(),
            },
            logging: SectionResult::Unsupported {
                reason: "n/a".to_string(),
            },
            website: SectionResult::Unsupported {
                reason: "n/a".to_string(),
            },
            notifications: SectionResult::Unsupported {
                reason: "n/a".to_string(),
            },
            ownership_controls: SectionResult::Unsupported {
                reason: "n/a".to_string(),
            },
            requester_pays: SectionResult::Value { value: false },
            bucket_policy: SectionResult::Deferred {
                reason: "Deferred from v1".to_string(),
            },
        };

        let v = ser(&report);
        assert_eq!(v["bucketPolicy"]["kind"], "deferred");
        assert_eq!(v["bucketPolicy"]["reason"], "Deferred from v1");
        // region is a Value
        assert_eq!(v["region"]["kind"], "value");
        assert_eq!(v["region"]["value"], "us-east-1");
    }

    // -- VersioningStatus serialization --------------------------------------

    #[test]
    fn versioning_status_variants_serialize() {
        assert_eq!(
            ser(&VersioningStatus::Enabled)["kind"],
            serde_json::json!(null) // not tagged — test raw string form
        );
        // VersioningStatus is a plain unit enum with camelCase rename_all.
        let v = serde_json::to_value(VersioningStatus::Enabled).unwrap();
        assert_eq!(v, "enabled");
        let v = serde_json::to_value(VersioningStatus::Suspended).unwrap();
        assert_eq!(v, "suspended");
        let v = serde_json::to_value(VersioningStatus::Disabled).unwrap();
        assert_eq!(v, "disabled");
    }

    // -- record_denied writes into capability cache -------------------------

    #[test]
    fn record_denied_writes_to_cache() {
        use crate::{
            cache::capability::{CapabilityCache, CapabilityClass},
            ids::{BucketId, ProfileId},
        };

        let cache = CapabilityCache::default();
        let profile_id = ProfileId::new_v4();
        let bucket_id = BucketId::new("my-bucket");
        let section: Result<SectionResult<String>, AppError> = Ok(SectionResult::Denied {
            iam_action: "s3:GetBucketVersioning".to_string(),
        });

        record_denied(
            &cache,
            &profile_id,
            &bucket_id,
            "s3:GetBucketVersioning",
            &section,
        );

        let record = cache.get(&profile_id, Some(&bucket_id), "s3:GetBucketVersioning");
        assert!(record.is_some(), "capability must be recorded after Denied");
        assert!(
            matches!(record.unwrap().class, CapabilityClass::Denied { .. }),
            "capability class must be Denied"
        );
    }

    #[test]
    fn record_denied_does_not_write_for_value() {
        use crate::{
            cache::capability::CapabilityCache,
            ids::{BucketId, ProfileId},
        };

        let cache = CapabilityCache::default();
        let profile_id = ProfileId::new_v4();
        let bucket_id = BucketId::new("my-bucket");
        let section: Result<SectionResult<String>, AppError> = Ok(SectionResult::Value {
            value: "us-east-1".to_string(),
        });

        record_denied(
            &cache,
            &profile_id,
            &bucket_id,
            "s3:GetBucketLocation",
            &section,
        );

        let record = cache.get(&profile_id, Some(&bucket_id), "s3:GetBucketLocation");
        assert!(record.is_none(), "no capability record for a Value section");
    }

    // -- ObjectHead serialization ---------------------------------------------

    #[test]
    fn object_head_serializes_metadata_user_fields() {
        let mut meta = HashMap::new();
        meta.insert("x-custom-key".to_string(), "hello".to_string());
        meta.insert("author".to_string(), "test".to_string());

        let head = ObjectHead {
            content_length: Some(1024),
            content_type: Some("application/octet-stream".to_string()),
            last_modified: Some(1_700_000_000),
            etag: Some("\"abc123\"".to_string()),
            version_id: Some("v1".to_string()),
            storage_class: Some("STANDARD".to_string()),
            server_side_encryption: None,
            sse_kms_key_id: None,
            content_encoding: None,
            content_disposition: None,
            cache_control: None,
            expires: None,
            metadata: meta,
        };

        let v = ser(&head);
        // camelCase serialization
        assert_eq!(v["contentLength"], 1024);
        assert_eq!(v["contentType"], "application/octet-stream");
        assert_eq!(v["etag"], "\"abc123\"");
        assert_eq!(v["versionId"], "v1");
        assert_eq!(v["storageClass"], "STANDARD");
        // User-defined metadata fields must be present
        assert_eq!(v["metadata"]["x-custom-key"], "hello");
        assert_eq!(v["metadata"]["author"], "test");
    }

    // -- AclSummary serialization --------------------------------------------

    #[test]
    fn acl_summary_serializes_correctly() {
        let acl = AclSummary {
            owner_display_name: Some("Alice".to_string()),
            grants_count: 3,
        };
        let v = ser(&acl);
        assert_eq!(v["ownerDisplayName"], "Alice");
        assert_eq!(v["grantsCount"], 3);
    }

    #[test]
    fn acl_summary_null_owner() {
        let acl = AclSummary {
            owner_display_name: None,
            grants_count: 0,
        };
        let v = ser(&acl);
        assert!(v["ownerDisplayName"].is_null());
        assert_eq!(v["grantsCount"], 0);
    }

    // -- RestoreStatus serialization -----------------------------------------

    #[test]
    fn restore_status_ongoing_serializes() {
        let rs = RestoreStatus {
            ongoing: true,
            expiry_secs: None,
        };
        let v = ser(&rs);
        assert_eq!(v["ongoing"], true);
        assert!(v["expirySecs"].is_null());
    }

    #[test]
    fn restore_status_completed_serializes() {
        let rs = RestoreStatus {
            ongoing: false,
            expiry_secs: Some(1_800_000_000),
        };
        let v = ser(&rs);
        assert_eq!(v["ongoing"], false);
        assert_eq!(v["expirySecs"], 1_800_000_000i64);
    }

    // -- parse_restore_header ------------------------------------------------

    #[test]
    fn parse_restore_header_ongoing_true() {
        let rs = parse_restore_header("ongoing-request=\"true\"");
        assert!(rs.ongoing);
        assert!(rs.expiry_secs.is_none());
    }

    #[test]
    fn parse_restore_header_ongoing_false_no_expiry() {
        let rs = parse_restore_header("ongoing-request=\"false\"");
        assert!(!rs.ongoing);
        assert!(rs.expiry_secs.is_none());
    }

    // -- is_glacier_class ----------------------------------------------------

    #[test]
    fn is_glacier_class_recognizes_glacier() {
        assert!(is_glacier_class(Some("GLACIER")));
        assert!(is_glacier_class(Some("DEEP_ARCHIVE")));
        assert!(is_glacier_class(Some("GLACIER_IR")));
        assert!(is_glacier_class(Some("INTELLIGENT_TIERING")));
    }

    #[test]
    fn is_glacier_class_rejects_standard() {
        assert!(!is_glacier_class(Some("STANDARD")));
        assert!(!is_glacier_class(Some("STANDARD_IA")));
        assert!(!is_glacier_class(None));
    }

    // -- ObjectInspectorReport: SectionResult::Denied for tags + acl ---------

    #[test]
    fn object_inspector_report_denied_tags_and_acl_serialize() {
        let report = ObjectInspectorReport {
            head: ObjectHead {
                content_length: Some(512),
                content_type: Some("text/plain".to_string()),
                last_modified: Some(1_700_000_000),
                etag: Some("\"deadbeef\"".to_string()),
                version_id: None,
                storage_class: Some("STANDARD".to_string()),
                server_side_encryption: None,
                sse_kms_key_id: None,
                content_encoding: None,
                content_disposition: None,
                cache_control: None,
                expires: None,
                metadata: HashMap::new(),
            },
            tags: SectionResult::Denied {
                iam_action: "s3:GetObjectTagging".to_string(),
            },
            acl_summary: SectionResult::Denied {
                iam_action: "s3:GetObjectAcl".to_string(),
            },
            restore_status: SectionResult::Value { value: None },
            version_id: None,
            checksum_sha256: None,
            checksum_md5: Some("\"deadbeef\"".to_string()),
            checksum_crc32: None,
        };

        let v = ser(&report);
        // tags section denied
        assert_eq!(v["tags"]["kind"], "denied");
        assert_eq!(v["tags"]["iamAction"], "s3:GetObjectTagging");
        // acl_summary section denied
        assert_eq!(v["aclSummary"]["kind"], "denied");
        assert_eq!(v["aclSummary"]["iamAction"], "s3:GetObjectAcl");
        // restore_status for non-Glacier is Value(null)
        assert_eq!(v["restoreStatus"]["kind"], "value");
        assert!(v["restoreStatus"]["value"].is_null());
        // checksums
        assert!(v["checksumSha256"].is_null());
        assert_eq!(v["checksumMd5"], "\"deadbeef\"");
    }
}
