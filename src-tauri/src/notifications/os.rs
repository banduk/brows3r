//! OS notification bridge.
//!
//! `OsNotifier` wraps a `tauri::AppHandle` (or any `OsNotifyChannel` impl in
//! tests) and gates OS-level notifications behind the user's
//! `Settings::notifications.os_enabled` preference.
//!
//! # Gating rules
//!
//! An OS notification fires **only** when all three conditions hold:
//!   1. `Settings::notifications.os_enabled == true`
//!   2. `notification.severity` is `Success`, `Warning`, or `Error`
//!      (i.e. not `Info`).
//!   3. `terminal == true` — the caller signals that the transfer/operation
//!      has reached a final state (`done` or `failed`).
//!
//! When any gate fails the method returns `Ok(())` (silent skip).
//! When the underlying plugin call fails the method returns
//! `Err(AppError::Network { .. })`.
//!
//! # OCP contract
//!
//! The `OsNotifyChannel` trait is the extension point: adding a new channel
//! (e.g. Slack webhook, webhook-as-plugin) means implementing the one-method
//! trait.  `OsNotifier` never hard-codes the plugin type — it accepts any
//! channel implementation through the trait.

use crate::{error::AppError, notifications::Severity, settings::SettingsHandle};

// ---------------------------------------------------------------------------
// OsNotifyChannel trait
// ---------------------------------------------------------------------------

/// Abstraction over any channel that can send an OS-style notification.
///
/// `AppHandleChannel` wraps `tauri::AppHandle` for production.
/// `MockOsChannel` is provided for tests.
pub trait OsNotifyChannel {
    fn send(&self, title: &str, body: &str) -> Result<(), AppError>;
}

// ---------------------------------------------------------------------------
// AppHandleChannel — real Tauri plugin bridge
// ---------------------------------------------------------------------------

/// Production `OsNotifyChannel` backed by `tauri-plugin-notification`.
pub struct AppHandleChannel {
    pub app: tauri::AppHandle,
}

impl OsNotifyChannel for AppHandleChannel {
    fn send(&self, title: &str, body: &str) -> Result<(), AppError> {
        use tauri_plugin_notification::NotificationExt;
        self.app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|e| AppError::Network {
                source: format!("os notification plugin error: {e}"),
            })
    }
}

// ---------------------------------------------------------------------------
// OsNotifier
// ---------------------------------------------------------------------------

/// Sends OS notifications when gating rules pass.
pub struct OsNotifier<C: OsNotifyChannel> {
    channel: C,
    settings: SettingsHandle,
}

impl<C: OsNotifyChannel> OsNotifier<C> {
    pub fn new(channel: C, settings: SettingsHandle) -> Self {
        Self { channel, settings }
    }
}

impl OsNotifier<NoopOsChannel> {
    /// Create a no-op `OsNotifier` suitable for integration tests and CLI
    /// contexts where no `AppHandle` is available.
    ///
    /// OS notifications are silently discarded.  The gating logic still runs
    /// (it reads settings), but with a default `SettingsHandle` that has
    /// `notifications.os_enabled = false`, so the channel is never called.
    pub fn noop() -> Self {
        use crate::settings::SettingsHandle;
        use std::path::PathBuf;
        let settings = SettingsHandle::new(crate::settings::Settings::default(), PathBuf::new());
        Self {
            channel: NoopOsChannel,
            settings,
        }
    }
}

impl<C: OsNotifyChannel> OsNotifier<C> {
    /// Conditionally send an OS notification.
    ///
    /// Returns `Ok(())` when any gate fails (silent skip).
    /// Returns `Err(AppError::Network { .. })` only if the plugin call itself
    /// errors.
    pub async fn maybe_send(
        &self,
        notification: &crate::notifications::Notification,
        terminal: bool,
    ) -> Result<(), AppError> {
        // Gate 1: OS notifications must be enabled in settings.
        let os_enabled = {
            let settings = self.settings.inner.lock().await;
            settings.notifications.os_enabled
        };
        if !os_enabled {
            return Ok(());
        }

        // Gate 2: severity must be non-Info.
        if notification.severity == Severity::Info {
            return Ok(());
        }

        // Gate 3: operation must be terminal.
        if !terminal {
            return Ok(());
        }

        self.channel
            .send(&notification.title, &notification.message)
    }
}

// ---------------------------------------------------------------------------
// OsNotifier test helpers
// ---------------------------------------------------------------------------

#[cfg(test)]
impl<C: OsNotifyChannel> OsNotifier<C> {
    /// Number of OS notification calls sent through the channel.
    ///
    /// Only available in tests.  The `channel` field must have a `call_count`
    /// method (i.e. this is only useful with `MockOsChannel`).
    pub fn inner_channel(&self) -> &C {
        &self.channel
    }
}

// ---------------------------------------------------------------------------
// MockOsChannel — for tests only
// ---------------------------------------------------------------------------

#[cfg(test)]
pub struct MockOsChannel {
    pub calls: std::sync::Mutex<Vec<(String, String)>>,
    /// When `true` the `send` call returns an error (simulates plugin failure).
    pub should_fail: bool,
}

#[cfg(test)]
impl Default for MockOsChannel {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
impl MockOsChannel {
    pub fn new() -> Self {
        Self {
            calls: std::sync::Mutex::new(Vec::new()),
            should_fail: false,
        }
    }

