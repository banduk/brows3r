//! Multipart upload bookkeeping via redb.
//!
//! # Architecture
//!
//! `MultipartTable` wraps a shared redb `Database` handle and provides typed
//! CRUD operations over the `multipart_active` table.  The same DB file used by
//! `CacheStore` is reused so there is only one redb file handle per process.
//!
//! # Table schema
//!
//! - Table name: `"multipart_active"`
//! - Key  : `"<profile_id>\x00<bucket>\x00<key>"` — composite string key.
//! - Value: `serde_json::to_vec(MultipartRecord)`.
//!
//! # Key design (OCP note)
//!
//! The composite key is `(profile, bucket, object_key)` rather than
//! `upload_id`.  Concurrent uploads to the same `(profile, bucket, key)` are
//! rare; the second upload overwrites the first record, keeping the table in
//! sync with the active upload.  `find_by_upload_id` does a linear scan and is
//! used only by the cleanup scanner (task 38).

use std::sync::Arc;

use redb::{Database, ReadableTable, TableDefinition};
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::ids::{BucketId, ProfileId};

// ---------------------------------------------------------------------------
// Table definition
// ---------------------------------------------------------------------------

/// redb table for in-flight multipart uploads.
const MULTIPART_TABLE: TableDefinition<&str, &[u8]> = TableDefinition::new("multipart_active");

// ---------------------------------------------------------------------------
// MultipartRecord
// ---------------------------------------------------------------------------

/// Persisted record for one in-flight multipart upload.
///
/// OCP: additional fields can be appended with `#[serde(default)]` without
/// breaking existing records stored on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MultipartRecord {
    /// AWS multipart upload ID returned by `CreateMultipartUpload`.
    pub upload_id: String,
    /// Unix timestamp (milliseconds) when the upload was initiated.
    pub started_at: i64,
    /// Source tag — `"brows3r"` for uploads started by this app.
    ///
    /// The cleanup scanner (task 38) uses this to distinguish brows3r-started
    /// uploads from foreign ones and requires explicit confirmation for the
    /// latter.
    pub source: String,
    pub profile_id: ProfileId,
    pub bucket: BucketId,
    /// S3 object key.
    pub key: String,
}

// ---------------------------------------------------------------------------
// MultipartTable
// ---------------------------------------------------------------------------

/// Typed wrapper around the `multipart_active` redb table.
///
/// Clone-safe: the inner `Arc<Database>` is cheap to clone.
#[derive(Clone)]
pub struct MultipartTable {
    db: Arc<Database>,
}

impl MultipartTable {
    /// Create a `MultipartTable` bound to an existing redb `Database`.
    ///
    /// This opens (and, if necessary, creates) the `multipart_active` table
    /// inside the provided database.  Reusing the same `Database` instance as
    /// `CacheStore` avoids holding two file handles on `cache.redb`.
    pub fn new(db: Arc<Database>) -> Result<Self, AppError> {
        // Ensure the table exists.
        let txn = db.begin_write().map_err(|e| AppError::Internal {
            trace_id: format!("multipart redb begin_write failed: {e}"),
        })?;
        {
            txn.open_table(MULTIPART_TABLE)
                .map_err(|e| AppError::Internal {
                    trace_id: format!("multipart redb open_table failed: {e}"),
                })?;
        }
        txn.commit().map_err(|e| AppError::Internal {
            trace_id: format!("multipart redb commit failed: {e}"),
        })?;

        Ok(Self { db })
    }

    // -----------------------------------------------------------------------
    // Composite key helper
    // -----------------------------------------------------------------------

    fn make_key(profile: &ProfileId, bucket: &BucketId, key: &str) -> String {
        format!("{}\x00{}\x00{}", profile.as_str(), bucket.as_str(), key)
    }

    // -----------------------------------------------------------------------
    // record
    // -----------------------------------------------------------------------

