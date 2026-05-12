//! Tauri commands for reading and updating application settings.
//!
//! # Commands
//!
//! - `settings_get`    — return the current `Settings` snapshot.
//! - `settings_update` — apply a JSON patch, validate, persist atomically.
//!
//! Both commands take `tauri::State<SettingsHandle>` so they share the same
//! `Arc<Mutex<Settings>>` that was seeded at app start.
//!
//! ## Hot-reload
//!
//! `settings_update` also pushes runtime-affecting changes into the live
//! services:
//! - `proxy`               → `ClientPool::set_proxy` (rebuilds connectors).
//! - `transfer_concurrency`→ `TransferQueue::rebuild_semaphore`.
//!
//! Cache TTL changes still require an app restart — the cache stores them as
//! immutable config at open time.

use serde_json::Value;
use tauri::State;

use crate::{
    error::AppError,
    s3::S3ClientPoolHandle,
    settings::{validate_patch, Settings, SettingsHandle},
    transfers::TransferQueueHandle,
};

/// Return the current settings as a serialised `Settings` value.
///
/// The frontend can call this on startup to hydrate its settings state.
#[tauri::command]
pub async fn settings_get(handle: State<'_, SettingsHandle>) -> Result<Settings, AppError> {
    let settings = handle.inner.lock().await;
    Ok(settings.clone())
}

/// Apply a JSON patch to the current settings, validate, and persist.
///
/// `patch` is a partial JSON object; only the keys present in `patch` are
/// updated.  The merge strategy is a shallow JSON merge (RFC 7396 spirit):
/// top-level keys in `patch` overwrite the corresponding fields in the stored
/// settings.  Sub-structs are replaced wholesale when their key appears in
/// `patch` (standard `serde_json::Value` merge semantics).
///
/// Returns the updated `Settings` on success, or `AppError::Validation` if
/// the patch violates a constraint (e.g. `transferConcurrency = 0`).
///
/// Pass `force: true` to bypass shortcut-conflict checks (future use; ignored
/// in v1 but accepted so callers compiled against this signature do not need
/// updating).
#[tauri::command]
pub async fn settings_update(
    handle: State<'_, SettingsHandle>,
    pool: State<'_, S3ClientPoolHandle>,
    queue: State<'_, TransferQueueHandle>,
    patch: Value,
    #[allow(unused_variables)] force: Option<bool>,
) -> Result<Settings, AppError> {
    // Validate before acquiring the lock so we fail fast without blocking.
    validate_patch(&patch)?;

    let mut settings = handle.inner.lock().await;

    // Capture the pre-patch values so we only push side-effects when the
    // relevant fields actually changed.
    let prev_proxy = settings.proxy.clone();
    let prev_concurrency = settings.transfer_concurrency;

    // Merge the patch into the current settings via JSON round-trip.
    // Strategy: serialize current → merge patch → deserialize.
    let mut current_value =
        serde_json::to_value(settings.clone()).map_err(|e| AppError::Internal {
            trace_id: format!("settings_update_serialize: {e}"),
        })?;

    json_merge(&mut current_value, patch);

    let updated: Settings =
        serde_json::from_value(current_value).map_err(|e| AppError::Internal {
            trace_id: format!("settings_update_deserialize: {e}"),
        })?;

    // Persist atomically before updating in-memory state so a failed write
    // does not leave the in-memory state ahead of disk.
    updated.save(&handle.path).await?;

    *settings = updated.clone();
    // Drop the lock before touching the live services to avoid holding it
    // across their awaits.
    drop(settings);

    // ---------- hot-reload: proxy ----------
    if updated.proxy != prev_proxy {
        pool.inner.set_proxy(updated.proxy.clone().into()).await;
    }

    // ---------- hot-reload: transfer concurrency ----------
    if updated.transfer_concurrency != prev_concurrency {
        queue.0.rebuild_semaphore(updated.transfer_concurrency);
    }

    Ok(updated)
}

/// Recursive JSON merge (RFC 7396 spirit).
///
/// Keys from `patch` overwrite keys in `base`.  When both `base[key]` and
/// `patch[key]` are objects, the merge recurses.  Otherwise `patch[key]`
/// replaces `base[key]`.
fn json_merge(base: &mut Value, patch: Value) {
    match (base, patch) {
        (Value::Object(base_map), Value::Object(patch_map)) => {
            for (k, v) in patch_map {
                let entry = base_map.entry(k).or_insert(Value::Null);
                json_merge(entry, v);
            }
        }
        (base, patch) => {
            *base = patch;
        }
    }
}
