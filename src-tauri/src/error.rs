//! Unified application error type and IPC error envelope.
//!
//! `AppError` is the only error type that crosses the Tauri IPC boundary.
//! It serialises to `{ kind, message, retryable, details? }` so the frontend
//! can map `kind` to a presentation policy (toast / inline / notification-log)
//! without parsing `message`.
//!
//! # OCP contract
//! Adding a new variant only requires:
//!   1. A new variant arm in `AppError`.
//!   2. A new inner struct `<Variant>Details` (when the variant carries data).
//!   3. A new arm in the exhaustive `match` inside `Serialize`.
//! No existing arms change. The envelope shape `{ kind, message, retryable, details }` is stable.

use serde::{Serialize, Serializer};
use serde_json::{json, Value};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Per-variant detail structs
// ---------------------------------------------------------------------------

/// Details for `AppError::Auth`.
#[derive(Debug, Clone, Serialize)]
pub struct AuthDetails {
    /// Discriminator: `"expired"`, `"invalid"`, or `"missing"`.
    pub reason: String,
}

/// Details for `AppError::AccessDenied`.
#[derive(Debug, Clone, Serialize)]
pub struct AccessDeniedDetails {
    pub op: String,
    pub resource: String,
}

/// Details for `AppError::NotFound`.
#[derive(Debug, Clone, Serialize)]
pub struct NotFoundDetails {
    pub resource: String,
}

/// Details for `AppError::Conflict`.
///
/// Field names use camelCase so they are ready for the IPC layer as-is.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictDetails {
    pub etag_expected: String,
    pub etag_actual: Option<String>,
}

/// Details for `AppError::RateLimited`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitedDetails {
    pub retry_after_ms: Option<u64>,
}

/// Details for `AppError::Unsupported`.
#[derive(Debug, Clone, Serialize)]
pub struct UnsupportedDetails {
    pub op: String,
    pub provider: String,
}

/// Details for `AppError::Network`.
#[derive(Debug, Clone, Serialize)]
pub struct NetworkDetails {
    /// String-ified upstream error message.
    pub source: String,
}

/// Details for `AppError::Locked`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockedDetails {
    pub lock_id: String,
    pub op_name: String,
}

/// Details for `AppError::Validation`.
#[derive(Debug, Clone, Serialize)]
pub struct ValidationDetails {
    pub field: String,
    pub hint: String,
}

/// Details for `AppError::ProviderSpecific`.
#[derive(Debug, Clone, Serialize)]
pub struct ProviderSpecificDetails {
    pub code: String,
    pub message: String,
}

/// Details for `AppError::Internal`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalDetails {
    /// UUID v4 linking this error to the diagnostics log bundle.
    pub trace_id: String,
}

// ---------------------------------------------------------------------------
// AppError enum
// ---------------------------------------------------------------------------

/// All errors that can leave a Tauri command.
///
/// Serializes to `{ kind, message, retryable, details? }`.
#[derive(Debug, Clone)]
pub enum AppError {
    /// Authentication failure. `reason` is `"expired"`, `"invalid"`, or `"missing"`.
    Auth { reason: String },
    /// Caller lacks permission for `op` on `resource`.
    AccessDenied { op: String, resource: String },
    /// The requested `resource` does not exist.
    NotFound { resource: String },
    /// ETag precondition failure.
    Conflict {
        etag_expected: String,
        etag_actual: Option<String>,
    },
    /// AWS / provider rate-limit hit. `retry_after_ms` is the hint from the
    /// `Retry-After` header when present.
    RateLimited { retry_after_ms: Option<u64> },
    /// The requested operation is not supported by this provider.
    Unsupported { op: String, provider: String },
    /// Network-level failure. `source` is the stringified upstream error.
    Network { source: String },
    /// User-initiated cancellation. Not retryable.
    Cancelled,
    /// A resource is held by an active lock.
    Locked { lock_id: String, op_name: String },
    /// Input validation failure.
    Validation { field: String, hint: String },
    /// Provider-specific error not mappable to another variant.
    ProviderSpecific { code: String, message: String },
    /// Catch-all. `trace_id` ties this error to the diagnostics log bundle.
    Internal { trace_id: String },
}

impl AppError {
    /// Construct an `Internal` error with a freshly-minted UUID v4 trace id.
    pub fn internal_new() -> Self {
        Self::Internal {
            trace_id: Uuid::new_v4().to_string(),
        }
    }