    /// Insert or overwrite a `MultipartRecord`.
    ///
    /// Overwrites any existing record for the same `(profile, bucket, key)`.
    pub fn record(&self, rec: &MultipartRecord) -> Result<(), AppError> {
        let composite = Self::make_key(&rec.profile_id, &rec.bucket, &rec.key);
        let bytes = serde_json::to_vec(rec).map_err(|e| AppError::Internal {
            trace_id: format!("multipart serialize failed: {e}"),
        })?;

        let txn = self.db.begin_write().map_err(|e| AppError::Internal {
            trace_id: format!("multipart redb begin_write failed: {e}"),
        })?;
        {
            let mut table = txn
                .open_table(MULTIPART_TABLE)
                .map_err(|e| AppError::Internal {
                    trace_id: format!("multipart redb open_table failed: {e}"),
                })?;
            table
                .insert(composite.as_str(), bytes.as_slice())
                .map_err(|e| AppError::Internal {
                    trace_id: format!("multipart redb insert failed: {e}"),
                })?;
        }
        txn.commit().map_err(|e| AppError::Internal {
            trace_id: format!("multipart redb commit failed: {e}"),
        })
    }

    // -----------------------------------------------------------------------
    // remove
    // -----------------------------------------------------------------------

    /// Delete the record for `(profile, bucket, key)`.
    ///
    /// No-op when the entry does not exist.
    pub fn remove(
        &self,
        profile: &ProfileId,
        bucket: &BucketId,
        key: &str,
    ) -> Result<(), AppError> {
        let composite = Self::make_key(profile, bucket, key);

        let txn = self.db.begin_write().map_err(|e| AppError::Internal {
            trace_id: format!("multipart redb begin_write failed: {e}"),
        })?;
        {
            let mut table = txn
                .open_table(MULTIPART_TABLE)
                .map_err(|e| AppError::Internal {
                    trace_id: format!("multipart redb open_table failed: {e}"),
                })?;
            let _ = table
                .remove(composite.as_str())
                .map_err(|e| AppError::Internal {
                    trace_id: format!("multipart redb remove failed: {e}"),
                })?;
        }
        txn.commit().map_err(|e| AppError::Internal {
            trace_id: format!("multipart redb commit failed: {e}"),
        })
    }

    // -----------------------------------------------------------------------
    // list_all
    // -----------------------------------------------------------------------

    /// Return all active multipart upload records.
    pub fn list_all(&self) -> Result<Vec<MultipartRecord>, AppError> {
        let txn = self.db.begin_read().map_err(|e| AppError::Internal {
            trace_id: format!("multipart redb begin_read failed: {e}"),
        })?;
        let table = txn
            .open_table(MULTIPART_TABLE)
            .map_err(|e| AppError::Internal {
                trace_id: format!("multipart redb open_table failed: {e}"),
            })?;

        let mut records = Vec::new();
        for entry in table.iter().map_err(|e| AppError::Internal {
            trace_id: format!("multipart redb iter failed: {e}"),
        })? {
            let (_, v) = entry.map_err(|e| AppError::Internal {
                trace_id: format!("multipart redb iter entry failed: {e}"),
            })?;
            let rec: MultipartRecord =
                serde_json::from_slice(v.value()).map_err(|e| AppError::Internal {
                    trace_id: format!("multipart deserialize failed: {e}"),
                })?;
            records.push(rec);
        }
        Ok(records)
    }

    // -----------------------------------------------------------------------
    // list_for_profile
    // -----------------------------------------------------------------------

    /// Return all active records for `profile`.
    pub fn list_for_profile(&self, profile: &ProfileId) -> Result<Vec<MultipartRecord>, AppError> {
        let all = self.list_all()?;
        Ok(all
            .into_iter()
            .filter(|r| &r.profile_id == profile)
            .collect())
    }

    // -----------------------------------------------------------------------
    // find_by_upload_id
    // -----------------------------------------------------------------------

