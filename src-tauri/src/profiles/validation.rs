//! Profile validation — `sts:GetCallerIdentity` for AWS, `list_buckets` probe
//! for compat providers.
//!
//! # Design
//!
//! - AWS profiles (no `endpoint_url`): call `sts:GetCallerIdentity` via
//!   `aws-sdk-sts`. This surfaces the `account` and `arn` of the caller.
//! - Compat providers (has `endpoint_url`): call `s3:ListBuckets` as the probe
//!   because STS may not be supported at those endpoints.
//!
//! # Error mapping
//!
//! SDK errors are centralized in `map_sts_error` / `map_s3_list_error`.
//! Adding a new SDK error code means adding one arm to those functions — no
//! other code changes.
//!
//! # OCP
//!
//! - `ProviderKind` enum is open for new variants (`Sso`, `FederatedEnterprise`).
//! - `validate_profile` accepts an injected `&ClientPool` — testable with real
//!   LocalStack or a mock.
//! - The `validate_with_caller<F>` helper exposes pure error-mapping logic to
//!   unit tests without making any AWS SDK call.

use std::sync::Arc;

use aws_config::BehaviorVersion;
use aws_credential_types::provider::SharedCredentialsProvider;
use aws_sdk_s3::config::Builder as S3ConfigBuilder;
use aws_smithy_http_client::{tls, Builder as HttpBuilder};
use serde::Serialize;

use crate::{
    error::AppError,
    ids::ProfileId,
    profiles::{keychain::Secret, Profile},
    s3::ClientPool,
};

// ---------------------------------------------------------------------------
// ProviderKind — open for extension
// ---------------------------------------------------------------------------

/// The category of S3 provider a profile targets.
///
/// OCP: add `Sso`, `FederatedEnterprise`, `WebIdentity`, … as new variants
/// without changing any existing arm.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderKind {
    /// Standard AWS — validated via `sts:GetCallerIdentity`.
    Aws,
    /// S3-compatible provider (MinIO, LocalStack, R2, …) — validated via
    /// `s3:ListBuckets` probe.
    Compatible,
}

// ---------------------------------------------------------------------------
// ValidationReport
// ---------------------------------------------------------------------------

/// Result of a `profile_validate` call.
///
/// `ok = true` means the validation probe succeeded.  `ok = false` means it
/// failed; the `error` field carries the mapped `AppError`.
///
/// `account_id` and `arn` are populated only for AWS profiles that succeed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationReport {
    /// The profile that was validated.
    pub profile_id: ProfileId,
    /// Whether the probe succeeded.
    pub ok: bool,
    /// AWS account ID returned by `GetCallerIdentity`. `None` for compat
    /// providers or on failure.
    pub account_id: Option<String>,
    /// IAM ARN returned by `GetCallerIdentity`. `None` for compat providers
    /// or on failure.
    pub arn: Option<String>,
    /// Unix-millisecond timestamp of when validation ran. `0` on failure.
    pub validated_at: i64,
    /// Provider category used for the probe.
    pub provider_kind: ProviderKind,
    /// Mapped error when `ok = false`. `None` on success.
    pub error: Option<AppError>,
}

// ---------------------------------------------------------------------------
// now_unix_ms — current time in Unix milliseconds
// ---------------------------------------------------------------------------

fn now_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Error mapping helpers
// ---------------------------------------------------------------------------

/// Categorize a raw STS SDK error string into the canonical `AppError`.
///
/// Centralized so unit tests can exercise the mapping without a live AWS call.
///
/// `status` is the HTTP status code (0 if unknown); `code` is the AWS error
/// code string; `message` is the human-readable error from the SDK.
fn map_sts_error(status: u16, code: &str, message: &str) -> AppError {
    match code {
        // Credential or token problems.
        "InvalidClientTokenId"
        | "SignatureDoesNotMatch"
        | "ExpiredTokenException"
        | "ExpiredToken"
        | "UnrecognizedClientException"
        | "InvalidAccessKeyId" => AppError::Auth {
            reason: code.to_string(),
        },
        // 5xx or connection-level errors.
        _ if status >= 500 => AppError::Network {
            source: message.to_string(),
        },
        // Everything else.
        _ => AppError::ProviderSpecific {
            code: code.to_string(),
            message: message.to_string(),
        },
    }
}