    pub fn failing() -> Self {
        Self {
            calls: std::sync::Mutex::new(Vec::new()),
            should_fail: true,
        }
    }

    pub fn call_count(&self) -> usize {
        self.calls.lock().expect("lock poisoned").len()
    }
}

#[cfg(test)]
impl OsNotifyChannel for MockOsChannel {
    fn send(&self, title: &str, body: &str) -> Result<(), AppError> {
        if self.should_fail {
            return Err(AppError::Network {
                source: "mock plugin failure".to_string(),
            });
        }
        self.calls
            .lock()
            .expect("lock poisoned")
            .push((title.to_string(), body.to_string()));
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// NoopOsChannel — always-Ok no-op, usable in integration tests
// ---------------------------------------------------------------------------

/// An `OsNotifyChannel` that silently discards all notifications.
///
/// Intended for use in integration tests and CLI contexts where no Tauri
/// `AppHandle` is available.  All `send` calls return `Ok(())`.
pub struct NoopOsChannel;

impl OsNotifyChannel for NoopOsChannel {
    fn send(&self, _title: &str, _body: &str) -> Result<(), crate::error::AppError> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        notifications::{Notification, NotificationCategory, Severity},
        settings::{NotificationSettings, Settings, SettingsHandle},
    };
    use std::path::PathBuf;
    use tokio::sync::Mutex;

    fn make_settings(os_enabled: bool) -> SettingsHandle {
        let settings = Settings {
            notifications: NotificationSettings {
                in_app: true,
                os_enabled,
                sound: false,
            },
            ..Settings::default()
        };
        SettingsHandle {
            inner: std::sync::Arc::new(Mutex::new(settings)),
            path: PathBuf::from("/dev/null"),
        }
    }

    fn make_notification(severity: Severity) -> Notification {
        Notification {
            id: "test-id".to_string(),
            severity,
            category: NotificationCategory::Background,
            title: "Upload complete".to_string(),
            message: "my-file.txt uploaded".to_string(),
            resource: Some("s3://bucket/my-file.txt".to_string()),
            operation: Some("upload".to_string()),
            timestamp: 1_000_000,
            details: None,
        }
    }

    // --- Gate 1: os_enabled=false → no call ---

    #[tokio::test]
    async fn no_call_when_os_disabled() {
        let channel = MockOsChannel::new();
        let notifier = OsNotifier::new(channel, make_settings(false));
        let notif = make_notification(Severity::Success);
        notifier
            .maybe_send(&notif, true)
            .await
            .expect("should be ok");
        assert_eq!(
            notifier.channel.call_count(),
            0,
            "no OS notification when os_enabled=false"
        );
    }

    // --- Gate 2: severity=Info → no call ---

    #[tokio::test]
    async fn no_call_for_info_severity() {
        let channel = MockOsChannel::new();
        let notifier = OsNotifier::new(channel, make_settings(true));
        let notif = make_notification(Severity::Info);
        notifier
            .maybe_send(&notif, true)
            .await
            .expect("should be ok");
        assert_eq!(
            notifier.channel.call_count(),
            0,
            "no OS notification for Info severity"
        );
    }

    // --- Gate 3: terminal=false → no call ---

    #[tokio::test]
    async fn no_call_when_not_terminal() {
        let channel = MockOsChannel::new();
        let notifier = OsNotifier::new(channel, make_settings(true));
        let notif = make_notification(Severity::Success);
        notifier
            .maybe_send(&notif, false)
            .await
            .expect("should be ok");
        assert_eq!(
            notifier.channel.call_count(),
            0,
            "no OS notification when terminal=false"
        );
    }

    // --- All gates pass: os_enabled=true + non-Info + terminal → call fires ---

    #[tokio::test]
    async fn sends_when_all_gates_pass_success() {
        let channel = MockOsChannel::new();
        let notifier = OsNotifier::new(channel, make_settings(true));
        let notif = make_notification(Severity::Success);
        notifier
            .maybe_send(&notif, true)
            .await
            .expect("should be ok");
        assert_eq!(
            notifier.channel.call_count(),
            1,
            "OS notification should fire for Success+terminal+enabled"
        );
    }

    #[tokio::test]
    async fn sends_for_warning_severity() {
        let channel = MockOsChannel::new();
        let notifier = OsNotifier::new(channel, make_settings(true));
        let notif = make_notification(Severity::Warning);
        notifier
            .maybe_send(&notif, true)
            .await
            .expect("should be ok");
        assert_eq!(notifier.channel.call_count(), 1);
    }

    #[tokio::test]
    async fn sends_for_error_severity() {
        let channel = MockOsChannel::new();
        let notifier = OsNotifier::new(channel, make_settings(true));
        let notif = make_notification(Severity::Error);
        notifier
            .maybe_send(&notif, true)
            .await
            .expect("should be ok");
        assert_eq!(notifier.channel.call_count(), 1);
    }

    // --- Plugin failure → Err returned ---

    #[tokio::test]
    async fn plugin_failure_returns_err() {
        let channel = MockOsChannel::failing();
        let notifier = OsNotifier::new(channel, make_settings(true));
        let notif = make_notification(Severity::Error);
        let result = notifier.maybe_send(&notif, true).await;
        assert!(
            matches!(result, Err(AppError::Network { .. })),
            "plugin failure should propagate as AppError::Network"
        );
    }
}
