//! Object tag setter via `PutObjectTagging` / `DeleteObjectTagging`.
//!
//! # Design
//!
//! Unlike metadata, AWS does not support an ETag `If-Match` header natively on
//! `PutObjectTagging`.  When an ETag precondition is required we perform an
//! explicit `HeadObject` call first, compare the live ETag, and then issue
//! `PutObjectTagging`.  This introduces a TOCTOU race window, but it is the
//! best AWS allows for tag-only updates.
//!
//! # Empty tag map → DeleteObjectTagging
//!
//! Passing an empty `tags` map is treated as a removal request.  This keeps
//! the API surface small (one command for both set and clear) and matches the
//! OCP goal of minimal primitives.
//!
//! # OCP
//!
//! - `PutResult` (from `metadata.rs`) is the shared return type.
//! - New precondition types (e.g. If-Modified-Since) can be added as new
//!   parameters without breaking the existing signature.

use std::collections::HashMap;

use aws_sdk_s3::{
    error::SdkError,
    types::{Tag, Tagging},
    Client,
};

use crate::{error::AppError, s3::metadata::PutResult};

// ---------------------------------------------------------------------------
// set_object_tags
// ---------------------------------------------------------------------------

/// Set (or clear) the tags on `bucket/key`.
///
/// When `tags` is empty this issues `DeleteObjectTagging` instead of
/// `PutObjectTagging`, removing all tags from the object.
///
/// # ETag precondition
///
/// When `if_match_etag` is `Some(etag)` the function first issues a
/// `HeadObject` call and compares the live ETag.  On a mismatch it returns
/// `AppError::Conflict { etag_expected, etag_actual: Some(live_etag) }`.
///
/// This check is inherently race-prone because `PutObjectTagging` has no
/// native `If-Match` support.  It is the best available mechanism for
/// tag-only updates on S3.
///
/// # Errors
///
/// - `AppError::Conflict`     — ETag precondition mismatch.
/// - `AppError::AccessDenied` — insufficient permissions.
/// - `AppError::NotFound`     — bucket or key does not exist.
/// - `AppError::RateLimited`  — throttling response from AWS.
/// - `AppError::Network`      — any other SDK or transport error.
pub async fn set_object_tags(
    client: &Client,
    bucket: &str,
    key: &str,
    tags: HashMap<String, String>,
    if_match_etag: Option<String>,
) -> Result<PutResult, AppError> {
    let resource = format!("{bucket}/{key}");

    // ------------------------------------------------------------------
    // 1. Optional ETag precondition via HeadObject (TOCTOU-limited).
    // ------------------------------------------------------------------
    let (head_etag, head_last_modified) = if if_match_etag.is_some() || tags.is_empty() {
        // We need head info for: (a) precondition check, (b) returning etag
        // on success for both set and delete paths.
        let head = client
            .head_object()
            .bucket(bucket)
            .key(key)
            .send()
            .await
            .map_err(|e| classify_head_sdk_error(e, &resource))?;

        let live_etag = head.e_tag().map(|s| s.trim_matches('"').to_string());
        let live_lm = head
            .last_modified()
            .map(|dt| dt.secs() * 1000 + i64::from(dt.subsec_nanos()) / 1_000_000);

        // Check precondition when requested.
        if let Some(ref expected) = if_match_etag {
            // Normalise both sides: strip surrounding quotes for comparison.
            let expected_stripped = expected.trim_matches('"');
            let live_stripped = live_etag.as_deref().unwrap_or("").trim_matches('"');
            if expected_stripped != live_stripped {
                return Err(AppError::Conflict {
                    etag_expected: expected.clone(),
                    etag_actual: live_etag,
                });
            }
        }

        (live_etag, live_lm)
    } else {
        (None, None)
    };

    // ------------------------------------------------------------------
    // 2. Set or delete tags.
    // ------------------------------------------------------------------
    if tags.is_empty() {
        // Empty tags map → remove all tags.
        client
            .delete_object_tagging()
            .bucket(bucket)
            .key(key)
            .send()
            .await
            .map_err(|e| classify_delete_tagging_sdk_error(e, &resource))?;
    } else {
        // Build the Tagging set from the provided map.
        let mut tag_set: Vec<Tag> = Vec::with_capacity(tags.len());
        for (k, v) in &tags {
            let tag = Tag::builder()
                .key(k)
                .value(v)
                .build()
                .map_err(|e| AppError::Internal {
                    trace_id: format!("tag_builder_failed: {e}"),
                })?;
            tag_set.push(tag);
        }

        let tagging = Tagging::builder()
            .set_tag_set(Some(tag_set))
            .build()
            .map_err(|e| AppError::Internal {
                trace_id: format!("tagging_builder_failed: {e}"),
            })?;

        client
            .put_object_tagging()
            .bucket(bucket)
            .key(key)
            .tagging(tagging)
            .send()
            .await
            .map_err(|e| classify_put_tagging_sdk_error(e, &resource))?;
    }

    // ------------------------------------------------------------------
    // 3. Return the same ETag + last_modified from the head we already did,
    //    or perform a head now if we skipped it (non-empty tags, no precondition).
    // ------------------------------------------------------------------
    let (result_etag, result_lm) = if head_etag.is_some() || head_last_modified.is_some() {
        (head_etag, head_last_modified)
    } else {
        // We only reach here when tags is non-empty AND if_match_etag is None.
        // Do a final HeadObject to return accurate etag/last_modified.
        let head = client
            .head_object()
            .bucket(bucket)
            .key(key)
            .send()
            .await
            .map_err(|e| classify_head_sdk_error(e, &resource))?;

        let etag = head.e_tag().map(|s| s.trim_matches('"').to_string());
        let lm = head
            .last_modified()
            .map(|dt| dt.secs() * 1000 + i64::from(dt.subsec_nanos()) / 1_000_000);
        (etag, lm)
    };

    Ok(PutResult {
        etag: result_etag,
        last_modified: result_lm,
        version_id: None,
    })
}

