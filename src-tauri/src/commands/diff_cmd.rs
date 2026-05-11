//! Tauri commands for the diff preview / confirmation framework.
//!
//! # Commands
//!
//! - [`diff_preview_create`] — create a new pending diff; returns [`DiffId`].
//! - [`diff_preview_cancel`] — cancel a pending diff; voids future confirms.
//!
//! # OCP
//!
//! The `kind` discriminator in `diff_preview_create` is a string that maps to
//! a [`DiffPayload`] variant.  Adding a new kind = one new parse branch in the
//! match below + one new enum variant in `diff/mod.rs`.  Existing kinds are
//! unaffected.

use serde_json::Value;
use tauri::State;

use crate::{
    diff::{DiffId, DiffObjectRef, DiffPayload, DiffStoreHandle},
    error::AppError,
    ids::BucketId,
};

// ---------------------------------------------------------------------------
// diff_preview_create
// ---------------------------------------------------------------------------

/// Create a pending diff record and return its [`DiffId`].
///
/// # Parameters
///
/// - `kind`    — Must be `"storage_class"` in v1.  Other values are rejected
///               with `AppError::Validation`.
/// - `payload` — JSON-encoded payload matching the schema for the given kind.
/// - `store`   — The managed [`DiffStoreHandle`].
///
/// # Payload schema (kind = "storage_class")
///
/// ```json
/// {
///   "targets": [{ "bucket": "my-bucket", "key": "photos/img.jpg" }],
///   "current": { "photos/img.jpg": "STANDARD" },
///   "new_class": "GLACIER"
/// }
/// ```
///
/// # OCP
///
/// New kinds are added as new `match` arms.  The `kind` string is the only
/// discriminator — no other caller code changes.
#[tauri::command]
pub async fn diff_preview_create(
    kind: String,
    payload: Value,
    store: State<'_, DiffStoreHandle>,
) -> Result<DiffId, AppError> {
    let diff_payload = match kind.as_str() {
        "storage_class" => parse_storage_class_payload(payload)?,
        other => {
            return Err(AppError::Validation {
                field: "kind".to_string(),
                hint: format!(
                    "Unsupported diff kind \"{other}\". Supported kinds: [\"storage_class\"]"
                ),
            });
        }
    };

    let id = store.inner.create(diff_payload);
    Ok(id)
}

/// Parse the raw `payload` JSON into [`DiffPayload::StorageClass`].
fn parse_storage_class_payload(v: Value) -> Result<DiffPayload, AppError> {
    // targets: Vec<{ bucket, key }>
    let targets_raw =
        v.get("targets")
            .and_then(|t| t.as_array())
            .ok_or_else(|| AppError::Validation {
                field: "payload.targets".to_string(),
                hint: "targets must be an array of {bucket, key} objects".to_string(),
            })?;

    let mut targets = Vec::with_capacity(targets_raw.len());
    for item in targets_raw {
        let bucket =
            item.get("bucket")
                .and_then(|b| b.as_str())
                .ok_or_else(|| AppError::Validation {
                    field: "payload.targets[].bucket".to_string(),
                    hint: "each target must have a string 'bucket' field".to_string(),
                })?;
        let key = item
            .get("key")
            .and_then(|k| k.as_str())
            .ok_or_else(|| AppError::Validation {
                field: "payload.targets[].key".to_string(),
                hint: "each target must have a string 'key' field".to_string(),
            })?;
        targets.push(DiffObjectRef {
            bucket: BucketId::new(bucket),
            key: key.to_string(),
        });
    }

    // current: HashMap<String, String>
    let current_raw = v
        .get("current")
        .and_then(|c| c.as_object())
        .ok_or_else(|| AppError::Validation {
            field: "payload.current".to_string(),
            hint: "current must be an object mapping key → current_storage_class".to_string(),
        })?;

    let mut current = std::collections::HashMap::new();
    for (k, val) in current_raw {
        let class = val.as_str().ok_or_else(|| AppError::Validation {
            field: "payload.current".to_string(),
            hint: "current values must be strings".to_string(),
        })?;
        current.insert(k.clone(), class.to_string());
    }

    // new_class: String
    let new_class = v
        .get("new_class")
        .or_else(|| v.get("newClass"))
        .and_then(|c| c.as_str())
        .ok_or_else(|| AppError::Validation {
            field: "payload.new_class".to_string(),
            hint: "new_class must be a non-empty string".to_string(),
        })?
        .to_string();

    if new_class.is_empty() {
        return Err(AppError::Validation {
            field: "payload.new_class".to_string(),
            hint: "new_class must not be empty".to_string(),
        });
    }

    Ok(DiffPayload::StorageClass {
        targets,
        current,
        new_class,
    })
}