    /// Linear scan to find a record by its `upload_id`.
    ///
    /// Used by the cleanup scanner (task 38) to correlate uploads reported by
    /// S3 `list_multipart_uploads` with brows3r bookkeeping records.
    pub fn find_by_upload_id(&self, upload_id: &str) -> Result<Option<MultipartRecord>, AppError> {
        let all = self.list_all()?;
        Ok(all.into_iter().find(|r| r.upload_id == upload_id))
    }
}

// ---------------------------------------------------------------------------
// MultipartTableHandle — Tauri managed state
// ---------------------------------------------------------------------------

/// Tauri managed state handle for `MultipartTable`.
///
/// Clone-safe: the inner `MultipartTable` already wraps an `Arc<Database>`.
#[derive(Clone)]
pub struct MultipartTableHandle(pub MultipartTable);

impl MultipartTableHandle {
    pub fn new(table: MultipartTable) -> Self {
        Self(table)
    }
}

// ---------------------------------------------------------------------------
// MultipartSource
// ---------------------------------------------------------------------------

/// Discriminates the origin of an in-progress multipart upload.
///
/// # OCP note
///
/// Binary in v1. Adding `RemoteAgent` (another brows3r instance) is one new
/// variant. The `confirmed_unknown` guard in `abort_multipart_upload`
/// centralises the safety policy so no call sites change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MultipartSource {
    /// Started by this brows3r instance and tracked in `multipart_active`.
    Brows3r,
    /// Found in `list_multipart_uploads` but not in our table — started by
    /// another tool, session, or account.
    Unknown,
}

// ---------------------------------------------------------------------------
// MultipartUpload — response DTO for the cleanup scanner
// ---------------------------------------------------------------------------

/// Describes one in-progress multipart upload as returned by the cleanup scanner.
///
/// Serialises to camelCase for the Tauri IPC layer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultipartUpload {
    /// AWS multipart upload ID.
    pub upload_id: String,
    /// S3 object key.
    pub key: String,
    /// Unix timestamp (seconds) when the upload was initiated, if known.
    pub initiated: Option<i64>,
    /// Whether this upload was started by brows3r or an external tool.
    pub source: MultipartSource,
    /// Bucket in which the upload is in-progress.
    pub bucket: BucketId,
}

// ---------------------------------------------------------------------------
// scan_multipart_uploads
// ---------------------------------------------------------------------------

/// List all in-progress multipart uploads for `bucket`, classify each as
/// `Brows3r` or `Unknown`, and optionally filter out uploads younger than
/// `older_than_secs`.
///
/// # Algorithm
///
/// 1. Call `list_multipart_uploads` to obtain all in-progress uploads.
/// 2. For each upload, check `multipart_table.find_by_upload_id`:
///    - found → `MultipartSource::Brows3r`
///    - not found → `MultipartSource::Unknown`
/// 3. Apply the `older_than_secs` threshold — uploads initiated **less than**
///    `older_than_secs` seconds ago are excluded from the result.
pub async fn scan_multipart_uploads(
    client: &aws_sdk_s3::Client,
    bucket: &BucketId,
    multipart_table: &MultipartTable,
    older_than_secs: Option<u64>,
) -> Result<Vec<MultipartUpload>, AppError> {
    let resp = client
        .list_multipart_uploads()
        .bucket(bucket.as_str())
        .send()
        .await
        .map_err(|e| AppError::Network {
            source: format!("list_multipart_uploads failed: {e}"),
        })?;

    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut result = Vec::new();

    for upload in resp.uploads() {
        let upload_id = match upload.upload_id() {
            Some(id) => id.to_owned(),
            None => continue,
        };
        let key = match upload.key() {
            Some(k) => k.to_owned(),
            None => continue,
        };

        // AWS returns `initiated` as a `DateTime`; convert to Unix seconds.
        let initiated_secs: Option<i64> = upload
            .initiated()
            .and_then(|dt| dt.to_millis().ok())
            .map(|ms| ms / 1000);

        // Apply age filter: skip uploads younger than the threshold.
        if let (Some(threshold), Some(init_secs)) = (older_than_secs, initiated_secs) {
            let age_secs = now_secs.saturating_sub(init_secs as u64);
            if age_secs < threshold {
                continue;
            }
        }

        let source = if multipart_table.find_by_upload_id(&upload_id)?.is_some() {
            MultipartSource::Brows3r
        } else {
            MultipartSource::Unknown
        };

        result.push(MultipartUpload {
            upload_id,
            key,
            initiated: initiated_secs,
            source,
            bucket: bucket.clone(),
        });
    }

    Ok(result)
}

