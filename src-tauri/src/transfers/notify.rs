//! Terminal-state notification helper for transfers.
//!
//! # Single notification surface
//!
//! `notify_terminal` is the **only** place in the codebase that pushes an
//! in-app notification and conditionally fires an OS notification for a
//! transfer that has reached a terminal state.
//!
//! Adding new notification rules (e.g. "errors only", "grouped by bucket") is
//! one branch here — no other call site changes.
//!
//! # Gating (round-1 finding #4)
//!
//! OS notifications fire only when:
//!   1. `settings.notifications.os_enabled == true`
//!   2. `transfer.state` is `Done` or `Failed` (not `Canceled` — user-initiated
//!      cancellations are silent at the OS level).
//!   3. The `OsNotifier::maybe_send` internal gates also pass (non-Info severity
//!      + `terminal = true`).
//!
//! # OCP
//!
//! - `notify_terminal` is generic over any `EventEmitter` and any
//!   `OsNotifyChannel`, so it works identically in tests and production.

use std::time::{SystemTime, UNIX_EPOCH};

use crate::{
    error::AppError,
    events::EventEmitter,
    ids::BucketId,
    notifications::os::{OsNotifier, OsNotifyChannel},
    notifications::{Notification, NotificationCategory, NotificationLogHandle, Severity},
    transfers::{Transfer, TransferState},
};

