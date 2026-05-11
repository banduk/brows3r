//! Tauri commands for the in-app notification log.
//!
//! # Commands
//!
//! - `notifications_list`   — return notifications, optionally filtered by timestamp.
//! - `notification_dismiss` — remove a notification from the log by id.

use tauri::State;

use crate::{
    error::AppError,
    notifications::{Notification, NotificationLogHandle},
};

/// Return all notifications stored in the log.
///
/// When `since` is provided only notifications with
/// `timestamp >= since` (unix milliseconds) are returned.
#[tauri::command]
pub async fn notifications_list(
    since: Option<i64>,
    log: State<'_, NotificationLogHandle>,
) -> Result<Vec<Notification>, AppError> {
    let guard = log.0.read().await;
    Ok(guard.list(since))
}

/// Dismiss (remove) a notification by its `id`.
///
/// Returns `true` when the notification was found and removed,
/// `false` when no notification with that id exists.
#[tauri::command]
pub async fn notification_dismiss(
    id: String,
    log: State<'_, NotificationLogHandle>,
) -> Result<bool, AppError> {
    let mut guard = log.0.write().await;
    Ok(guard.dismiss(&id))
}