/// Categorize a raw S3 ListBuckets SDK error into the canonical `AppError`.
fn map_s3_list_error(status: u16, code: &str, message: &str) -> AppError {
    match code {
        // Credential or token problems.
        "InvalidClientTokenId"
        | "SignatureDoesNotMatch"
        | "ExpiredTokenException"
        | "ExpiredToken"
        | "UnrecognizedClientException"
        | "InvalidAccessKeyId" => AppError::Auth {
            reason: code.to_string(),
        },
        // 403 Forbidden = access denied.
        "AccessDenied" | "Forbidden" => AppError::AccessDenied {
            op: "ListBuckets".to_string(),
            resource: "*".to_string(),
        },
        _ if status == 403 => AppError::AccessDenied {
            op: "ListBuckets".to_string(),
            resource: "*".to_string(),
        },
        // 5xx or connection-level errors.
        _ if status >= 500 => AppError::Network {
            source: message.to_string(),
        },
        // Everything else.
        _ => AppError::ProviderSpecific {
            code: code.to_string(),
            message: message.to_string(),
        },
    }
}

// ---------------------------------------------------------------------------
// validate_with_caller — pure error-mapping helper (testable without SDK)
// ---------------------------------------------------------------------------

/// Result type for the STS caller identity response.
#[derive(Debug, Clone)]
pub struct CallerIdentity {
    pub account_id: String,
    pub arn: String,
}

/// Pure validation logic for AWS profiles.
///
/// Accepts a `caller` closure that returns the STS result (or an error triple
/// `(status, code, message)`). This makes the mapping logic testable without
/// making any network call.
///
/// # Returns
///
/// - `Ok(CallerIdentity)` on success.
/// - `Err(AppError)` — the mapped error on failure.
pub fn validate_with_caller<F>(
    profile_id: &ProfileId,
    caller: F,
) -> Result<CallerIdentity, AppError>
where
    F: FnOnce() -> Result<CallerIdentity, (u16, String, String)>,
{
    caller().map_err(|(status, code, message)| {
        let _ = profile_id; // used by callers for context; keep the parameter.
        map_sts_error(status, &code, &message)
    })
}

// ---------------------------------------------------------------------------
// build_sts_client — build a one-shot STS client from a profile + secret
// ---------------------------------------------------------------------------

/// Build an `aws_sdk_sts::Client` for the given profile.
///
/// This is intentionally NOT pooled — STS clients are only used during
/// validation, not on the hot path. We build a fresh one per validation call.
async fn build_sts_client(profile: &Profile, secret: Option<&Secret>) -> aws_sdk_sts::Client {
    let http_client = HttpBuilder::new()
        .tls_provider(tls::Provider::Rustls(
            aws_smithy_http_client::tls::rustls_provider::CryptoMode::Ring,
        ))
        .build_https();

    let region_str = profile
        .default_region
        .clone()
        .unwrap_or_else(|| "us-east-1".to_string());
    let region = aws_config::Region::new(region_str);

    let mut loader = aws_config::defaults(BehaviorVersion::latest())
        .region(region)
        .http_client(http_client);

    if let Some(secret) = secret {
        use aws_credential_types::Credentials;
        let creds = Credentials::new(
            &secret.access_key_id,
            &secret.secret_access_key,
            secret.session_token.clone(),
            None,
            "brows3r-manual",
        );
        loader = loader.credentials_provider(SharedCredentialsProvider::new(creds));
    }

    let sdk_config = loader.load().await;
    aws_sdk_sts::Client::new(&sdk_config)
}

// ---------------------------------------------------------------------------
// build_s3_client_for_compat — build a one-shot S3 client for compat probe
// ---------------------------------------------------------------------------

