//! Background lifecycle tasks for the lock registry.
//!
//! - `start_heartbeat_loop`: spawns a tokio task that scans for stale locks
//!   every `interval` and emits `lock:released { reason: ttl }` for each.
//!
//! # OCP contract
//!
//! The heartbeat loop is generic over `EventEmitter`, so any emitter (real
//! Tauri `AppHandle` or `MockChannel`) can be substituted without changing
//! this module.

use std::{sync::Arc, time::Duration};

use crate::events::EventEmitter;

use super::{emit_released, LockRegistry, LockRegistryHandle, ReleaseReason};

// ---------------------------------------------------------------------------
// start_heartbeat_loop
// ---------------------------------------------------------------------------

/// Spawn a tokio task that periodically scans for stale locks and releases them.
///
/// The task runs every `interval` until the process exits (there is no
/// cancellation token in v1; the task exits when the runtime shuts down).
///
/// For each stale lock `release_stale` is called and a `lock:released`
/// event with `reason: Ttl` is emitted via `channel`.
pub fn start_heartbeat_loop<E>(registry: Arc<LockRegistry>, interval: Duration, channel: Arc<E>)
where
    E: EventEmitter + Send + Sync + 'static,
{
    // Use Tauri's async runtime so this works whether or not the caller is
    // already inside a Tokio reactor (Tauri's setup callback is sync and
    // outside any reactor, but it owns its own runtime).
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        loop {
            ticker.tick().await;
            let now = current_unix_secs();
            let stale = registry.release_stale(now);
            for lock in &stale {
                // Best-effort: ignore emit errors in the background task.
                let _ = emit_released(channel.as_ref(), lock, ReleaseReason::Ttl);
            }
        }
    });
}

/// Convenience wrapper that accepts a `LockRegistryHandle` instead of a bare
/// `Arc<LockRegistry>`.
pub fn start_heartbeat_loop_handle<E>(
    handle: &LockRegistryHandle,
    interval: Duration,
    channel: Arc<E>,
) where
    E: EventEmitter + Send + Sync + 'static,
{
    start_heartbeat_loop(handle.0.clone(), interval, channel);
}

// ---------------------------------------------------------------------------
// current_unix_secs
// ---------------------------------------------------------------------------

/// Return current Unix timestamp in seconds.
///
/// Separated into a function so tests can substitute a mock clock by calling
/// registry methods directly with a controlled `now` value.
pub fn current_unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
