//! Tauri commands for transfer operations.
//!
//! # Commands
//!
//! - [`transfer_download`]       — register a download, spawn the stream task, return
//!                                 the `request_id` immediately so the frontend can
//!                                 subscribe to `transfer:progress` and `transfer:state`.
//! - [`transfer_upload`]         — register an upload, spawn the upload task, return
//!                                 the `request_id` immediately.
//! - [`transfer_list`]           — list transfers filtered by state.
//! - [`transfer_cancel`]         — cancel an in-flight transfer.
//! - [`transfer_retry`]          — re-enqueue a failed/canceled transfer from start.
//! - [`transfer_upload_many`]    — bulk-enqueue multiple uploads.
//! - [`transfer_download_many`]  — bulk-enqueue multiple downloads.
//!
//! # OCP contract
//!
//! Upload/download are independent command paths.  `transfer_list` and
//! `transfer_cancel` compose over `TransferQueueHandle` without touching either.
//! Adding a new transfer kind (`Move`, `Copy`) = new `TransferSpec` variant +
//! one new command here.

use std::{
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc},
};

use tauri::{AppHandle, State};

use crate::{
    error::AppError,
    ids::{BucketId, ProfileId},
    locks::LockRegistryHandle,
    notifications::{
        os::{AppHandleChannel, OsNotifier},
        NotificationLogHandle,
    },
    profiles::ProfileStoreHandle,
    s3::{
        multipart::{
            abort_multipart_upload, scan_multipart_uploads, MultipartSource, MultipartTableHandle,
            MultipartUpload,
        },
        S3ClientPoolHandle,
    },
    settings::SettingsHandle,
    transfers::{
        download::download_object, new_transfer_id, upload::upload_object, Transfer,
        TransferFilter, TransferKind, TransferQueueHandle, TransferState,
    },
};

// ---------------------------------------------------------------------------
// DTO types for bulk-enqueue commands
// ---------------------------------------------------------------------------

/// Input for a single upload spec (used by `transfer_upload_many`).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferUploadSpec {
    pub profile_id: ProfileId,
    pub bucket: BucketId,
    pub key: String,
    pub source_path: String,
}

/// Input for a single download spec (used by `transfer_download_many`).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferDownloadSpec {
    pub profile_id: ProfileId,
    pub bucket: BucketId,
    pub key: String,
    pub dest_path: String,
}

// ---------------------------------------------------------------------------
// Internal enqueue helpers (no State<> — safe to call from retry)
// ---------------------------------------------------------------------------

/// Register and spawn a download task.  Returns the new `request_id`.
async fn enqueue_download(
    profile_id: ProfileId,
    bucket: BucketId,
    key: String,
    dest_path: PathBuf,
    queue: &TransferQueueHandle,
    client: Arc<aws_sdk_s3::Client>,
    lock_registry: Arc<crate::locks::LockRegistry>,
    log: NotificationLogHandle,
    settings: SettingsHandle,
    channel: AppHandle,
) -> Result<String, AppError> {
    let request_id = new_transfer_id();
    let now_ms = now_ms();

    let transfer = Transfer {
        id: request_id.clone(),
        kind: TransferKind::Download,
        profile_id: profile_id.clone(),
        bucket: bucket.clone(),
        key: key.clone(),
        source_path: None,
        dest_path: Some(dest_path.clone()),
        total_bytes: None,
        transferred_bytes: 0,
        parts_done: 0,
        parts_total: 0,
        state: TransferState::Queued,
        started_at: now_ms,
        finished_at: None,
        error: None,
    };

    let cancel_rx = {
        let mut reg = queue.0.registry().write().await;
        let (id, rx) = reg.register(transfer);
        assert_eq!(id, request_id);
        rx
    };

    let registry_handle = queue.0.registry_handle();
    let request_id_clone = request_id.clone();
    let sem = queue.0.current_semaphore();

    const LOCK_TTL_SECS: u64 = 300;

    tokio::spawn(async move {
        let _permit = sem
            .acquire_owned()
            .await
            .expect("semaphore must not be closed");

        let os_notifier = OsNotifier::new(
            AppHandleChannel {
                app: channel.clone(),
            },
            settings,
        );

        let id_for_err = request_id_clone.clone();
        let result = download_object(
            client,
            bucket,
            key,
            dest_path,
            request_id_clone,
            &channel,
            registry_handle.clone(),
            lock_registry,
            cancel_rx,
            profile_id,
            LOCK_TTL_SECS,
            log,
            &os_notifier,
        )
        .await;

        // download_object emits its own Failed state events on internal
        // errors, but a non-emitting failure (lock acquisition, early
        // setup, panic-equivalent) used to vanish silently. Persist the
        // AppError on the Transfer record so TransferRow can render the
        // reason instead of just a red badge.
        if let Err(err) = result {
            eprintln!("download task {id_for_err} failed: {err:?}");
            let mut reg = registry_handle.0.write().await;
            let _ = reg.update(&id_for_err, |t| {
                t.error = Some(err);
                if t.state != TransferState::Failed {
                    t.state = TransferState::Failed;
                }
            });
        }
    });

    Ok(request_id)
}