/// Build an `aws_sdk_s3::Client` for a compat provider validation probe.
///
/// Uses the endpoint URL from `compat_flags` and path-style addressing.
/// Injected credentials come from `secret` (manual profile) or the SDK chain.
async fn build_s3_client_for_compat(
    profile: &Profile,
    secret: Option<&Secret>,
) -> aws_sdk_s3::Client {
    let http_client = HttpBuilder::new()
        .tls_provider(tls::Provider::Rustls(
            aws_smithy_http_client::tls::rustls_provider::CryptoMode::Ring,
        ))
        .build_https();

    let region_str = profile
        .default_region
        .clone()
        .unwrap_or_else(|| "us-east-1".to_string());
    let region = aws_config::Region::new(region_str);

    let endpoint_url = profile
        .compat_flags
        .endpoint_url
        .clone()
        .unwrap_or_default();

    let mut loader = aws_config::defaults(BehaviorVersion::latest())
        .region(region)
        .http_client(http_client)
        .endpoint_url(endpoint_url);

    if let Some(secret) = secret {
        use aws_credential_types::Credentials;
        let creds = Credentials::new(
            &secret.access_key_id,
            &secret.secret_access_key,
            secret.session_token.clone(),
            None,
            "brows3r-manual",
        );
        loader = loader.credentials_provider(SharedCredentialsProvider::new(creds));
    }

    let sdk_config = loader.load().await;

    // Always use path-style for compat providers.
    let mut s3_builder = S3ConfigBuilder::from(&sdk_config);
    s3_builder = s3_builder.force_path_style(true);

    aws_sdk_s3::Client::from_conf(s3_builder.build())
}

// ---------------------------------------------------------------------------
// validate_profile — main entry point
// ---------------------------------------------------------------------------

/// Validate a profile by running the appropriate probe.
///
/// - AWS profiles (no `endpoint_url`): `sts:GetCallerIdentity`.
/// - Compat providers (has `endpoint_url`): `s3:ListBuckets`.
///
/// The `pool` parameter is accepted for API symmetry and future use; the
/// compat path constructs a fresh client to avoid registering a transient
/// profile into the shared pool.
///
/// Always returns `Ok(report)`. SDK-level probe failures are captured inside
/// the `ValidationReport` as `ok = false` + `error`. The `Err` path is
/// reserved for future catastrophic conditions (e.g. missing required config).
pub async fn validate_profile(
    profile: &Profile,
    secret: Option<&Secret>,
    _pool: &Arc<ClientPool>,
) -> Result<ValidationReport, AppError> {
    let is_compat = profile.compat_flags.endpoint_url.is_some();

    let report = if is_compat {
        validate_compat(profile, secret).await
    } else {
        validate_aws(profile, secret).await
    };

    Ok(report)
}

/// Inner: AWS path using `sts:GetCallerIdentity`.
async fn validate_aws(profile: &Profile, secret: Option<&Secret>) -> ValidationReport {
    let client = build_sts_client(profile, secret).await;

    let result = client.get_caller_identity().send().await;

    match result {
        Ok(resp) => ValidationReport {
            profile_id: profile.id.clone(),
            ok: true,
            account_id: resp.account().map(str::to_owned),
            arn: resp.arn().map(str::to_owned),
            validated_at: now_unix_ms(),
            provider_kind: ProviderKind::Aws,
            error: None,
        },
        Err(sdk_err) => {
            let (status, code, message) = extract_sts_error_parts(&sdk_err);
            let mapped = map_sts_error(status, &code, &message);
            ValidationReport {
                profile_id: profile.id.clone(),
                ok: false,
                account_id: None,
                arn: None,
                validated_at: 0,
                provider_kind: ProviderKind::Aws,
                error: Some(mapped),
            }
        }
    }
}

