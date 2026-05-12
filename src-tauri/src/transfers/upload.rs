//! Single-part and multipart upload implementation.
//!
//! # Protocol
//!
//! 1. Acquire a scoped resource lock via `LockRegistry`.
//! 2. `tokio::fs::metadata(source_path)` → `total_bytes`.
//! 3. If `total_bytes < 5 MB`: single-part `put_object` path.
//! 4. Else: multipart path:
//!    a. `create_multipart_upload` → upload_id.
//!    b. Record in redb `multipart_active` table.
//!    c. Compute `part_size = max(8 MB, total_bytes / 9999)` (cap at 10 000 parts).
//!    d. Stream parts concurrently via `tokio::Semaphore` (default 4 in-flight).
//!    e. `complete_multipart_upload` → remove from `multipart_active` → emit `objects:updated`.
//! 5. On cancel: `abort_multipart_upload`, remove from table, emit `Canceled`.
//! 6. On error: same cleanup.
//! 7. Release lock with appropriate `ReleaseReason`.
//!
//! # OCP contract
//!
//! The lock registry, transfer registry, and progress throttle are reused from
//! task 31 (download).  No new infrastructure is introduced.

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use aws_sdk_s3::{
    primitives::ByteStream,
    types::{CompletedMultipartUpload, CompletedPart},
    Client,
};
use tokio::{fs as tokio_fs, sync::Semaphore};

use crate::{
    error::AppError,
    events::{EventEmitter, EventKind},
    ids::{BucketId, ObjectKey, ProfileId},
    locks::{LockId, LockRegistry, LockScope, ReleaseReason},
    notifications::{os::OsNotifyChannel, NotificationLogHandle},
    s3::multipart::{MultipartRecord, MultipartTable},
    transfers::{
        notify::notify_terminal,
        progress::{emit_progress, emit_state, emit_state_with_error, ProgressThrottle},
        TransferRegistryHandle, TransferState,
    },
};

// ---------------------------------------------------------------------------
// Size constants
// ---------------------------------------------------------------------------

/// Files smaller than this use single-part `put_object`.
const SINGLE_PART_THRESHOLD: u64 = 5 * 1024 * 1024; // 5 MB

/// Minimum multipart part size (8 MB).
const MIN_PART_SIZE: u64 = 8 * 1024 * 1024; // 8 MB

/// S3 maximum part count.
const MAX_PARTS: u64 = 9_999;

// ---------------------------------------------------------------------------
// ObjectsUpdatedPayload
// ---------------------------------------------------------------------------

/// Payload for the `objects:updated` event.
///
/// Signals the frontend to invalidate the adapter cache for the given prefix.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ObjectsUpdatedPayload {
    profile_id: String,
    bucket: String,
    prefix: String,
}

// ---------------------------------------------------------------------------
// upload_object
// ---------------------------------------------------------------------------