/// Register and spawn an upload task.  Returns the new `request_id`.
#[allow(clippy::too_many_arguments)]
async fn enqueue_upload(
    profile_id: ProfileId,
    bucket: BucketId,
    key: String,
    source_path: PathBuf,
    queue: &TransferQueueHandle,
    client: Arc<aws_sdk_s3::Client>,
    lock_registry: Arc<crate::locks::LockRegistry>,
    multipart_table: Arc<crate::s3::multipart::MultipartTable>,
    log: NotificationLogHandle,
    settings: SettingsHandle,
    channel: AppHandle,
) -> Result<String, AppError> {
    let request_id = new_transfer_id();
    let now_ms = now_ms();

    let transfer = Transfer {
        id: request_id.clone(),
        kind: TransferKind::Upload,
        profile_id: profile_id.clone(),
        bucket: bucket.clone(),
        key: key.clone(),
        source_path: Some(source_path.clone()),
        dest_path: None,
        total_bytes: None,
        transferred_bytes: 0,
        parts_done: 0,
        parts_total: 0,
        state: TransferState::Queued,
        started_at: now_ms,
        finished_at: None,
        error: None,
    };

    let cancel_flag = Arc::new(AtomicBool::new(false));

    {
        let mut reg = queue.0.registry().write().await;
        let (id, _rx) = reg.register(transfer);
        assert_eq!(id, request_id);
    }

    let registry_handle = queue.0.registry_handle();
    let request_id_clone = request_id.clone();
    let sem = queue.0.current_semaphore();

    const LOCK_TTL_SECS: u64 = 300;
    const PARTS_CONCURRENCY: u32 = 4;

    tokio::spawn(async move {
        let _permit = sem
            .acquire_owned()
            .await
            .expect("semaphore must not be closed");

        let os_notifier = OsNotifier::new(
            AppHandleChannel {
                app: channel.clone(),
            },
            settings,
        );

        let id_for_err = request_id_clone.clone();
        let result = upload_object(
            client,
            bucket,
            key,
            source_path,
            request_id_clone,
            &channel,
            registry_handle.clone(),
            lock_registry,
            multipart_table,
            PARTS_CONCURRENCY,
            profile_id,
            LOCK_TTL_SECS,
            cancel_flag,
            log,
            &os_notifier,
        )
        .await;

        // upload_object emits its own Failed state events on internal
        // errors, but non-emitting failures used to vanish. Persist the
        // AppError on the Transfer record so TransferRow can render it.
        if let Err(err) = result {
            eprintln!("upload task {id_for_err} failed: {err:?}");
            let mut reg = registry_handle.0.write().await;
            let _ = reg.update(&id_for_err, |t| {
                t.error = Some(err);
                if t.state != TransferState::Failed {
                    t.state = TransferState::Failed;
                }
            });
        }
    });

    Ok(request_id)
}

