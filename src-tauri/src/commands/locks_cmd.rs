//! Tauri commands for the resource lock registry.
//!
//! # Commands
//!
//! - `locks_list`           — return active locks, optionally filtered by scope.
//! - `lock_release_stale`   — manual last-resort override to release a specific
//!                            lock by ID (e.g. for a stuck operation).

use tauri::State;

use crate::{
    error::AppError,
    ids::{BucketId, ObjectKey, ProfileId},
    locks::{LockId, LockRegistryHandle, LockScope, ResourceLock},
};

// ---------------------------------------------------------------------------
// LockScopeDto — IPC-friendly version of LockScope
// ---------------------------------------------------------------------------

/// IPC-friendly (camelCase) mirror of `LockScope` used as a command argument.
///
/// The frontend passes `{ profile, bucket?, prefix?, key? }` in camelCase;
/// this DTO converts to the domain type.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockScopeDto {
    pub profile: ProfileId,
    pub bucket: Option<BucketId>,
    pub prefix: Option<String>,
    pub key: Option<ObjectKey>,
}

impl From<LockScopeDto> for LockScope {
    fn from(dto: LockScopeDto) -> Self {
        LockScope {
            profile: dto.profile,
            bucket: dto.bucket,
            prefix: dto.prefix,
            key: dto.key,
        }
    }
}

// ---------------------------------------------------------------------------
// locks_list
// ---------------------------------------------------------------------------

/// Return all active locks, optionally filtered to those whose scope
/// intersects `scope`.
///
/// When `scope` is `None` every active lock is returned.
#[tauri::command]
pub async fn locks_list(
    scope: Option<LockScopeDto>,
    registry: State<'_, LockRegistryHandle>,
) -> Result<Vec<ResourceLock>, AppError> {
    let filter = scope.map(LockScope::from);
    Ok(registry.inner().list(filter.as_ref()))
}

// ---------------------------------------------------------------------------
// lock_release_stale
// ---------------------------------------------------------------------------

/// Manually release a specific lock by ID.
///
/// This is a last-resort override (e.g. to unstick a crashed operation).
/// The caller is responsible for understanding the consequences.
///
/// Returns `AppError::NotFound` if the lock does not exist.
#[tauri::command]
pub async fn lock_release_stale(
    lock_id: LockId,
    registry: State<'_, LockRegistryHandle>,
) -> Result<(), AppError> {
    // We discard the returned lock; the caller does not need the scope here.
    registry.inner().release(&lock_id)?;
    Ok(())
}