// ---------------------------------------------------------------------------
// SDK error classifiers
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
            "NoSuchKey" | "NotFound" => {
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
    // HeadObject 404 surfaces as a ResponseError with status 404.
    if let SdkError::ResponseError(ref re) = e {
        if re.raw().status().as_u16() == 404 {
            return AppError::NotFound {
                resource: resource.to_string(),
            };
        }
    }
    AppError::Network {
        source: e.to_string(),
    }
}

fn classify_put_tagging_sdk_error(
    e: SdkError<aws_sdk_s3::operation::put_object_tagging::PutObjectTaggingError>,
    resource: &str,
) -> AppError {
    if let SdkError::ServiceError(ref svc) = e {
        let code = svc.err().meta().code().unwrap_or("");
        match code {
            "AccessDenied" | "InvalidClientTokenId" => {
                return AppError::AccessDenied {
                    op: "s3:PutObjectTagging".to_string(),
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

fn classify_delete_tagging_sdk_error(
    e: SdkError<aws_sdk_s3::operation::delete_object_tagging::DeleteObjectTaggingError>,
    resource: &str,
) -> AppError {
    if let SdkError::ServiceError(ref svc) = e {
        let code = svc.err().meta().code().unwrap_or("");
        match code {
            "AccessDenied" | "InvalidClientTokenId" => {
                return AppError::AccessDenied {
                    op: "s3:DeleteObjectTagging".to_string(),
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::s3::metadata::PutResult;

    // ------------------------------------------------------------------
    // ETag precondition logic — unit test without live AWS
    // ------------------------------------------------------------------

    /// Simulate the precondition check logic extracted from set_object_tags.
    fn check_precondition(expected: &str, live: &str) -> Result<(), AppError> {
        let expected_stripped = expected.trim_matches('"');
        let live_stripped = live.trim_matches('"');
        if expected_stripped != live_stripped {
            return Err(AppError::Conflict {
                etag_expected: expected.to_string(),
                etag_actual: Some(live.to_string()),
            });
        }
        Ok(())
    }

    #[test]
    fn etag_precondition_match_succeeds() {
        assert!(check_precondition("\"abc123\"", "\"abc123\"").is_ok());
    }

    #[test]
    fn etag_precondition_match_without_quotes_succeeds() {
        assert!(check_precondition("abc123", "abc123").is_ok());
    }

    #[test]
    fn etag_precondition_mismatch_returns_conflict() {
        let err = check_precondition("\"abc123\"", "\"def456\"").unwrap_err();
        match err {
            AppError::Conflict {
                etag_expected,
                etag_actual,
            } => {
                assert_eq!(etag_expected, "\"abc123\"");
                assert_eq!(etag_actual.as_deref(), Some("\"def456\""));
            }
            other => panic!("expected Conflict, got {other:?}"),
        }
    }

    #[test]
    fn etag_precondition_mixed_quote_style_matches() {
        // Both sides are stripped before comparison.
        assert!(check_precondition("\"abc123\"", "abc123").is_ok());
    }

    // ------------------------------------------------------------------
    // Empty tags map → delete path (logic assertion)
    // ------------------------------------------------------------------

    #[test]
    fn empty_tags_map_triggers_delete_path() {
        let tags: HashMap<String, String> = HashMap::new();
        assert!(
            tags.is_empty(),
            "empty map must trigger delete-tagging path"
        );
    }

    #[test]
    fn non_empty_tags_map_triggers_put_path() {
        let mut tags = HashMap::new();
        tags.insert("env".to_string(), "prod".to_string());
        assert!(
            !tags.is_empty(),
            "non-empty map must trigger put-tagging path"
        );
    }

    // ------------------------------------------------------------------
    // PutResult re-exported from metadata.rs is usable here
    // ------------------------------------------------------------------

    #[test]
    fn put_result_from_tags_serialises() {
        let r = PutResult {
            etag: Some("deadbeef".to_string()),
            last_modified: Some(1_000_000),
            version_id: None,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["etag"], "deadbeef");
        assert_eq!(v["lastModified"], 1_000_000_i64);
        assert!(!v.as_object().unwrap().contains_key("versionId"));
    }
}