/// Inner: compat provider path using `s3:ListBuckets`.
async fn validate_compat(profile: &Profile, secret: Option<&Secret>) -> ValidationReport {
    let client = build_s3_client_for_compat(profile, secret).await;

    let result = client.list_buckets().send().await;

    match result {
        Ok(_) => ValidationReport {
            profile_id: profile.id.clone(),
            ok: true,
            account_id: None,
            arn: None,
            validated_at: now_unix_ms(),
            provider_kind: ProviderKind::Compatible,
            error: None,
        },
        Err(sdk_err) => {
            let (status, code, message) = extract_s3_error_parts(&sdk_err);
            let mapped = map_s3_list_error(status, &code, &message);
            ValidationReport {
                profile_id: profile.id.clone(),
                ok: false,
                account_id: None,
                arn: None,
                validated_at: 0,
                provider_kind: ProviderKind::Compatible,
                error: Some(mapped),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Error part extractors — convert SDK error types to (status, code, message)
// ---------------------------------------------------------------------------

fn extract_sts_error_parts(
    err: &aws_sdk_sts::error::SdkError<
        aws_sdk_sts::operation::get_caller_identity::GetCallerIdentityError,
    >,
) -> (u16, String, String) {
    use aws_sdk_sts::error::SdkError;

    match err {
        SdkError::ServiceError(svc) => {
            let status = svc.raw().status().as_u16();
            let inner = svc.err();
            let code = inner.meta().code().unwrap_or("Unknown").to_string();
            let message = inner.meta().message().unwrap_or("").to_string();
            (status, code, message)
        }
        SdkError::ConstructionFailure(_) => (0, "ConstructionFailure".to_string(), err.to_string()),
        SdkError::TimeoutError(_) => (0, "TimeoutError".to_string(), err.to_string()),
        SdkError::DispatchFailure(_) => (503, "DispatchFailure".to_string(), err.to_string()),
        SdkError::ResponseError(_) => (500, "ResponseError".to_string(), err.to_string()),
        _ => (0, "Unknown".to_string(), err.to_string()),
    }
}

fn extract_s3_error_parts(
    err: &aws_sdk_s3::error::SdkError<aws_sdk_s3::operation::list_buckets::ListBucketsError>,
) -> (u16, String, String) {
    use aws_sdk_s3::error::SdkError;

    match err {
        SdkError::ServiceError(svc) => {
            let status = svc.raw().status().as_u16();
            let inner = svc.err();
            let code = inner.meta().code().unwrap_or("Unknown").to_string();
            let message = inner.meta().message().unwrap_or("").to_string();
            (status, code, message)
        }
        SdkError::ConstructionFailure(_) => (0, "ConstructionFailure".to_string(), err.to_string()),
        SdkError::TimeoutError(_) => (0, "TimeoutError".to_string(), err.to_string()),
        SdkError::DispatchFailure(_) => (503, "DispatchFailure".to_string(), err.to_string()),
        SdkError::ResponseError(_) => (500, "ResponseError".to_string(), err.to_string()),
        _ => (0, "Unknown".to_string(), err.to_string()),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::ProfileId;

    fn make_profile_id() -> ProfileId {
        ProfileId::new("test-profile")
    }

    // ------------------------------------------------------------------
    // Unit: map_sts_error — all mapped variants
    // ------------------------------------------------------------------

    #[test]
    fn map_sts_invalid_token_is_auth() {
        let err = map_sts_error(403, "InvalidClientTokenId", "invalid token");
        assert!(
            matches!(err, AppError::Auth { .. }),
            "expected Auth, got {err:?}"
        );
    }

    #[test]
    fn map_sts_signature_mismatch_is_auth() {
        let err = map_sts_error(403, "SignatureDoesNotMatch", "sig mismatch");
        assert!(
            matches!(err, AppError::Auth { .. }),
            "expected Auth, got {err:?}"
        );
    }

    #[test]
    fn map_sts_expired_token_is_auth() {
        let err = map_sts_error(400, "ExpiredTokenException", "token expired");
        assert!(
            matches!(err, AppError::Auth { .. }),
            "expected Auth, got {err:?}"
        );
    }

    #[test]
    fn map_sts_expired_token_short_code_is_auth() {
        let err = map_sts_error(400, "ExpiredToken", "token expired");
        assert!(matches!(err, AppError::Auth { .. }));
    }

    #[test]
    fn map_sts_unrecognized_client_is_auth() {
        let err = map_sts_error(403, "UnrecognizedClientException", "bad client");
        assert!(matches!(err, AppError::Auth { .. }));
    }

    #[test]
    fn map_sts_invalid_access_key_is_auth() {
        let err = map_sts_error(403, "InvalidAccessKeyId", "bad key");
        assert!(matches!(err, AppError::Auth { .. }));
    }

    #[test]
    fn map_sts_5xx_is_network() {
        let err = map_sts_error(503, "ServiceUnavailable", "AWS is down");
        assert!(
            matches!(err, AppError::Network { .. }),
            "expected Network, got {err:?}"
        );
    }

    #[test]
    fn map_sts_500_is_network() {
        let err = map_sts_error(500, "InternalFailure", "internal");
        assert!(matches!(err, AppError::Network { .. }));
    }

    #[test]
    fn map_sts_unknown_code_is_provider_specific() {
        let err = map_sts_error(400, "SomeOtherError", "details");
        assert!(
            matches!(err, AppError::ProviderSpecific { .. }),
            "expected ProviderSpecific, got {err:?}"
        );
    }

    // ------------------------------------------------------------------
    // Unit: map_s3_list_error — all mapped variants
    // ------------------------------------------------------------------

    #[test]
    fn map_s3_403_access_denied_code() {
        let err = map_s3_list_error(403, "AccessDenied", "access denied");
        assert!(
            matches!(err, AppError::AccessDenied { .. }),
            "expected AccessDenied, got {err:?}"
        );
    }

    #[test]
    fn map_s3_403_status_without_code() {
        let err = map_s3_list_error(403, "SomeUnknownCode", "forbidden");
        assert!(matches!(err, AppError::AccessDenied { .. }));
    }

    #[test]
    fn map_s3_invalid_token_is_auth() {
        let err = map_s3_list_error(403, "InvalidClientTokenId", "bad token");
        assert!(matches!(err, AppError::Auth { .. }));
    }

    #[test]
    fn map_s3_5xx_is_network() {
        let err = map_s3_list_error(502, "BadGateway", "proxy error");
        assert!(matches!(err, AppError::Network { .. }));
    }

    #[test]
    fn map_s3_unknown_is_provider_specific() {
        let err = map_s3_list_error(400, "BucketRegionError", "wrong region");
        assert!(matches!(err, AppError::ProviderSpecific { .. }));
    }

    // ------------------------------------------------------------------
    // Unit: validate_with_caller — pure mapping via closure injection
    // ------------------------------------------------------------------

    #[test]
    fn validate_with_caller_success_passes_through() {
        let id = make_profile_id();
        let result = validate_with_caller(&id, || {
            Ok(CallerIdentity {
                account_id: "123456789012".to_string(),
                arn: "arn:aws:iam::123456789012:user/test".to_string(),
            })
        });
        let identity = result.expect("expected success");
        assert_eq!(identity.account_id, "123456789012");
        assert_eq!(identity.arn, "arn:aws:iam::123456789012:user/test");
    }

    #[test]
    fn validate_with_caller_invalid_token_maps_to_auth() {
        let id = make_profile_id();
        let result = validate_with_caller(&id, || {
            Err((
                403u16,
                "InvalidClientTokenId".to_string(),
                "bad token".to_string(),
            ))
        });
        let err = result.unwrap_err();
        assert!(
            matches!(err, AppError::Auth { .. }),
            "InvalidClientTokenId must map to Auth; got {err:?}"
        );
    }

    #[test]
    fn validate_with_caller_5xx_maps_to_network() {
        let id = make_profile_id();
        let result = validate_with_caller(&id, || {
            Err((503u16, "ServiceUnavailable".to_string(), "down".to_string()))
        });
        let err = result.unwrap_err();
        assert!(
            matches!(err, AppError::Network { .. }),
            "5xx must map to Network; got {err:?}"
        );
    }

    #[test]
    fn validate_with_caller_unknown_code_maps_to_provider_specific() {
        let id = make_profile_id();
        let result = validate_with_caller(&id, || {
            Err((
                400u16,
                "Throttling".to_string(),
                "too many requests".to_string(),
            ))
        });
        let err = result.unwrap_err();
        assert!(
            matches!(err, AppError::ProviderSpecific { .. }),
            "unknown code must map to ProviderSpecific; got {err:?}"
        );
    }

    // ------------------------------------------------------------------
    // Unit: now_unix_ms sanity check
    // ------------------------------------------------------------------

    #[test]
    fn now_unix_ms_returns_reasonable_value() {
        let ts = now_unix_ms();
        // Must be after 2024-01-01T00:00:00Z = 1_704_067_200_000 ms.
        assert!(ts > 1_704_067_200_000i64, "timestamp looks stale: {ts}");
    }
}