    /// The `kind` string used in the IPC envelope.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Auth { .. } => "Auth",
            Self::AccessDenied { .. } => "AccessDenied",
            Self::NotFound { .. } => "NotFound",
            Self::Conflict { .. } => "Conflict",
            Self::RateLimited { .. } => "RateLimited",
            Self::Unsupported { .. } => "Unsupported",
            Self::Network { .. } => "Network",
            Self::Cancelled => "Cancelled",
            Self::Locked { .. } => "Locked",
            Self::Validation { .. } => "Validation",
            Self::ProviderSpecific { .. } => "ProviderSpecific",
            Self::Internal { .. } => "Internal",
        }
    }

    /// Whether the frontend should offer a retry action.
    pub fn retryable(&self) -> bool {
        match self {
            // Transient conditions that may resolve without user action.
            Self::RateLimited { .. } | Self::Network { .. } => true,
            // Everything else is either permanent or user-initiated.
            Self::Auth { .. }
            | Self::AccessDenied { .. }
            | Self::NotFound { .. }
            | Self::Conflict { .. }
            | Self::Unsupported { .. }
            | Self::Cancelled
            | Self::Locked { .. }
            | Self::Validation { .. }
            | Self::ProviderSpecific { .. }
            | Self::Internal { .. } => false,
        }
    }

    /// Human-readable summary for the `message` field of the IPC envelope.
    pub fn message(&self) -> String {
        match self {
            Self::Auth { reason } => format!("Authentication failed: {reason}"),
            Self::AccessDenied { op, resource } => {
                format!("Access denied: cannot {op} on {resource}")
            }
            Self::NotFound { resource } => format!("Not found: {resource}"),
            Self::Conflict {
                etag_expected,
                etag_actual,
            } => match etag_actual {
                Some(actual) => {
                    format!("Conflict: expected ETag {etag_expected} but found {actual}")
                }
                None => format!("Conflict: expected ETag {etag_expected}"),
            },
            Self::RateLimited { retry_after_ms } => match retry_after_ms {
                Some(ms) => format!("Rate limited; retry after {ms} ms"),
                None => "Rate limited; please retry later".to_string(),
            },
            Self::Unsupported { op, provider } => {
                format!("Unsupported: {op} is not available on {provider}")
            }
            Self::Network { source } => format!("Network error: {source}"),
            Self::Cancelled => "Operation cancelled".to_string(),
            Self::Locked { lock_id, op_name } => {
                format!("Resource is locked (lock {lock_id}) by operation {op_name}")
            }
            Self::Validation { field, hint } => {
                format!("Validation error on field '{field}': {hint}")
            }
            Self::ProviderSpecific { code, message } => {
                format!("Provider error [{code}]: {message}")
            }
            Self::Internal { trace_id } => {
                format!("Internal error (trace: {trace_id})")
            }
        }
    }

    /// Variant payload as a JSON `Value`, or `None` for `Cancelled`.
    fn details(&self) -> Option<Value> {
        // Exhaustive match — compiler enforces that every new variant is handled.
        match self {
            Self::Auth { reason } => Some(
                serde_json::to_value(AuthDetails {
                    reason: reason.clone(),
                })
                .unwrap(),
            ),
            Self::AccessDenied { op, resource } => Some(
                serde_json::to_value(AccessDeniedDetails {
                    op: op.clone(),
                    resource: resource.clone(),
                })
                .unwrap(),
            ),
            Self::NotFound { resource } => Some(
                serde_json::to_value(NotFoundDetails {
                    resource: resource.clone(),
                })
                .unwrap(),
            ),
            Self::Conflict {
                etag_expected,
                etag_actual,
            } => Some(
                serde_json::to_value(ConflictDetails {
                    etag_expected: etag_expected.clone(),
                    etag_actual: etag_actual.clone(),
                })
                .unwrap(),
            ),
            Self::RateLimited { retry_after_ms } => Some(
                serde_json::to_value(RateLimitedDetails {
                    retry_after_ms: *retry_after_ms,
                })
                .unwrap(),
            ),
            Self::Unsupported { op, provider } => Some(
                serde_json::to_value(UnsupportedDetails {
                    op: op.clone(),
                    provider: provider.clone(),
                })
                .unwrap(),
            ),
            Self::Network { source } => Some(
                serde_json::to_value(NetworkDetails {
                    source: source.clone(),
                })
                .unwrap(),
            ),
            // Cancelled carries no data — details is omitted from the envelope.
            Self::Cancelled => None,
            Self::Locked { lock_id, op_name } => Some(
                serde_json::to_value(LockedDetails {
                    lock_id: lock_id.clone(),
                    op_name: op_name.clone(),
                })
                .unwrap(),
            ),
            Self::Validation { field, hint } => Some(
                serde_json::to_value(ValidationDetails {
                    field: field.clone(),
                    hint: hint.clone(),
                })
                .unwrap(),
            ),
            Self::ProviderSpecific { code, message } => Some(
                serde_json::to_value(ProviderSpecificDetails {
                    code: code.clone(),
                    message: message.clone(),
                })
                .unwrap(),
            ),
            Self::Internal { trace_id } => Some(
                serde_json::to_value(InternalDetails {
                    trace_id: trace_id.clone(),
                })
                .unwrap(),
            ),
        }
    }
}