/// Upload `source_path` to `bucket/key`.
///
/// # Parameters
///
/// - `client`             — authenticated S3 client.
/// - `bucket`             — target bucket.
/// - `key`                — target S3 key.
/// - `source_path`        — local file to upload.
/// - `request_id`         — UUID v4 from `TransferRegistry::register`.
/// - `channel`            — event emitter.
/// - `registry`           — transfer registry for state updates.
/// - `lock_registry`      — resource lock registry.
/// - `multipart_table`    — redb multipart bookkeeping table.
/// - `transfer_concurrency_per_part` — semaphore width for concurrent parts (default 4).
/// - `profile_id`         — used for lock scope and multipart records.
/// - `lock_ttl_secs`      — lock TTL.
/// - `cancel_flag`        — set to `true` when the caller wants cancellation.
/// - `log`                — in-app notification log for terminal-state notifications.
/// - `os_notifier`        — OS notification bridge (settings-gated internally).
pub async fn upload_object<E, C>(
    client: Arc<Client>,
    bucket: BucketId,
    key: String,
    source_path: PathBuf,
    request_id: String,
    channel: &E,
    registry: TransferRegistryHandle,
    lock_registry: Arc<LockRegistry>,
    multipart_table: Arc<MultipartTable>,
    transfer_concurrency_per_part: u32,
    profile_id: ProfileId,
    lock_ttl_secs: u64,
    cancel_flag: Arc<AtomicBool>,
    log: NotificationLogHandle,
    os_notifier: &crate::notifications::os::OsNotifier<C>,
) -> Result<(), AppError>
where
    E: EventEmitter,
    C: OsNotifyChannel,
{
    // -----------------------------------------------------------------------
    // 1. Acquire resource lock
    // -----------------------------------------------------------------------
    let now = now_secs();
    let scope = LockScope {
        profile: profile_id.clone(),
        bucket: Some(bucket.clone()),
        prefix: None,
        key: Some(ObjectKey::new(key.clone())),
    };

    let lock_id = lock_registry.acquire(scope, "upload", lock_ttl_secs, now)?;

    // -----------------------------------------------------------------------
    // 2. Mark transfer Running
    // -----------------------------------------------------------------------
    {
        let mut reg = registry.0.write().await;
        let _ = reg.update(&request_id, |t| {
            t.state = TransferState::Running;
        });
    }
    let _ = emit_state(channel, &request_id, TransferState::Running);

    // -----------------------------------------------------------------------
    // 3. Get file size
    // -----------------------------------------------------------------------
    let meta = match tokio_fs::metadata(&source_path).await {
        Ok(m) => m,
        Err(e) => {
            let err = AppError::Network {
                source: format!("metadata failed: {e}"),
            };
            cleanup_on_error(
                &request_id,
                &registry,
                &lock_registry,
                &lock_id,
                channel,
                err.clone(),
                &log,
                os_notifier,
            )
            .await;
            return Err(err);
        }
    };
    let total_bytes = meta.len();

    {
        let mut reg = registry.0.write().await;
        let _ = reg.update(&request_id, |t| {
            t.total_bytes = Some(total_bytes);
        });
    }

    // -----------------------------------------------------------------------
    // 4. Dispatch: single-part or multipart
    // -----------------------------------------------------------------------
    let result = if total_bytes < SINGLE_PART_THRESHOLD {
        single_part_upload(
            &client,
            &bucket,
            &key,
            &source_path,
            total_bytes,
            &request_id,
            channel,
            &registry,
            &cancel_flag,
        )
        .await
    } else {
        multipart_upload(
            &client,
            &bucket,
            &key,
            &source_path,
            total_bytes,
            &request_id,
            channel,
            &registry,
            &multipart_table,
            transfer_concurrency_per_part,
            &profile_id,
            &cancel_flag,
        )
        .await
    };

    // -----------------------------------------------------------------------
    // 5. Handle terminal state
    // -----------------------------------------------------------------------
    match &result {
        Ok(()) => {
            let finished_at = now_ms();
            {
                let mut reg = registry.0.write().await;
                let _ = reg.update(&request_id, |t| {
                    t.state = TransferState::Done;
                    t.finished_at = Some(finished_at);
                });
            }
            let _ = emit_state(channel, &request_id, TransferState::Done);

            // Emit objects:updated so the frontend invalidates its cache.
            let prefix = key
                .rfind('/')
                .map(|i| key[..=i].to_owned())
                .unwrap_or_default();
            let _ = crate::events::emit(
                channel,
                EventKind::ObjectsUpdated,
                ObjectsUpdatedPayload {
                    profile_id: profile_id.as_str().to_owned(),
                    bucket: bucket.as_str().to_owned(),
                    prefix,
                },
            );

            if let Ok(lock) = lock_registry.release(&lock_id) {
                let _ = crate::locks::emit_released(channel, &lock, ReleaseReason::Success);
            }

            // Fire in-app + OS notification for Done terminal state.
            if let Some(transfer) = registry.0.read().await.get(&request_id).cloned() {
                let _ = notify_terminal(&transfer, channel, &log, os_notifier).await;
            }
        }
        Err(AppError::Cancelled) => {
            let finished_at = now_ms();
            {
                let mut reg = registry.0.write().await;
                let _ = reg.update(&request_id, |t| {
                    t.state = TransferState::Canceled;
                    t.finished_at = Some(finished_at);
                });
            }
            let _ = emit_state(channel, &request_id, TransferState::Canceled);

            if let Ok(lock) = lock_registry.release(&lock_id) {
                let _ = crate::locks::emit_released(channel, &lock, ReleaseReason::Cancel);
            }

            // Fire in-app notification for Canceled (OS notification silenced
            // by notify_terminal — Canceled maps to Info severity).
            if let Some(transfer) = registry.0.read().await.get(&request_id).cloned() {
                let _ = notify_terminal(&transfer, channel, &log, os_notifier).await;
            }
        }
        Err(e) => {
            let finished_at = now_ms();
            {
                let mut reg = registry.0.write().await;
                let _ = reg.update(&request_id, |t| {
                    t.state = TransferState::Failed;
                    t.finished_at = Some(finished_at);
                    t.error = Some(e.clone());
                });
            }
            let _ =
                emit_state_with_error(channel, &request_id, TransferState::Failed, Some(e.clone()));

            if let Ok(lock) = lock_registry.release(&lock_id) {
                let _ = crate::locks::emit_released(channel, &lock, ReleaseReason::Failure);
            }

            // Fire in-app + OS notification for Failed terminal state.
            if let Some(transfer) = registry.0.read().await.get(&request_id).cloned() {
                let _ = notify_terminal(&transfer, channel, &log, os_notifier).await;
            }
        }
    }

    result
}

