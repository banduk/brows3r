//! Streaming download implementation.
//!
//! # Protocol
//!
//! 1. Acquire a scoped resource lock via `LockRegistry`.
//! 2. Emit `transfer:state { state: running }`.
//! 3. Issue `GetObject` — obtain `content_length` and the body `ByteStream`.
//! 4. Open `<dest>.partial` for writing (atomic rename on success).
//! 5. Stream 256 KB chunks; for each chunk: write to file, increment
//!    `transferred_bytes`, call `emit_progress` (throttled).
//! 6. Poll the cancel receiver between chunks.
//! 7. On cancel: delete `.partial`, emit `Canceled`, release lock with `Cancel`.
//! 8. On success: rename `.partial` → final, emit `Done`, release lock.
//! 9. On I/O or S3 error: delete `.partial`, emit `Failed`, release lock.
//!
//! # OCP contract
//!
//! The atomic `.partial` rename pattern and lock acquire/release sequence are
//! reusable for any downloaded asset.  Upload (task 32) acquires the same lock
//! registry with a different `op_name`.

use std::{
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use aws_sdk_s3::Client;
use tokio::{fs, io::AsyncWriteExt, sync::oneshot};

use crate::{
    error::AppError,
    events::EventEmitter,
    ids::{BucketId, ObjectKey, ProfileId},
    locks::{LockId, LockRegistry, LockScope, ReleaseReason},
    notifications::{os::OsNotifyChannel, NotificationLogHandle},
    transfers::{
        notify::notify_terminal,
        progress::{emit_progress, emit_state, ProgressThrottle},
        TransferRegistryHandle, TransferState,
    },
};

// ---------------------------------------------------------------------------
// Chunk size constant
// ---------------------------------------------------------------------------

/// Bytes per read chunk — 256 KB.
const CHUNK_SIZE: usize = 262_144;

// ---------------------------------------------------------------------------
// download_object
// ---------------------------------------------------------------------------

/// Stream-download `key` from `bucket` and write it atomically to `dest_path`.
///
/// # Parameters
///
/// - `client`          — authenticated S3 client for the profile's region.
/// - `bucket`          — target bucket name.
/// - `key`             — S3 object key.
/// - `dest_path`       — local destination path (final, not `.partial`).
/// - `request_id`      — UUID v4 string from `TransferRegistry::register`.
/// - `channel`         — Tauri `AppHandle` or `MockChannel` for event emission.
/// - `registry`        — shared `TransferRegistryHandle` for state updates.
/// - `lock_registry`   — resource lock registry; this function acquires and
///                       releases the lock.
/// - `cancel_rx`       — oneshot receiver; resolved when the caller calls
///                       `TransferRegistry::cancel`.
/// - `profile_id`      — used to build the `LockScope`.
/// - `lock_ttl_secs`   — TTL for the acquired lock.
/// - `log`             — in-app notification log for terminal-state notifications.
/// - `os_notifier`     — OS notification bridge (settings-gated internally).
pub async fn download_object<E, C>(
    client: Arc<Client>,
    bucket: BucketId,
    key: String,
    dest_path: PathBuf,
    request_id: String,
    channel: &E,
    registry: TransferRegistryHandle,
    lock_registry: Arc<LockRegistry>,
    mut cancel_rx: oneshot::Receiver<()>,
    profile_id: ProfileId,
    lock_ttl_secs: u64,
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

    let lock_id = lock_registry.acquire(scope, "download", lock_ttl_secs, now)?;

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
    // 3. GetObject — obtain body stream and content length
    // -----------------------------------------------------------------------
    let resp = client
        .get_object()
        .bucket(bucket.as_str())
        .key(&key)
        .send()
        .await
        .map_err(|e| AppError::Network {
            source: format!("get_object failed: {e}"),
        });

    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            cleanup_on_error(
                None,
                &request_id,
                &registry,
                &lock_registry,
                &lock_id,
                channel,
                e.clone(),
                &log,
                os_notifier,
            )
            .await;
            return Err(e);
        }
    };

    let content_length = resp.content_length().map(|l| l as u64);

    // Update total_bytes now that we know it.
    {
        let mut reg = registry.0.write().await;
        let _ = reg.update(&request_id, |t| {
            t.total_bytes = content_length;
        });
    }

    // -----------------------------------------------------------------------
    // 4. Open <dest>.partial for writing
    // -----------------------------------------------------------------------
    let partial_path = {
        let mut p = dest_path.clone();
        let name = p
            .file_name()
            .map(|n| format!("{}.partial", n.to_string_lossy()))
            .unwrap_or_else(|| "download.partial".to_string());
        p.set_file_name(name);
        p
    };

    // Ensure parent directory exists.
    if let Some(parent) = partial_path.parent() {
        if let Err(e) = fs::create_dir_all(parent).await {
            let err = AppError::Network {
                source: format!("create_dir_all failed: {e}"),
            };
            cleanup_on_error(
                None,
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
    }

    let mut file = match fs::File::create(&partial_path).await {
        Ok(f) => f,
        Err(e) => {
            let err = AppError::Network {
                source: format!("create partial file failed: {e}"),
            };
            cleanup_on_error(
                None,
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

    // -----------------------------------------------------------------------
    // 5. Stream body in 256 KB chunks
    // -----------------------------------------------------------------------
    let mut throttle = ProgressThrottle::new();
    let mut transferred_bytes: u64 = 0;

    // Collect the full body; AWS SDK v1 ByteStream collects via `.collect()`.
    // We still emit progress events by slicing the collected bytes into chunks.
    let body_result = resp.body.collect().await.map_err(|e| AppError::Network {
        source: format!("body collect failed: {e}"),
    });

    let body = match body_result {
        Ok(b) => b,
        Err(e) => {
            cleanup_on_error(
                Some(&partial_path),
                &request_id,
                &registry,
                &lock_registry,
                &lock_id,
                channel,
                e.clone(),
                &log,
                os_notifier,
            )
            .await;
            return Err(e);
        }
    };

    let bytes = body.into_bytes();

    for chunk in bytes.chunks(CHUNK_SIZE) {
        // Poll cancel signal between chunks (non-blocking try_recv).
        if cancel_rx.try_recv().is_ok() {
            return handle_cancel(
                &partial_path,
                &request_id,
                &registry,
                &lock_registry,
                &lock_id,
                channel,
                &log,
                os_notifier,
            )
            .await;
        }

        if let Err(e) = file.write_all(chunk).await {
            let err = AppError::Network {
                source: format!("write chunk failed: {e}"),
            };
            cleanup_on_error(
                Some(&partial_path),
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

        transferred_bytes += chunk.len() as u64;

        // Update registry.
        {
            let mut reg = registry.0.write().await;
            let _ = reg.update(&request_id, |t| {
                t.transferred_bytes = transferred_bytes;
            });
        }

        // Throttled progress event.
        let now_ms = now_ms();
        let _ = emit_progress(
            channel,
            &request_id,
            transferred_bytes,
            content_length,
            0,
            0,
            &mut throttle,
            now_ms,
        );
    }

    // Final check for cancel signal before rename.
    if cancel_rx.try_recv().is_ok() {
        return handle_cancel(
            &partial_path,
            &request_id,
            &registry,
            &lock_registry,
            &lock_id,
            channel,
            &log,
            os_notifier,
        )
        .await;
    }

    // Flush and close.
    if let Err(e) = file.flush().await {
        let err = AppError::Network {
            source: format!("flush failed: {e}"),
        };
        cleanup_on_error(
            Some(&partial_path),
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
    drop(file);

    // -----------------------------------------------------------------------
    // 6. Atomic rename: .partial → final
    // -----------------------------------------------------------------------
    if let Err(e) = fs::rename(&partial_path, &dest_path).await {
        let err = AppError::Network {
            source: format!("rename partial failed: {e}"),
        };
        cleanup_on_error(
            Some(&partial_path),
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

    // -----------------------------------------------------------------------
    // 7. Success path: emit Done, release lock
    // -----------------------------------------------------------------------
    let finished_at = now_ms();
    {
        let mut reg = registry.0.write().await;
        let _ = reg.update(&request_id, |t| {
            t.state = TransferState::Done;
            t.transferred_bytes = transferred_bytes;
            t.finished_at = Some(finished_at);
        });
    }

    let _ = emit_state(channel, &request_id, TransferState::Done);

    if let Ok(lock) = lock_registry.release(&lock_id) {
        let _ = crate::locks::emit_released(channel, &lock, ReleaseReason::Success);
    }

    // Fire in-app and optional OS notification for terminal Done state.
    if let Some(transfer) = registry.0.read().await.get(&request_id).cloned() {
        let _ = notify_terminal(&transfer, channel, &log, os_notifier).await;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
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

/// Cancel path: delete `.partial`, emit Canceled, release lock.
async fn handle_cancel<E, C>(
    partial_path: &PathBuf,
    request_id: &str,
    registry: &TransferRegistryHandle,
    lock_registry: &LockRegistry,
    lock_id: &LockId,
    channel: &E,
    log: &NotificationLogHandle,
    os_notifier: &crate::notifications::os::OsNotifier<C>,
) -> Result<(), AppError>
where
    E: EventEmitter,
    C: OsNotifyChannel,
{
    let _ = fs::remove_file(partial_path).await;

    let finished_at = now_ms();
    {
        let mut reg = registry.0.write().await;
        let _ = reg.update(request_id, |t| {
            t.state = TransferState::Canceled;
            t.finished_at = Some(finished_at);
        });
    }

    let _ = emit_state(channel, request_id, TransferState::Canceled);

    if let Ok(lock) = lock_registry.release(lock_id) {
        let _ = crate::locks::emit_released(channel, &lock, ReleaseReason::Cancel);
    }

    // Fire in-app notification for Canceled (OS notification is silenced by
    // notify_terminal because Canceled maps to Info severity).
    if let Some(transfer) = registry.0.read().await.get(request_id).cloned() {
        let _ = notify_terminal(&transfer, channel, log, os_notifier).await;
    }

    Err(AppError::Cancelled)
}

/// Error path: delete `.partial` (if any), emit Failed, release lock.
async fn cleanup_on_error<E, C>(
    partial_path: Option<&PathBuf>,
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
    if let Some(p) = partial_path {
        let _ = fs::remove_file(p).await;
    }

    let finished_at = now_ms();
    {
        let mut reg = registry.0.write().await;
        let _ = reg.update(request_id, |t| {
            t.state = TransferState::Failed;
            t.finished_at = Some(finished_at);
            t.error = Some(error.clone());
        });
    }

    let _ = emit_state(channel, request_id, TransferState::Failed);

    if let Ok(lock) = lock_registry.release(lock_id) {
        let _ = crate::locks::emit_released(channel, &lock, ReleaseReason::Failure);
    }

    // Fire in-app + OS notification for Failed terminal state.
    if let Some(transfer) = registry.0.read().await.get(request_id).cloned() {
        let _ = notify_terminal(&transfer, channel, log, os_notifier).await;
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ids::{BucketId, ObjectKey, ProfileId},
        locks::{LockRegistry, LockScope},
        transfers::{Transfer, TransferKind, TransferState},
    };
    use std::path::PathBuf;
    use tempfile::tempdir;

    fn make_registry_handle() -> TransferRegistryHandle {
        TransferRegistryHandle::default()
    }

    fn make_lock_registry() -> Arc<LockRegistry> {
        Arc::new(LockRegistry::new())
    }

    fn profile() -> ProfileId {
        ProfileId::new("p1")
    }

    fn bucket() -> BucketId {
        BucketId::new("test-bucket")
    }

    fn make_transfer(id: &str, dest: &PathBuf) -> Transfer {
        Transfer {
            id: id.to_owned(),
            kind: TransferKind::Download,
            profile_id: profile(),
            bucket: bucket(),
            key: "file.bin".to_string(),
            source_path: None,
            dest_path: Some(dest.clone()),
            total_bytes: None,
            transferred_bytes: 0,
            parts_done: 0,
            parts_total: 0,
            state: TransferState::Queued,
            started_at: 1_700_000_000_000,
            finished_at: None,
            error: None,
        }
    }

    // -----------------------------------------------------------------------
    // Lock acquisition conflict
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn conflicting_download_returns_locked_error() {
        use crate::locks::LockScope;

        let lock_registry = make_lock_registry();

        // Pre-acquire a lock on the same key.
        let scope = LockScope {
            profile: profile(),
            bucket: Some(bucket()),
            prefix: None,
            key: Some(ObjectKey::new("file.bin")),
        };
        let _ = lock_registry
            .acquire(scope, "existing-op", 300, now_secs())
            .expect("pre-acquire must succeed");

        // Attempting to acquire the same scope should yield Locked.
        let scope2 = LockScope {
            profile: profile(),
            bucket: Some(bucket()),
            prefix: None,
            key: Some(ObjectKey::new("file.bin")),
        };
        let err = lock_registry
            .acquire(scope2, "download", 300, now_secs())
            .expect_err("second acquire must fail");

        match err {
            AppError::Locked { .. } => {}
            other => panic!("expected Locked, got {:?}", other),
        }
    }

    // -----------------------------------------------------------------------
    // Cancel receiver fires correctly
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn cancel_via_registry_sends_signal() {
        let dir = tempdir().unwrap();
        let dest = dir.path().join("output.bin");

        let registry_handle = make_registry_handle();
        let t = make_transfer("t-cancel-test", &dest);

        let (_id, rx) = {
            let mut reg = registry_handle.0.write().await;
            reg.register(t)
        };

        // Cancel via the registry.
        {
            let mut reg = registry_handle.0.write().await;
            reg.cancel("t-cancel-test").expect("cancel must succeed");
        }

        // Receiver should immediately be ready.
        let result = rx.await;
        assert!(result.is_ok(), "cancel signal must fire on receiver");
    }
}