// ---------------------------------------------------------------------------
// transfer_download
// ---------------------------------------------------------------------------

/// Initiate a streaming download of `key` from `bucket` to `dest_path`.
///
/// Returns the `request_id` (UUID v4) immediately.
#[tauri::command]
pub async fn transfer_download(
    profile_id: ProfileId,
    bucket: BucketId,
    key: String,
    dest_path: String,
    queue: State<'_, TransferQueueHandle>,
    pool: State<'_, S3ClientPoolHandle>,
    locks: State<'_, LockRegistryHandle>,
    store: State<'_, ProfileStoreHandle>,
    log: State<'_, NotificationLogHandle>,
    settings: State<'_, SettingsHandle>,
    channel: AppHandle,
) -> Result<String, AppError> {
    let (client, profile_id_resolved) = resolve_client(&profile_id, &store, &pool).await?;
    let lock_registry = Arc::clone(&locks.0);
    enqueue_download(
        profile_id_resolved,
        bucket,
        key,
        PathBuf::from(dest_path),
        &queue,
        client,
        lock_registry,
        (*log).clone(),
        (*settings).clone(),
        channel,
    )
    .await
}

// ---------------------------------------------------------------------------
// transfer_upload
// ---------------------------------------------------------------------------

/// Initiate an upload of `source_path` to `bucket/key`.
///
/// Returns the `request_id` (UUID v4) immediately.
#[tauri::command]
pub async fn transfer_upload(
    profile_id: ProfileId,
    bucket: BucketId,
    key: String,
    source_path: String,
    queue: State<'_, TransferQueueHandle>,
    pool: State<'_, S3ClientPoolHandle>,
    locks: State<'_, LockRegistryHandle>,
    store: State<'_, ProfileStoreHandle>,
    multipart_table: State<'_, MultipartTableHandle>,
    log: State<'_, NotificationLogHandle>,
    settings: State<'_, SettingsHandle>,
    channel: AppHandle,
) -> Result<String, AppError> {
    let (client, profile_id_resolved) = resolve_client(&profile_id, &store, &pool).await?;
    let lock_registry = Arc::clone(&locks.0);
    let multipart_arc = Arc::new(multipart_table.0.clone());
    enqueue_upload(
        profile_id_resolved,
        bucket,
        key,
        PathBuf::from(source_path),
        &queue,
        client,
        lock_registry,
        multipart_arc,
        (*log).clone(),
        (*settings).clone(),
        channel,
    )
    .await
}

// ---------------------------------------------------------------------------
// transfer_list
// ---------------------------------------------------------------------------

/// List transfers, optionally filtered by state.
///
/// `filter` accepts `null` (→ All), `"active"`, `"completed"`, `"failed"`.
#[tauri::command]
pub async fn transfer_list(
    filter: Option<TransferFilter>,
    queue: State<'_, TransferQueueHandle>,
) -> Result<Vec<Transfer>, AppError> {
    Ok(queue.0.list(filter).await)
}

// ---------------------------------------------------------------------------
// transfer_cancel
// ---------------------------------------------------------------------------

/// Cancel the in-flight transfer with `request_id`.
///
/// Idempotent: canceling an already-terminal transfer returns `Ok(())`.
#[tauri::command]
pub async fn transfer_cancel(
    request_id: String,
    queue: State<'_, TransferQueueHandle>,
) -> Result<(), AppError> {
    queue.0.cancel(&request_id).await
}

// ---------------------------------------------------------------------------
// transfer_retry
// ---------------------------------------------------------------------------