// ---------------------------------------------------------------------------
// Serialize impl — IPC envelope { kind, message, retryable, details? }
// ---------------------------------------------------------------------------

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut obj = json!({
            "kind": self.kind(),
            "message": self.message(),
            "retryable": self.retryable(),
        });
        if let Some(details) = self.details() {
            obj["details"] = details;
        }
        obj.serialize(serializer)
    }
}

// ---------------------------------------------------------------------------
// std::error::Error + Display
// ---------------------------------------------------------------------------

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

impl std::error::Error for AppError {}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn ser(e: &AppError) -> Value {
        serde_json::to_value(e).expect("AppError must serialize")
    }

    fn assert_envelope(v: &Value, expected_kind: &str, expected_retryable: bool) {
        assert_eq!(
            v["kind"], expected_kind,
            "kind mismatch for {expected_kind}"
        );
        assert!(
            v["message"]
                .as_str()
                .map(|s| !s.is_empty())
                .unwrap_or(false),
            "message must be non-empty for {expected_kind}"
        );
        assert_eq!(
            v["retryable"],
            Value::Bool(expected_retryable),
            "retryable mismatch for {expected_kind}"
        );
    }

    #[test]
    fn auth_serializes() {
        let e = AppError::Auth {
            reason: "expired".to_string(),
        };
        let v = ser(&e);
        assert_envelope(&v, "Auth", false);
        assert_eq!(v["details"]["reason"], "expired");
    }

    #[test]
    fn access_denied_serializes() {
        let e = AppError::AccessDenied {
            op: "PutObject".to_string(),
            resource: "my-bucket/file.txt".to_string(),
        };
        let v = ser(&e);
        assert_envelope(&v, "AccessDenied", false);
        assert_eq!(v["details"]["op"], "PutObject");
        assert_eq!(v["details"]["resource"], "my-bucket/file.txt");
    }

    #[test]
    fn not_found_serializes() {
        let e = AppError::NotFound {
            resource: "s3://bucket/key".to_string(),
        };
        let v = ser(&e);
        assert_envelope(&v, "NotFound", false);
        assert_eq!(v["details"]["resource"], "s3://bucket/key");
    }

    #[test]
    fn conflict_with_actual_serializes() {
        let e = AppError::Conflict {
            etag_expected: "\"abc123\"".to_string(),
            etag_actual: Some("\"def456\"".to_string()),
        };
        let v = ser(&e);
        assert_envelope(&v, "Conflict", false);
        assert_eq!(v["details"]["etagExpected"], "\"abc123\"");
        assert_eq!(v["details"]["etagActual"], "\"def456\"");
    }

    #[test]
    fn conflict_without_actual_serializes() {
        let e = AppError::Conflict {
            etag_expected: "\"abc123\"".to_string(),
            etag_actual: None,
        };
        let v = ser(&e);
        assert_envelope(&v, "Conflict", false);
        assert_eq!(v["details"]["etagExpected"], "\"abc123\"");
        assert!(v["details"]["etagActual"].is_null());
    }

    #[test]
    fn rate_limited_with_hint_serializes() {
        let e = AppError::RateLimited {
            retry_after_ms: Some(5000),
        };
        let v = ser(&e);
        assert_envelope(&v, "RateLimited", true);
        assert_eq!(v["details"]["retryAfterMs"], 5000_u64);
    }

    #[test]
    fn rate_limited_without_hint_serializes() {
        let e = AppError::RateLimited {
            retry_after_ms: None,
        };
        let v = ser(&e);
        assert_envelope(&v, "RateLimited", true);
        assert!(v["details"]["retryAfterMs"].is_null());
    }

    #[test]
    fn unsupported_serializes() {
        let e = AppError::Unsupported {
            op: "SelectObjectContent".to_string(),
            provider: "MinIO".to_string(),
        };
        let v = ser(&e);
        assert_envelope(&v, "Unsupported", false);
        assert_eq!(v["details"]["op"], "SelectObjectContent");
        assert_eq!(v["details"]["provider"], "MinIO");
    }

    #[test]
    fn network_serializes() {
        let e = AppError::Network {
            source: "connection refused".to_string(),
        };
        let v = ser(&e);
        assert_envelope(&v, "Network", true);
        assert_eq!(v["details"]["source"], "connection refused");
    }

    #[test]
    fn cancelled_serializes() {
        let e = AppError::Cancelled;
        let v = ser(&e);
        assert_envelope(&v, "Cancelled", false);
        // Cancelled must NOT carry a details field.
        assert!(
            v.get("details").is_none(),
            "Cancelled must not have a details field"
        );
    }

    #[test]
    fn locked_serializes() {
        let e = AppError::Locked {
            lock_id: "lock-001".to_string(),
            op_name: "DeleteObject".to_string(),
        };
        let v = ser(&e);
        assert_envelope(&v, "Locked", false);
        assert_eq!(v["details"]["lockId"], "lock-001");
        assert_eq!(v["details"]["opName"], "DeleteObject");
    }

    #[test]
    fn validation_serializes() {
        let e = AppError::Validation {
            field: "bucket_name".to_string(),
            hint: "must not contain uppercase letters".to_string(),
        };
        let v = ser(&e);
        assert_envelope(&v, "Validation", false);
        assert_eq!(v["details"]["field"], "bucket_name");
        assert_eq!(v["details"]["hint"], "must not contain uppercase letters");
    }

    #[test]
    fn provider_specific_serializes() {
        let e = AppError::ProviderSpecific {
            code: "InvalidBucketState".to_string(),
            message: "bucket is in an invalid state for this operation".to_string(),
        };
        let v = ser(&e);
        assert_envelope(&v, "ProviderSpecific", false);
        assert_eq!(v["details"]["code"], "InvalidBucketState");
        assert_eq!(
            v["details"]["message"],
            "bucket is in an invalid state for this operation"
        );
    }

    #[test]
    fn internal_via_helper_serializes_valid_uuid() {
        let e = AppError::internal_new();
        let v = ser(&e);
        assert_envelope(&v, "Internal", false);
        let trace_id = v["details"]["traceId"]
            .as_str()
            .expect("traceId must be a string");
        // Validate that the trace_id parses as a UUID v4.
        let parsed = Uuid::parse_str(trace_id).expect("traceId must be a valid UUID");
        assert_eq!(parsed.get_version_num(), 4, "traceId must be a v4 UUID");
    }

    #[test]
    fn internal_explicit_trace_id_round_trips() {
        let trace_id = Uuid::new_v4().to_string();
        let e = AppError::Internal {
            trace_id: trace_id.clone(),
        };
        let v = ser(&e);
        assert_envelope(&v, "Internal", false);
        assert_eq!(v["details"]["traceId"], trace_id);
    }

    #[test]
    fn all_non_retryable_variants_are_false() {
        let cases: Vec<AppError> = vec![
            AppError::Auth {
                reason: "missing".to_string(),
            },
            AppError::AccessDenied {
                op: "op".to_string(),
                resource: "res".to_string(),
            },
            AppError::NotFound {
                resource: "r".to_string(),
            },
            AppError::Conflict {
                etag_expected: "e".to_string(),
                etag_actual: None,
            },
            AppError::Unsupported {
                op: "op".to_string(),
                provider: "p".to_string(),
            },
            AppError::Cancelled,
            AppError::Locked {
                lock_id: "l".to_string(),
                op_name: "n".to_string(),
            },
            AppError::Validation {
                field: "f".to_string(),
                hint: "h".to_string(),
            },
            AppError::ProviderSpecific {
                code: "c".to_string(),
                message: "m".to_string(),
            },
            AppError::internal_new(),
        ];
        for e in &cases {
            assert!(!e.retryable(), "{} must not be retryable", e.kind());
        }
    }
}
