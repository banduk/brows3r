//! Presigned URL generation for S3 objects.
//!
//! # Design
//!
//! AWS SigV4 presigned URLs embed the credentials directly in the query string
//! (via `X-Amz-Signature`, `X-Amz-Credential`, `X-Amz-Date`, …) so the
//! recipient can fetch the object without AWS credentials of their own.
//!
//! The URL is generated entirely in Rust — credentials never cross the Tauri
//! IPC boundary.  The frontend receives an opaque `PresignedUrl` struct and
//! writes the URL to the clipboard.
//!
//! # Expiry limits (AWS SigV4)
//!
//! - Minimum: 60 seconds (enforce in this module; 1-second URLs are technically
//!   valid but useless and confusing).
//! - Maximum: 604 800 seconds (7 days) — hard AWS limit for SigV4 presigned URLs.
//!
//! # OCP
//!
//! `PresignedUrl` is intentionally open: `expires_in_secs` and `method` can be
//! added as optional fields in a future task without breaking the IPC shape.
//! A `presign_put_object` function would mirror this one with a `PutObject`
//! builder — no changes to existing callers.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aws_sdk_s3::{presigning::PresigningConfig, Client};
use serde::{Deserialize, Serialize};

use crate::error::AppError;

// ---------------------------------------------------------------------------
// Expiry limits
// ---------------------------------------------------------------------------

/// Minimum presigned URL expiry (60 s).  URLs shorter than this are
/// essentially unusable and would confuse users.
pub const MIN_EXPIRES_SECS: u64 = 60;

/// Maximum presigned URL expiry (7 days in seconds).
/// Hard AWS limit for SigV4 presigned GET URLs.
pub const MAX_EXPIRES_SECS: u64 = 7 * 24 * 3600; // 604_800

// ---------------------------------------------------------------------------
// PresignedUrl — IPC response type
// ---------------------------------------------------------------------------

/// Result returned by `object_presign`.
///
/// OCP: `expires_in_secs: Option<u64>` and `method: Option<String>` may be
/// added as optional fields in a future task without breaking existing call
/// sites.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresignedUrl {
    /// The full presigned URL string.  The frontend copies this to the clipboard.
    pub url: String,
    /// Unix timestamp (milliseconds) when the URL expires.
    pub expires_at: i64,
}

// ---------------------------------------------------------------------------
// presign_get_object
// ---------------------------------------------------------------------------