/// Re-enqueue a failed or canceled transfer from the beginning.
///
/// The original transfer record is not mutated.  A fresh request_id is
/// returned.  This satisfies AC-14: "the transfer restarts from the beginning
/// (not resumable in v1)".
#[tauri::command]
pub async fn transfer_retry(
    request_id: String,
    queue: State<'_, TransferQueueHandle>,
    pool: State<'_, S3ClientPoolHandle>,
    locks: State<'_, LockRegistryHandle>,
    store: State<'_, ProfileStoreHandle>,
    multipart_table: State<'_, MultipartTableHandle>,
    log: State<'_, NotificationLogHandle>,
    settings: State<'_, SettingsHandle>,
    channel: AppHandle,
) -> Result<String, AppError> {
    // Read the original transfer.
    let original = {
        let reg = queue.0.registry().read().await;
        reg.get(&request_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound {
                resource: format!("transfer:{request_id}"),
            })?
    };

    // Only allow retry of terminal states.
    match original.state {
        TransferState::Failed | TransferState::Canceled => {}
        _ => {
            return Err(AppError::Validation {
                field: "state".to_string(),
                hint: "retry is only valid for failed or canceled transfers".to_string(),
            });
        }
    }

    let (client, profile_id_resolved) = resolve_client(&original.profile_id, &store, &pool).await?;
    let lock_registry = Arc::clone(&locks.0);

    match original.kind {
        TransferKind::Download => {
            let dest_path = original
                .dest_path
                .clone()
                .ok_or_else(|| AppError::Internal {
                    trace_id: format!("retry:{request_id}:missing_dest_path"),
                })?;
            enqueue_download(
                profile_id_resolved,
                original.bucket,
                original.key,
                dest_path,
                &queue,
                client,
                lock_registry,
                (*log).clone(),
                (*settings).clone(),
                channel,
            )
            .await
        }
        TransferKind::Upload => {
            let source_path = original
                .source_path
                .clone()
                .ok_or_else(|| AppError::Internal {
                    trace_id: format!("retry:{request_id}:missing_source_path"),
                })?;
            let multipart_arc = Arc::new(multipart_table.0.clone());
            enqueue_upload(
                profile_id_resolved,
                original.bucket,
                original.key,
                source_path,
                &queue,
                client,
                lock_registry,
                multipart_arc,
                (*log).clone(),
                (*settings).clone(),
                channel,
            )
            .await
        }
    }
}

// ---------------------------------------------------------------------------
// transfer_upload_many
// ---------------------------------------------------------------------------

/// Bulk-enqueue multiple uploads.
///
/// Returns a `Vec<String>` of request IDs in the same order as `specs`.
#[tauri::command]
pub async fn transfer_upload_many(
    specs: Vec<TransferUploadSpec>,
    queue: State<'_, TransferQueueHandle>,
    pool: State<'_, S3ClientPoolHandle>,
    locks: State<'_, LockRegistryHandle>,
    store: State<'_, ProfileStoreHandle>,
    multipart_table: State<'_, MultipartTableHandle>,
    log: State<'_, NotificationLogHandle>,
    settings: State<'_, SettingsHandle>,
    channel: AppHandle,
) -> Result<Vec<String>, AppError> {
    // Fail-fast on the first spec that cannot be enqueued. Previously this
    // used `.unwrap_or_default()` which silently pushed an empty string for
    // each failed spec — the frontend has no caller that distinguishes an
    // empty id from a real one, so per-item failures were invisible. The
    // user-visible payoff: a bad spec now surfaces in the toolbar's
    // `surfaceUnknownError` instead of looking like "upload started" with
    // nothing actually happening.
    let mut ids = Vec::with_capacity(specs.len());
    for spec in specs {
        let (client, profile_id_resolved) = resolve_client(&spec.profile_id, &store, &pool).await?;
        let lock_registry = Arc::clone(&locks.0);
        let multipart_arc = Arc::new(multipart_table.0.clone());
        let id = enqueue_upload(
            profile_id_resolved,
            spec.bucket,
            spec.key,
            PathBuf::from(spec.source_path),
            &queue,
            client,
            lock_registry,
            multipart_arc,
            (*log).clone(),
            (*settings).clone(),
            channel.clone(),
        )
        .await?;
        ids.push(id);
    }
    Ok(ids)
}

// ---------------------------------------------------------------------------
// transfer_download_many
// ---------------------------------------------------------------------------