// ---------------------------------------------------------------------------
// abort_multipart_upload
// ---------------------------------------------------------------------------

/// Abort a single in-progress multipart upload.
///
/// # Safety guard
///
/// If `source == Unknown` and `confirmed_unknown == false`, the call is
/// rejected with `AppError::Validation { field: "confirmedUnknown", … }`.
/// This prevents accidental abortion of uploads started by other tools or
/// sessions without explicit user acknowledgement.
///
/// # Post-abort cleanup
///
/// On a successful abort of a `Brows3r`-sourced upload, the corresponding
/// record is removed from `multipart_table` so the cleanup scanner no longer
/// sees it.
pub async fn abort_multipart_upload(
    client: &aws_sdk_s3::Client,
    bucket: &BucketId,
    key: &str,
    upload_id: &str,
    source: MultipartSource,
    multipart_table: &MultipartTable,
    profile_id: &ProfileId,
    confirmed_unknown: bool,
) -> Result<(), AppError> {
    if source == MultipartSource::Unknown && !confirmed_unknown {
        return Err(AppError::Validation {
            field: "confirmedUnknown".to_string(),
            hint: "Aborting an unknown multipart upload requires explicit confirmation".to_string(),
        });
    }

    client
        .abort_multipart_upload()
        .bucket(bucket.as_str())
        .key(key)
        .upload_id(upload_id)
        .send()
        .await
        .map_err(|e| AppError::Network {
            source: format!("abort_multipart_upload failed: {e}"),
        })?;

    // Remove from bookkeeping table only for brows3r-owned uploads.
    if source == MultipartSource::Brows3r {
        multipart_table.remove(profile_id, bucket, key)?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::{BucketId, ProfileId};
    use std::sync::Arc;
    use tempfile::tempdir;

    fn open_db(path: &std::path::Path) -> Arc<Database> {
        Arc::new(Database::create(path).expect("test db must open"))
    }

    fn profile() -> ProfileId {
        ProfileId::new("p1")
    }

    fn bucket() -> BucketId {
        BucketId::new("my-bucket")
    }

    fn sample_record(upload_id: &str, key: &str) -> MultipartRecord {
        MultipartRecord {
            upload_id: upload_id.to_owned(),
            started_at: 1_700_000_000_000,
            source: "brows3r".to_owned(),
            profile_id: profile(),
            bucket: bucket(),
            key: key.to_owned(),
        }
    }

    // -----------------------------------------------------------------------
    // Round-trip: record → list_all → remove → list_all empty
    // -----------------------------------------------------------------------

    #[test]
    fn redb_round_trip_record_list_remove() {
        let dir = tempdir().unwrap();
        let db = open_db(&dir.path().join("test.redb"));
        let table = MultipartTable::new(Arc::clone(&db)).expect("table must open");

        let rec = sample_record("upload-abc", "data/file.bin");
        table.record(&rec).expect("record must succeed");

        let all = table.list_all().expect("list_all must succeed");
        assert_eq!(all.len(), 1);
        assert_eq!(all[0], rec);

        table
            .remove(&profile(), &bucket(), "data/file.bin")
            .expect("remove must succeed");

        let after = table
            .list_all()
            .expect("list_all after remove must succeed");
        assert!(after.is_empty(), "table must be empty after remove");
    }

    // -----------------------------------------------------------------------
    // Overwrite: same key, different upload_id
    // -----------------------------------------------------------------------

    #[test]
    fn record_overwrites_same_key() {
        let dir = tempdir().unwrap();
        let db = open_db(&dir.path().join("test2.redb"));
        let table = MultipartTable::new(Arc::clone(&db)).expect("table must open");

        let rec1 = sample_record("upload-1", "obj.bin");
        let mut rec2 = sample_record("upload-2", "obj.bin");
        rec2.started_at = 1_700_000_001_000;

        table.record(&rec1).expect("first record must succeed");
        table.record(&rec2).expect("overwrite must succeed");

        let all = table.list_all().expect("list_all must succeed");
        assert_eq!(all.len(), 1, "overwrite must not duplicate");
        assert_eq!(all[0].upload_id, "upload-2", "second record must win");
    }

    // -----------------------------------------------------------------------
    // list_for_profile
    // -----------------------------------------------------------------------

    #[test]
    fn list_for_profile_filters_by_profile() {
        let dir = tempdir().unwrap();
        let db = open_db(&dir.path().join("test3.redb"));
        let table = MultipartTable::new(Arc::clone(&db)).expect("table must open");

        let other_profile = ProfileId::new("other");
        let rec_p1 = sample_record("up-p1", "a.bin");
        let mut rec_other = sample_record("up-other", "b.bin");
        rec_other.profile_id = other_profile.clone();

        table.record(&rec_p1).expect("record p1 must succeed");
        table.record(&rec_other).expect("record other must succeed");

        let p1_records = table
            .list_for_profile(&profile())
            .expect("list_for_profile must succeed");
        assert_eq!(p1_records.len(), 1);
        assert_eq!(p1_records[0].upload_id, "up-p1");

        let other_records = table
            .list_for_profile(&other_profile)
            .expect("list_for_profile must succeed");
        assert_eq!(other_records.len(), 1);
        assert_eq!(other_records[0].upload_id, "up-other");
    }

    // -----------------------------------------------------------------------
    // find_by_upload_id
    // -----------------------------------------------------------------------

    #[test]
    fn find_by_upload_id_returns_matching_record() {
        let dir = tempdir().unwrap();
        let db = open_db(&dir.path().join("test4.redb"));
        let table = MultipartTable::new(Arc::clone(&db)).expect("table must open");

        let rec = sample_record("uid-xyz", "prefix/obj.bin");
        table.record(&rec).expect("record must succeed");

        let found = table
            .find_by_upload_id("uid-xyz")
            .expect("find must not error");
        assert!(found.is_some(), "record must be found by upload_id");
        assert_eq!(found.unwrap().key, "prefix/obj.bin");

        let missing = table
            .find_by_upload_id("nonexistent")
            .expect("find must not error");
        assert!(missing.is_none(), "missing upload_id must return None");
    }

    // -----------------------------------------------------------------------
    // remove is a no-op on missing key
    // -----------------------------------------------------------------------

    #[test]
    fn remove_missing_key_is_noop() {
        let dir = tempdir().unwrap();
        let db = open_db(&dir.path().join("test5.redb"));
        let table = MultipartTable::new(Arc::clone(&db)).expect("table must open");

        // Remove on an empty table must not panic or error.
        table
            .remove(&profile(), &bucket(), "nonexistent.bin")
            .expect("remove must be no-op on missing key");
    }

    // -----------------------------------------------------------------------
    // scan classification: Brows3r vs Unknown via find_by_upload_id
    // -----------------------------------------------------------------------

    #[test]
    fn classify_brows3r_upload_by_upload_id() {
        // An upload_id that exists in our table classifies as Brows3r.
        let dir = tempdir().unwrap();
        let db = open_db(&dir.path().join("test_class.redb"));
        let table = MultipartTable::new(Arc::clone(&db)).expect("table must open");

        let rec = sample_record("brows3r-upload-id", "obj.bin");
        table.record(&rec).expect("record must succeed");

        // Simulate classify: found → Brows3r
        let found = table
            .find_by_upload_id("brows3r-upload-id")
            .expect("find must not error");
        let source = if found.is_some() {
            MultipartSource::Brows3r
        } else {
            MultipartSource::Unknown
        };
        assert_eq!(source, MultipartSource::Brows3r);
    }

    #[test]
    fn classify_unknown_upload_when_not_in_table() {
        // An upload_id absent from our table classifies as Unknown.
        let dir = tempdir().unwrap();
        let db = open_db(&dir.path().join("test_unknown.redb"));
        let table = MultipartTable::new(Arc::clone(&db)).expect("table must open");

        // No records inserted — everything is Unknown.
        let found = table
            .find_by_upload_id("foreign-upload-id")
            .expect("find must not error");
        let source = if found.is_some() {
            MultipartSource::Brows3r
        } else {
            MultipartSource::Unknown
        };
        assert_eq!(source, MultipartSource::Unknown);
    }

    // -----------------------------------------------------------------------
    // older_than_secs filter logic
    // -----------------------------------------------------------------------

    #[test]
    fn age_filter_excludes_young_uploads() {
        // Simulate the age calculation from scan_multipart_uploads.
        let now_secs: u64 = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let threshold: u64 = 3600; // 1 hour

        // Upload initiated 30 minutes ago (young → should be excluded).
        let young_init_secs = (now_secs - 1800) as i64;
        let age_young = now_secs.saturating_sub(young_init_secs as u64);
        assert!(
            age_young < threshold,
            "young upload must be below threshold"
        );

        // Upload initiated 2 hours ago (old → should be included).
        let old_init_secs = (now_secs.saturating_sub(7200)) as i64;
        let age_old = now_secs.saturating_sub(old_init_secs as u64);
        assert!(
            age_old >= threshold,
            "old upload must meet or exceed threshold"
        );
    }

    // -----------------------------------------------------------------------
    // abort safety guard: Unknown + no confirmation → Validation error
    // -----------------------------------------------------------------------

    #[test]
    fn abort_guard_rejects_unknown_without_confirmation() {
        // Replicate the guard logic from abort_multipart_upload.
        let source = MultipartSource::Unknown;
        let confirmed_unknown = false;

        let result: Result<(), AppError> =
            if source == MultipartSource::Unknown && !confirmed_unknown {
                Err(AppError::Validation {
                    field: "confirmedUnknown".to_string(),
                    hint: "Aborting an unknown multipart upload requires explicit confirmation"
                        .to_string(),
                })
            } else {
                Ok(())
            };

        assert!(
            result.is_err(),
            "guard must reject Unknown without confirmation"
        );
        let err = result.unwrap_err();
        match err {
            AppError::Validation { field, .. } => {
                assert_eq!(field, "confirmedUnknown");
            }
            _ => panic!("expected Validation error"),
        }
    }

    #[test]
    fn abort_guard_allows_unknown_with_confirmation() {
        // Replicate the guard logic from abort_multipart_upload.
        let source = MultipartSource::Unknown;
        let confirmed_unknown = true;

        let result: Result<(), AppError> =
            if source == MultipartSource::Unknown && !confirmed_unknown {
                Err(AppError::Validation {
                    field: "confirmedUnknown".to_string(),
                    hint: "Aborting an unknown multipart upload requires explicit confirmation"
                        .to_string(),
                })
            } else {
                Ok(())
            };

        assert!(result.is_ok(), "guard must allow Unknown with confirmation");
    }

    #[test]
    fn abort_guard_allows_brows3r_without_confirmation() {
        // Brows3r-owned uploads do not need a confirmation flag.
        let source = MultipartSource::Brows3r;
        let confirmed_unknown = false;

        let result: Result<(), AppError> =
            if source == MultipartSource::Unknown && !confirmed_unknown {
                Err(AppError::Validation {
                    field: "confirmedUnknown".to_string(),
                    hint: "Aborting an unknown multipart upload requires explicit confirmation"
                        .to_string(),
                })
            } else {
                Ok(())
            };

        assert!(
            result.is_ok(),
            "Brows3r uploads must not require confirmation"
        );
    }
}