/// Push an in-app notification for a terminal-state transfer, and optionally
/// fire an OS notification based on the current settings.
///
/// # Parameters
///
/// - `transfer`    — The transfer that reached a terminal state.
/// - `channel`     — Event emitter used to broadcast `notification:new`.
/// - `log`         — In-app notification log (shared Tauri state).
/// - `os_notifier` — OS notification bridge (settings-gated).
///
/// # Return
///
/// Returns `Ok(())` on success.  Errors from the in-app log broadcast are
/// returned; OS notification errors are silently logged (non-fatal for the
/// transfer outcome).
pub async fn notify_terminal<E, C>(
    transfer: &Transfer,
    channel: &E,
    log: &NotificationLogHandle,
    os_notifier: &OsNotifier<C>,
) -> Result<(), AppError>
where
    E: EventEmitter,
    C: OsNotifyChannel,
{
    let (severity, title, message) = notification_content(transfer);

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let resource = build_resource_uri(&transfer.bucket, &transfer.key);

    let notification = Notification {
        id: uuid::Uuid::new_v4().to_string(),
        severity: severity.clone(),
        category: NotificationCategory::Background,
        title: title.clone(),
        message: message.clone(),
        resource: Some(resource),
        operation: Some(transfer_operation(transfer)),
        timestamp: now_ms,
        details: None,
    };

    // Push to in-app log + broadcast `notification:new`.
    {
        let mut log_guard = log.0.write().await;
        log_guard.push_with_broadcast(notification.clone(), channel)?;
    }

    // Conditionally fire OS notification.
    // Only for Done/Failed — Canceled is user-initiated so we stay silent.
    let is_terminal_for_os =
        transfer.state == TransferState::Done || transfer.state == TransferState::Failed;

    if is_terminal_for_os {
        // Non-fatal: OS notification errors do not fail the transfer.
        let _ = os_notifier.maybe_send(&notification, true).await;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn notification_content(transfer: &Transfer) -> (Severity, String, String) {
    match &transfer.state {
        TransferState::Done => {
            let op = if transfer.source_path.is_some() {
                "Upload"
            } else {
                "Download"
            };
            let title = format!("{op} complete");
            let message = format!("{} → complete", transfer.key);
            (Severity::Success, title, message)
        }
        TransferState::Failed => {
            let op = if transfer.source_path.is_some() {
                "Upload"
            } else {
                "Download"
            };
            let title = format!("{op} failed");
            let message = transfer
                .error
                .as_ref()
                .map(|e| e.message())
                .unwrap_or_else(|| format!("{} failed", transfer.key));
            (Severity::Error, title, message)
        }
        TransferState::Canceled => {
            let op = if transfer.source_path.is_some() {
                "Upload"
            } else {
                "Download"
            };
            let title = format!("{op} cancelled");
            let message = format!("{} cancelled by user", transfer.key);
            (Severity::Info, title, message)
        }
        // Non-terminal states should not be passed to notify_terminal, but
        // we return a generic entry rather than panicking.
        _ => {
            let title = "Transfer update".to_string();
            let message = format!("{} — state changed", transfer.key);
            (Severity::Info, title, message)
        }
    }
}

fn transfer_operation(transfer: &Transfer) -> String {
    if transfer.source_path.is_some() {
        "upload".to_string()
    } else {
        "download".to_string()
    }
}

/// Build the user-facing S3 resource URI shown in notifications.
///
/// Profile is intentionally omitted: the s3:// URI is the format users
/// expect to see and copy into other S3 tooling (aws-cli, etc.). Profile
/// disambiguation lives in the notification's profile badge instead.
fn build_resource_uri(bucket: &BucketId, key: &str) -> String {
    format!("s3://{}/{}", bucket.as_str(), key)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        events::MockChannel,
        ids::{BucketId, ProfileId},
        notifications::os::MockOsChannel,
        settings::{NotificationSettings, Settings, SettingsHandle},
        transfers::{Transfer, TransferKind, TransferState},
    };
    use std::{path::PathBuf, sync::Arc};
    use tokio::sync::Mutex;

    fn make_settings(os_enabled: bool) -> SettingsHandle {
        let mut settings = Settings::default();
        settings.notifications = NotificationSettings {
            in_app: true,
            os_enabled,
            sound: false,
        };
        SettingsHandle {
            inner: Arc::new(Mutex::new(settings)),
            path: PathBuf::from("/dev/null"),
        }
    }

    fn make_transfer_done() -> Transfer {
        Transfer {
            id: "xfer-done".to_string(),
            kind: TransferKind::Download,
            profile_id: ProfileId::new("p1"),
            bucket: BucketId::new("my-bucket"),
            key: "data/file.txt".to_string(),
            source_path: None,
            dest_path: Some(PathBuf::from("/tmp/file.txt")),
            total_bytes: Some(1024),
            transferred_bytes: 1024,
            parts_done: 0,
            parts_total: 0,
            state: TransferState::Done,
            started_at: 1_000_000,
            finished_at: Some(1_001_000),
            error: None,
        }
    }

    fn make_transfer_failed() -> Transfer {
        Transfer {
            id: "xfer-fail".to_string(),
            kind: TransferKind::Upload,
            profile_id: ProfileId::new("p1"),
            bucket: BucketId::new("my-bucket"),
            key: "data/upload.txt".to_string(),
            source_path: Some(PathBuf::from("/local/upload.txt")),
            dest_path: None,
            total_bytes: Some(2048),
            transferred_bytes: 1024,
            parts_done: 0,
            parts_total: 0,
            state: TransferState::Failed,
            started_at: 1_000_000,
            finished_at: Some(1_002_000),
            error: Some(AppError::Network {
                source: "connection refused".to_string(),
            }),
        }
    }

    fn make_transfer_canceled() -> Transfer {
        Transfer {
            id: "xfer-cancel".to_string(),
            kind: TransferKind::Download,
            profile_id: ProfileId::new("p1"),
            bucket: BucketId::new("my-bucket"),
            key: "data/cancel.txt".to_string(),
            source_path: None,
            dest_path: Some(PathBuf::from("/tmp/cancel.txt")),
            total_bytes: None,
            transferred_bytes: 0,
            parts_done: 0,
            parts_total: 0,
            state: TransferState::Canceled,
            started_at: 1_000_000,
            finished_at: Some(1_001_000),
            error: None,
        }
    }

    // -----------------------------------------------------------------------
    // OS notification fires only for Done/Failed when os_enabled=true
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn os_notification_fires_for_done_when_enabled() {
        let channel = MockChannel::default();
        let log = NotificationLogHandle::default();
        let os_channel = MockOsChannel::new();
        let notifier = OsNotifier::new(os_channel, make_settings(true));

        notify_terminal(&make_transfer_done(), &channel, &log, &notifier)
            .await
            .expect("must succeed");

        assert_eq!(
            notifier.inner_channel().call_count(),
            1,
            "OS notification must fire for Done",
        );
    }

    #[tokio::test]
    async fn os_notification_fires_for_failed_when_enabled() {
        let channel = MockChannel::default();
        let log = NotificationLogHandle::default();
        let os_channel = MockOsChannel::new();
        let notifier = OsNotifier::new(os_channel, make_settings(true));

        notify_terminal(&make_transfer_failed(), &channel, &log, &notifier)
            .await
            .expect("must succeed");

        assert_eq!(
            notifier.inner_channel().call_count(),
            1,
            "OS notification must fire for Failed",
        );
    }

    #[tokio::test]
    async fn os_notification_silent_for_canceled() {
        let channel = MockChannel::default();
        let log = NotificationLogHandle::default();
        let os_channel = MockOsChannel::new();
        let notifier = OsNotifier::new(os_channel, make_settings(true));

        notify_terminal(&make_transfer_canceled(), &channel, &log, &notifier)
            .await
            .expect("must succeed");

        // Canceled → Info severity → OsNotifier Gate 2 blocks it.
        assert_eq!(
            notifier.inner_channel().call_count(),
            0,
            "OS notification must be silent for Canceled state",
        );
    }

    #[tokio::test]
    async fn os_notification_silent_when_os_disabled() {
        let channel = MockChannel::default();
        let log = NotificationLogHandle::default();
        let os_channel = MockOsChannel::new();
        let notifier = OsNotifier::new(os_channel, make_settings(false));

        notify_terminal(&make_transfer_done(), &channel, &log, &notifier)
            .await
            .expect("must succeed");

        assert_eq!(
            notifier.inner_channel().call_count(),
            0,
            "OS notification must be silent when os_enabled=false",
        );
    }

    // -----------------------------------------------------------------------
    // In-app notification is always pushed (regardless of OS setting)
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn in_app_notification_always_pushed() {
        let channel = MockChannel::default();
        let log = NotificationLogHandle::default();
        let os_channel = MockOsChannel::new();
        let notifier = OsNotifier::new(os_channel, make_settings(false));

        notify_terminal(&make_transfer_done(), &channel, &log, &notifier)
            .await
            .expect("must succeed");

        let entries = log.0.read().await.list(None);
        assert_eq!(entries.len(), 1, "one in-app notification must be logged");
        assert_eq!(entries[0].severity, Severity::Success);
    }

    // -----------------------------------------------------------------------
    // Severity mapping
    // -----------------------------------------------------------------------

    #[test]
    fn done_maps_to_success_severity() {
        let t = make_transfer_done();
        let (severity, _, _) = notification_content(&t);
        assert_eq!(severity, Severity::Success);
    }

    #[test]
    fn failed_maps_to_error_severity() {
        let t = make_transfer_failed();
        let (severity, _, _) = notification_content(&t);
        assert_eq!(severity, Severity::Error);
    }

    #[test]
    fn canceled_maps_to_info_severity() {
        let t = make_transfer_canceled();
        let (severity, _, _) = notification_content(&t);
        assert_eq!(severity, Severity::Info);
    }
}