/// Bulk-enqueue multiple downloads.
///
/// Returns a `Vec<String>` of request IDs in the same order as `specs`.
#[tauri::command]
pub async fn transfer_download_many(
    specs: Vec<TransferDownloadSpec>,
    queue: State<'_, TransferQueueHandle>,
    pool: State<'_, S3ClientPoolHandle>,
    locks: State<'_, LockRegistryHandle>,
    store: State<'_, ProfileStoreHandle>,
    log: State<'_, NotificationLogHandle>,
    settings: State<'_, SettingsHandle>,
    channel: AppHandle,
) -> Result<Vec<String>, AppError> {
    // Fail-fast on the first spec that cannot be enqueued. See
    // `transfer_upload_many` for the full rationale — same change.
    let mut ids = Vec::with_capacity(specs.len());
    for spec in specs {
        let (client, profile_id_resolved) = resolve_client(&spec.profile_id, &store, &pool).await?;
        let lock_registry = Arc::clone(&locks.0);
        let id = enqueue_download(
            profile_id_resolved,
            spec.bucket,
            spec.key,
            PathBuf::from(spec.dest_path),
            &queue,
            client,
            lock_registry,
            (*log).clone(),
            (*settings).clone(),
            channel.clone(),
        )
        .await?;
        ids.push(id);
    }
    Ok(ids)
}

// ---------------------------------------------------------------------------
// multipart_scan
// ---------------------------------------------------------------------------

/// List all in-progress multipart uploads for `bucket`, classifying each as
/// `Brows3r` (in our `multipart_active` table) or `Unknown` (foreign).
///
/// Optionally filter out uploads younger than `older_than_secs` seconds.
///
/// Satisfies AC-4 cleanup scanner requirement.
#[tauri::command]
pub async fn multipart_scan(
    profile_id: ProfileId,
    bucket: BucketId,
    older_than_secs: Option<u64>,
    store: State<'_, ProfileStoreHandle>,
    pool: State<'_, S3ClientPoolHandle>,
    multipart_table: State<'_, MultipartTableHandle>,
) -> Result<Vec<MultipartUpload>, AppError> {
    let (client, _) = resolve_client(&profile_id, &store, &pool).await?;
    scan_multipart_uploads(&client, &bucket, &multipart_table.0, older_than_secs).await
}

// ---------------------------------------------------------------------------
// multipart_abort
// ---------------------------------------------------------------------------