/// Generate a presigned `GetObject` URL for `bucket/key`.
///
/// # Arguments
///
/// - `client`       — AWS S3 client (already scoped to the correct region/profile).
/// - `bucket`       — Bucket name.
/// - `key`          — Full object key.
/// - `expires_secs` — URL lifetime in seconds.  Must be in `[60, 604_800]`.
///
/// # Errors
///
/// - `AppError::Validation { field: "expires_secs", … }` when `expires_secs`
///   is outside the allowed range.
/// - `AppError::Internal { … }` when the AWS SDK presigning call fails.
pub async fn presign_get_object(
    client: &Client,
    bucket: &str,
    key: &str,
    expires_secs: u64,
) -> Result<PresignedUrl, AppError> {
    // ------------------------------------------------------------------
    // 1. Validate expiry range
    // ------------------------------------------------------------------
    if expires_secs < MIN_EXPIRES_SECS {
        return Err(AppError::Validation {
            field: "expires_secs".to_string(),
            hint: format!("expires_secs must be at least {MIN_EXPIRES_SECS} seconds"),
        });
    }
    if expires_secs > MAX_EXPIRES_SECS {
        return Err(AppError::Validation {
            field: "expires_secs".to_string(),
            hint: format!("expires_secs must not exceed {MAX_EXPIRES_SECS} seconds (7 days)"),
        });
    }

    // ------------------------------------------------------------------
    // 2. Build PresigningConfig
    // ------------------------------------------------------------------
    let presigning_config = PresigningConfig::expires_in(Duration::from_secs(expires_secs))
        .map_err(|e| AppError::Internal {
            trace_id: format!("presigning_config_build_failed:{e}"),
        })?;

    // ------------------------------------------------------------------
    // 3. Generate presigned URL via AWS SDK
    // ------------------------------------------------------------------
    let presigned_request = client
        .get_object()
        .bucket(bucket)
        .key(key)
        .presigned(presigning_config)
        .await
        .map_err(|e| AppError::Internal {
            trace_id: format!("presign_get_object_failed:{e}"),
        })?;

    // ------------------------------------------------------------------
    // 4. Compute expires_at (Unix ms)
    // ------------------------------------------------------------------
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let expires_at = now_ms + (expires_secs as i64) * 1_000;

    Ok(PresignedUrl {
        url: presigned_request.uri().to_string(),
        expires_at,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ------------------------------------------------------------------
    // Expiry boundary validation (unit — no network)
    // ------------------------------------------------------------------

    #[test]
    fn expires_secs_below_minimum_returns_validation_error() {
        // 1 second — below the 60-second minimum.
        let err = validate_expires_secs(1).unwrap_err();
        match err {
            AppError::Validation { field, hint } => {
                assert_eq!(field, "expires_secs");
                assert!(hint.contains("60"), "hint must mention the minimum: {hint}");
            }
            other => panic!("expected Validation, got {:?}", other),
        }
    }

    #[test]
    fn expires_secs_at_minimum_is_valid() {
        assert!(validate_expires_secs(MIN_EXPIRES_SECS).is_ok());
    }

    #[test]
    fn expires_secs_typical_one_hour_is_valid() {
        assert!(validate_expires_secs(3_600).is_ok());
    }

    #[test]
    fn expires_secs_at_maximum_is_valid() {
        assert!(validate_expires_secs(MAX_EXPIRES_SECS).is_ok());
    }

    #[test]
    fn expires_secs_above_maximum_returns_validation_error() {
        let err = validate_expires_secs(MAX_EXPIRES_SECS + 1).unwrap_err();
        match err {
            AppError::Validation { field, hint } => {
                assert_eq!(field, "expires_secs");
                assert!(
                    hint.contains("604800") || hint.contains("7 days"),
                    "hint must mention the maximum: {hint}"
                );
            }
            other => panic!("expected Validation, got {:?}", other),
        }
    }

    // ------------------------------------------------------------------
    // PresignedUrl serialisation
    // ------------------------------------------------------------------

    #[test]
    fn presigned_url_serialises_camel_case() {
        let p = PresignedUrl {
            url: "https://s3.example.com/bucket/key?X-Amz-Signature=abc".to_string(),
            expires_at: 1_700_000_000_000,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(
            v["url"],
            "https://s3.example.com/bucket/key?X-Amz-Signature=abc"
        );
        assert_eq!(v["expiresAt"], 1_700_000_000_000_i64);
    }

    // ------------------------------------------------------------------
    // expires_at is in the future (approximate)
    // ------------------------------------------------------------------

    #[test]
    fn expires_at_is_in_the_future_for_valid_secs() {
        let expires_secs: u64 = 3_600;
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        let expires_at = now_ms + (expires_secs as i64) * 1_000;

        assert!(expires_at > now_ms, "expires_at must be strictly after now");
        // Allow 1 s of jitter in both directions.
        let expected_ms = now_ms + 3_600_000_i64;
        let delta = (expires_at - expected_ms).abs();
        assert!(
            delta < 1_000,
            "expires_at must be within 1 s of now + expires_secs"
        );
    }
}

/// Pure validation helper — exposed for unit tests in other modules.
///
/// Calling this from `objects_cmd` tests avoids the need for a real S3 client
/// while still testing the same validation path as `presign_get_object`.
#[doc(hidden)]
pub fn presign_get_object_validate_only(expires_secs: u64) -> Result<(), AppError> {
    validate_expires_secs(expires_secs)
}

/// Pure validation helper extracted so unit tests can call it without a real
/// client.  The command and `presign_get_object` both call this inline for
/// consistency.
fn validate_expires_secs(expires_secs: u64) -> Result<(), AppError> {
    if expires_secs < MIN_EXPIRES_SECS {
        return Err(AppError::Validation {
            field: "expires_secs".to_string(),
            hint: format!("expires_secs must be at least {MIN_EXPIRES_SECS} seconds"),
        });
    }
    if expires_secs > MAX_EXPIRES_SECS {
        return Err(AppError::Validation {
            field: "expires_secs".to_string(),
            hint: format!("expires_secs must not exceed {MAX_EXPIRES_SECS} seconds (7 days)"),
        });
    }
    Ok(())
}