// ---------------------------------------------------------------------------
// single_part_upload
// ---------------------------------------------------------------------------

async fn single_part_upload<E: EventEmitter>(
    client: &Client,
    bucket: &BucketId,
    key: &str,
    source_path: &PathBuf,
    total_bytes: u64,
    request_id: &str,
    channel: &E,
    registry: &TransferRegistryHandle,
    cancel_flag: &AtomicBool,
) -> Result<(), AppError> {
    if cancel_flag.load(Ordering::Acquire) {
        return Err(AppError::Cancelled);
    }

    let file_bytes = tokio_fs::read(source_path)
        .await
        .map_err(|e| AppError::Network {
            source: format!("read source file failed: {e}"),
        })?;

    let body = ByteStream::from(file_bytes);

    client
        .put_object()
        .bucket(bucket.as_str())
        .key(key)
        .content_length(total_bytes as i64)
        .body(body)
        .send()
        .await
        .map_err(|e| AppError::Network {
            source: format!("put_object failed: {e}"),
        })?;

    // Emit a single progress event at 100%.
    let mut throttle = ProgressThrottle::new();
    let now = now_ms();
    let _ = emit_progress(
        channel,
        request_id,
        total_bytes,
        Some(total_bytes),
        0,
        0,
        &mut throttle,
        now,
    );

    // Update registry.
    {
        let mut reg = registry.0.write().await;
        let _ = reg.update(request_id, |t| {
            t.transferred_bytes = total_bytes;
        });
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// multipart_upload
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
async fn multipart_upload<E: EventEmitter>(
    client: &Client,
    bucket: &BucketId,
    key: &str,
    source_path: &PathBuf,
    total_bytes: u64,
    request_id: &str,
    channel: &E,
    registry: &TransferRegistryHandle,
    multipart_table: &MultipartTable,
    transfer_concurrency_per_part: u32,
    profile_id: &ProfileId,
    cancel_flag: &AtomicBool,
) -> Result<(), AppError> {
    // ------------------------------------------------------------------
    // a. create_multipart_upload
    // ------------------------------------------------------------------
    if cancel_flag.load(Ordering::Acquire) {
        return Err(AppError::Cancelled);
    }

    let create_resp = client
        .create_multipart_upload()
        .bucket(bucket.as_str())
        .key(key)
        .send()
        .await
        .map_err(|e| AppError::Network {
            source: format!("create_multipart_upload failed: {e}"),
        })?;

    let upload_id = create_resp
        .upload_id()
        .ok_or_else(|| AppError::Internal {
            trace_id: "create_multipart_upload returned no upload_id".to_owned(),
        })?
        .to_owned();

    // ------------------------------------------------------------------
    // b. Record in redb
    // ------------------------------------------------------------------
    let record = MultipartRecord {
        upload_id: upload_id.clone(),
        started_at: now_ms(),
        source: "brows3r".to_owned(),
        profile_id: profile_id.clone(),
        bucket: bucket.clone(),
        key: key.to_owned(),
    };
    multipart_table.record(&record)?;

    // ------------------------------------------------------------------
    // c. Compute part size: max(8 MB, total / 9999)
    // ------------------------------------------------------------------
    let part_size = std::cmp::max(MIN_PART_SIZE, (total_bytes + MAX_PARTS - 1) / MAX_PARTS);
    let parts_total = ((total_bytes + part_size - 1) / part_size) as u32;

    {
        let mut reg = registry.0.write().await;
        let _ = reg.update(request_id, |t| {
            t.parts_total = parts_total;
        });
    }

    // ------------------------------------------------------------------
    // d. Read file bytes for part dispatch
    // ------------------------------------------------------------------
    let file_bytes = tokio_fs::read(source_path)
        .await
        .map_err(|e| AppError::Network {
            source: format!("read source file failed: {e}"),
        })?;

    // Collect all part chunks eagerly (avoids borrow-across-await issues with
    // the chunk iterator later in the spawn loop).
    let part_chunks: Vec<(usize, Vec<u8>)> = file_bytes
        .chunks(part_size as usize)
        .enumerate()
        .map(|(i, c)| (i, c.to_vec()))
        .collect();
    // Drop the raw file bytes now that all chunks are owned.
    drop(file_bytes);

    let semaphore = Arc::new(Semaphore::new(transfer_concurrency_per_part as usize));
    let client_arc = Arc::new(client.clone());

    let mut part_tasks = Vec::new();

    for (i, chunk_data) in part_chunks {
        if cancel_flag.load(Ordering::Acquire) {
            // Abort and clean up.
            abort_multipart(client, bucket, key, &upload_id, multipart_table, profile_id).await;
            return Err(AppError::Cancelled);
        }

        let part_number = (i + 1) as i32;

        let permit = semaphore
            .clone()
            .acquire_owned()
            .await
            .expect("semaphore must not be closed");

        let client_clone = Arc::clone(&client_arc);
        let bucket_str = bucket.as_str().to_owned();
        let key_str = key.to_owned();
        let upload_id_clone = upload_id.clone();

        let task = tokio::spawn(async move {
            let _permit = permit; // held until task completes
            let body = ByteStream::from(chunk_data);
            let resp = client_clone
                .upload_part()
                .bucket(&bucket_str)
                .key(&key_str)
                .upload_id(&upload_id_clone)
                .part_number(part_number)
                .body(body)
                .send()
                .await
                .map_err(|e| AppError::Network {
                    source: format!("upload_part {part_number} failed: {e}"),
                })?;

            let etag = resp
                .e_tag()
                .ok_or_else(|| AppError::Internal {
                    trace_id: format!("upload_part {part_number} returned no ETag"),
                })?
                .to_owned();

            Ok::<(i32, String), AppError>((part_number, etag))
        });

        part_tasks.push(task);
    }

    // ------------------------------------------------------------------
    // Collect results
    // ------------------------------------------------------------------
    let mut completed_parts: Vec<(i32, String)> = Vec::with_capacity(part_tasks.len());
    let mut transferred_bytes: u64 = 0;
    let mut throttle = ProgressThrottle::new();

    for task in part_tasks {
        if cancel_flag.load(Ordering::Acquire) {
            abort_multipart(client, bucket, key, &upload_id, multipart_table, profile_id).await;
            return Err(AppError::Cancelled);
        }

        match task.await {
            Ok(Ok((part_number, etag))) => {
                completed_parts.push((part_number, etag));
                transferred_bytes += std::cmp::min(
                    part_size,
                    total_bytes.saturating_sub((part_number as u64 - 1) * part_size),
                );

                let parts_done = completed_parts.len() as u32;
                {
                    let mut reg = registry.0.write().await;
                    let _ = reg.update(request_id, |t| {
                        t.transferred_bytes = transferred_bytes;
                        t.parts_done = parts_done;
                    });
                }

                let now = now_ms();
                let _ = emit_progress(
                    channel,
                    request_id,
                    transferred_bytes,
                    Some(total_bytes),
                    parts_done,
                    parts_total,
                    &mut throttle,
                    now,
                );
            }
            Ok(Err(e)) => {
                abort_multipart(client, bucket, key, &upload_id, multipart_table, profile_id).await;
                return Err(e);
            }
            Err(join_err) => {
                abort_multipart(client, bucket, key, &upload_id, multipart_table, profile_id).await;
                return Err(AppError::Internal {
                    trace_id: format!("part task join failed: {join_err}"),
                });
            }
        }
    }

    // ------------------------------------------------------------------
    // e. complete_multipart_upload
    // ------------------------------------------------------------------
    completed_parts.sort_by_key(|(n, _)| *n);

    let completed = CompletedMultipartUpload::builder()
        .set_parts(Some(
            completed_parts
                .into_iter()
                .map(|(n, etag)| CompletedPart::builder().part_number(n).e_tag(etag).build())
                .collect(),
        ))
        .build();

    client
        .complete_multipart_upload()
        .bucket(bucket.as_str())
        .key(key)
        .upload_id(&upload_id)
        .multipart_upload(completed)
        .send()
        .await
        .map_err(|e| {
            // Best-effort abort on complete failure; errors are swallowed.
            let bucket_str = bucket.as_str().to_owned();
            let key_str = key.to_owned();
            let upload_id_str = upload_id.clone();
            let client_clone = Arc::clone(&client_arc);
            let _ = tokio::spawn(async move {
                let _ = client_clone
                    .abort_multipart_upload()
                    .bucket(&bucket_str)
                    .key(&key_str)
                    .upload_id(&upload_id_str)
                    .send()
                    .await;
            });
            AppError::Network {
                source: format!("complete_multipart_upload failed: {e}"),
            }
        })?;

    // Atomic: remove from multipart_active AFTER successful complete.
    let _ = multipart_table.remove(profile_id, bucket, key);

    Ok(())
}

// ---------------------------------------------------------------------------
// abort_multipart — best-effort cleanup on error/cancel
// ---------------------------------------------------------------------------

async fn abort_multipart(
    client: &Client,
    bucket: &BucketId,
    key: &str,
    upload_id: &str,
    multipart_table: &MultipartTable,
    profile_id: &ProfileId,
) {
    let _ = client
        .abort_multipart_upload()
        .bucket(bucket.as_str())
        .key(key)
        .upload_id(upload_id)
        .send()
        .await;

    // Remove from bookkeeping regardless of abort success.
    let _ = multipart_table.remove(profile_id, bucket, key);
}

// ---------------------------------------------------------------------------
// cleanup_on_error — emit Failed state + release lock
// ---------------------------------------------------------------------------

async fn cleanup_on_error<E, C>(
    request_id: &str,
    registry: &TransferRegistryHandle,
    lock_registry: &LockRegistry,
    lock_id: &LockId,
    channel: &E,
    error: AppError,
    log: &NotificationLogHandle,
    os_notifier: &crate::notifications::os::OsNotifier<C>,
) where
    E: EventEmitter,
    C: OsNotifyChannel,
{
    let finished_at = now_ms();
    let error_for_emit = error.clone();
    {
        let mut reg = registry.0.write().await;
        let _ = reg.update(request_id, |t| {
            t.state = TransferState::Failed;
            t.finished_at = Some(finished_at);
            t.error = Some(error);
        });
    }

    let _ = emit_state_with_error(
        channel,
        request_id,
        TransferState::Failed,
        Some(error_for_emit),
    );

    if let Ok(lock) = lock_registry.release(lock_id) {
        let _ = crate::locks::emit_released(channel, &lock, ReleaseReason::Failure);
    }

    // Fire in-app + OS notification for Failed terminal state.
    if let Some(transfer) = registry.0.read().await.get(request_id).cloned() {
        let _ = notify_terminal(&transfer, channel, log, os_notifier).await;
    }
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Part-size calculation — unit-testable without S3 or files
// ---------------------------------------------------------------------------

/// Compute the multipart part size for a given total file size.
///
/// Exported so unit tests can verify the calculation in isolation.
pub fn compute_part_size(total_bytes: u64) -> u64 {
    std::cmp::max(MIN_PART_SIZE, (total_bytes + MAX_PARTS - 1) / MAX_PARTS)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // Part-size calculation
    // -----------------------------------------------------------------------

    #[test]
    fn part_size_small_file_uses_minimum() {
        // 5 MB exactly → single-part threshold, but if we call compute_part_size
        // it should return the 8 MB minimum.
        assert_eq!(compute_part_size(5 * 1024 * 1024), MIN_PART_SIZE);
    }

    #[test]
    fn part_size_50mb_is_minimum() {
        // 50 MB / 9999 ≈ 5126 bytes — below 8 MB minimum.
        assert_eq!(compute_part_size(50 * 1024 * 1024), MIN_PART_SIZE);
    }

    #[test]
    fn part_size_500mb_is_minimum() {
        // 500 MB / 9999 ≈ 52 KB — below 8 MB minimum.
        assert_eq!(compute_part_size(500 * 1024 * 1024), MIN_PART_SIZE);
    }

    #[test]
    fn part_size_5gb_scales_above_minimum() {
        let total = 5u64 * 1024 * 1024 * 1024; // 5 GB
        let ps = compute_part_size(total);
        // 5 GB / 9999 ≈ 524 KB which is below 8 MB → still use minimum.
        assert_eq!(ps, MIN_PART_SIZE, "5 GB should still use 8 MB part size");
        // But verify parts would fit.
        let num_parts = (total + ps - 1) / ps;
        assert!(num_parts <= MAX_PARTS, "must not exceed 9999 parts");
    }

    #[test]
    fn part_size_huge_file_caps_below_10000_parts() {
        // 200 GB → 200*1024 MB. 200*1024/9999 ≈ 20.5 MB per part.
        let total = 200u64 * 1024 * 1024 * 1024;
        let ps = compute_part_size(total);
        let num_parts = (total + ps - 1) / ps;
        assert!(num_parts <= MAX_PARTS, "must not exceed 9999 parts");
        assert!(ps >= MIN_PART_SIZE, "part size must be at least 8 MB");
    }

    #[test]
    fn single_part_threshold_is_5mb() {
        assert_eq!(SINGLE_PART_THRESHOLD, 5 * 1024 * 1024);
    }

    // -----------------------------------------------------------------------
    // objects:updated prefix extraction
    // -----------------------------------------------------------------------

    #[test]
    fn prefix_extracted_correctly() {
        let key = "data/2024/file.bin";
        let prefix = key
            .rfind('/')
            .map(|i| key[..=i].to_owned())
            .unwrap_or_default();
        assert_eq!(prefix, "data/2024/");
    }

    #[test]
    fn prefix_for_root_key_is_empty() {
        let key = "rootfile.bin";
        let prefix = key
            .rfind('/')
            .map(|i| key[..=i].to_owned())
            .unwrap_or_default();
        assert_eq!(prefix, "");
    }
}