/// Abort a single in-progress multipart upload.
///
/// If `source == Unknown` and `confirmed_unknown` is not `true`, returns a
/// `Validation` error so the frontend must obtain explicit user consent before
/// aborting a foreign upload.
///
/// On success with a `Brows3r`-sourced upload the record is removed from the
/// `multipart_active` table.
#[tauri::command]
pub async fn multipart_abort(
    profile_id: ProfileId,
    bucket: BucketId,
    upload_id: String,
    key: String,
    source: MultipartSource,
    confirmed_unknown: Option<bool>,
    store: State<'_, ProfileStoreHandle>,
    pool: State<'_, S3ClientPoolHandle>,
    multipart_table: State<'_, MultipartTableHandle>,
) -> Result<(), AppError> {
    let (client, profile_id_resolved) = resolve_client(&profile_id, &store, &pool).await?;
    abort_multipart_upload(
        &client,
        &bucket,
        &key,
        &upload_id,
        source,
        &multipart_table.0,
        &profile_id_resolved,
        confirmed_unknown.unwrap_or(false),
    )
    .await
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Resolve the S3 client for a profile, enforcing the validation gate.
async fn resolve_client(
    profile_id: &ProfileId,
    store: &State<'_, ProfileStoreHandle>,
    pool: &State<'_, S3ClientPoolHandle>,
) -> Result<(Arc<aws_sdk_s3::Client>, ProfileId), AppError> {
    let profile = {
        let store_guard = store.inner.lock().await;
        store_guard
            .get(profile_id)
            .ok_or_else(|| AppError::NotFound {
                resource: format!("profile:{}", profile_id.as_str()),
            })?
    };

    if profile.validated_at.is_none() {
        return Err(AppError::Auth {
            reason: "profile_not_validated_in_session".to_string(),
        });
    }

    let default_region = profile
        .default_region
        .clone()
        .unwrap_or_else(|| "us-east-1".to_string());

    let client = pool
        .inner
        .get_or_build(profile_id, &default_region)
        .await
        .ok_or_else(|| AppError::Internal {
            trace_id: format!("pool_miss:profile:{}", profile_id.as_str()),
        })?;

    Ok((client, profile_id.clone()))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    // Test-only types — production paths construct transfers via the queue's
    // typed `enqueue_*` helpers, so these aren't reached at runtime.
    use crate::transfers::TransferSpec;

    // The Tauri command itself is hard to unit-test without a running app;
    // integration testing is in the integration test file.  Here we just
    // verify that the TransferQueueHandle default construction works.

    #[test]
    fn transfer_queue_handle_default_is_empty() {
        let handle = TransferQueueHandle::default();
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let transfers = handle.0.list(None).await;
            assert_eq!(transfers.len(), 0, "fresh queue must be empty");
        });
    }

    // -----------------------------------------------------------------------
    // TransferFilter serialization
    // -----------------------------------------------------------------------

    #[test]
    fn transfer_filter_serializes_snake_case() {
        let cases = [
            (TransferFilter::Active, "active"),
            (TransferFilter::Completed, "completed"),
            (TransferFilter::Failed, "failed"),
            (TransferFilter::All, "all"),
        ];
        for (filter, expected) in &cases {
            let v = serde_json::to_value(filter).expect("must serialize");
            assert_eq!(v.as_str().unwrap(), *expected, "filter {:?}", filter);
        }
    }

    // -----------------------------------------------------------------------
    // TransferSpec serialization
    // -----------------------------------------------------------------------

    #[test]
    fn transfer_spec_upload_serializes() {
        let spec = TransferSpec::Upload {
            profile: ProfileId::new("my-profile"),
            bucket: BucketId::new("my-bucket"),
            key: "data/file.txt".to_string(),
            source_path: PathBuf::from("/local/file.txt"),
        };
        let v = serde_json::to_value(&spec).expect("must serialize");
        assert_eq!(v["kind"], "upload");
        assert_eq!(v["key"], "data/file.txt");
    }

    #[test]
    fn transfer_spec_download_serializes() {
        let spec = TransferSpec::Download {
            profile: ProfileId::new("my-profile"),
            bucket: BucketId::new("my-bucket"),
            key: "data/file.txt".to_string(),
            dest_path: PathBuf::from("/tmp/file.txt"),
        };
        let v = serde_json::to_value(&spec).expect("must serialize");
        assert_eq!(v["kind"], "download");
    }

    // -----------------------------------------------------------------------
    // Retry: requires Failed or Canceled state
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn transfer_retry_rejects_non_terminal_state() {
        let queue = TransferQueueHandle::default();
        let request_id = new_transfer_id();
        let transfer = Transfer {
            id: request_id.clone(),
            kind: TransferKind::Download,
            profile_id: ProfileId::new("p1"),
            bucket: BucketId::new("bucket"),
            key: "key".to_string(),
            source_path: None,
            dest_path: Some(PathBuf::from("/tmp/out")),
            total_bytes: None,
            transferred_bytes: 0,
            parts_done: 0,
            parts_total: 0,
            state: TransferState::Running,
            started_at: 0,
            finished_at: None,
            error: None,
        };
        {
            let mut reg = queue.0.registry().write().await;
            reg.register(transfer);
        }

        // We cannot call transfer_retry (needs State<>), so we test the
        // state guard logic directly.
        let reg = queue.0.registry().read().await;
        let t = reg.get(&request_id).unwrap();
        let is_retriable = t.state == TransferState::Failed || t.state == TransferState::Canceled;
        assert!(!is_retriable, "Running state must not be retriable");
    }
}