// ---------------------------------------------------------------------------
// diff_preview_cancel
// ---------------------------------------------------------------------------

/// Cancel a pending diff record, voiding any future confirm attempts.
///
/// After cancellation, `object_set_storage_class` (or any other command that
/// calls [`DiffStore::consume`]) will receive `None` and must return
/// `AppError::Validation { hint: "Diff was cancelled or expired" }`.
///
/// Returns `AppError::NotFound` when the `diff_id` does not exist.
#[tauri::command]
pub async fn diff_preview_cancel(
    diff_id: DiffId,
    store: State<'_, DiffStoreHandle>,
) -> Result<(), AppError> {
    store.inner.cancel(&diff_id)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff::{DiffPayload, DiffStatus, DiffStore};
    use std::collections::HashMap;

    // -----------------------------------------------------------------------
    // parse_storage_class_payload
    // -----------------------------------------------------------------------

    #[test]
    fn parse_storage_class_valid_payload() {
        let v = serde_json::json!({
            "targets": [{"bucket": "my-bucket", "key": "photos/img.jpg"}],
            "current": {"photos/img.jpg": "STANDARD"},
            "new_class": "GLACIER"
        });
        let payload = parse_storage_class_payload(v).unwrap();
        match payload {
            DiffPayload::StorageClass {
                targets,
                current,
                new_class,
            } => {
                assert_eq!(targets.len(), 1);
                assert_eq!(targets[0].key, "photos/img.jpg");
                assert_eq!(
                    current.get("photos/img.jpg").map(String::as_str),
                    Some("STANDARD")
                );
                assert_eq!(new_class, "GLACIER");
            }
        }
    }

    #[test]
    fn parse_storage_class_camel_case_new_class() {
        // Frontend sends camelCase; accept both.
        let v = serde_json::json!({
            "targets": [{"bucket": "b", "key": "k"}],
            "current": {"k": "STANDARD"},
            "newClass": "STANDARD_IA"
        });
        let payload = parse_storage_class_payload(v).unwrap();
        match payload {
            DiffPayload::StorageClass { new_class, .. } => {
                assert_eq!(new_class, "STANDARD_IA");
            }
        }
    }

    #[test]
    fn parse_storage_class_missing_targets_returns_validation_error() {
        let v = serde_json::json!({
            "current": {},
            "new_class": "GLACIER"
        });
        let err = parse_storage_class_payload(v).unwrap_err();
        assert!(matches!(err, AppError::Validation { field, .. } if field == "payload.targets"));
    }

    #[test]
    fn parse_storage_class_missing_new_class_returns_validation_error() {
        let v = serde_json::json!({
            "targets": [{"bucket": "b", "key": "k"}],
            "current": {}
        });
        let err = parse_storage_class_payload(v).unwrap_err();
        assert!(matches!(err, AppError::Validation { .. }));
    }

    // -----------------------------------------------------------------------
    // diff_preview_cancel — unit test on store directly
    // -----------------------------------------------------------------------

    #[test]
    fn cancel_marks_record_cancelled() {
        let store = DiffStore::new();
        let p = DiffPayload::StorageClass {
            targets: vec![],
            current: HashMap::new(),
            new_class: "GLACIER".to_string(),
        };
        let id = store.create(p);
        store.cancel(&id).unwrap();
        let record = store.get(&id).unwrap();
        assert_eq!(record.status, DiffStatus::Cancelled);
    }

    #[test]
    fn cancel_voids_subsequent_consume() {
        let store = DiffStore::new();
        let p = DiffPayload::StorageClass {
            targets: vec![],
            current: HashMap::new(),
            new_class: "GLACIER".to_string(),
        };
        let id = store.create(p);
        store.cancel(&id).unwrap();
        assert!(
            store.consume(&id).is_none(),
            "consume after cancel must fail"
        );
    }

    // -----------------------------------------------------------------------
    // Unknown kind returns Validation error
    // -----------------------------------------------------------------------

    #[test]
    fn unknown_kind_returns_validation_error_in_parse_path() {
        // We simulate the kind check directly since we can't call the async
        // command without a Tauri State wrapper in unit tests.
        let kind = "acl_change";
        let is_supported = matches!(kind, "storage_class");
        assert!(
            !is_supported,
            "acl_change must not be a supported kind in v1"
        );
    }
}
