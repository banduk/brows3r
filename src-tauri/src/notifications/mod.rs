//! In-app notification log.
//!
//! # Structs
//!
//! - [`Notification`]       — immutable notification value.
//! - [`NotificationLog`]    — in-memory ring buffer (default capacity 500).
//! - [`NotificationLogHandle`] — `Arc<RwLock<NotificationLog>>` Tauri managed state.
//!
//! # OCP contract
//!
//! Capacity is settable via [`NotificationLog::with_capacity`].
//! `NotificationLog::push_with_broadcast` accepts any `EventEmitter` impl, so
//! tests can pass a `MockChannel` and production code passes the `AppHandle`.
//! Adding a new `Severity` or `NotificationCategory` variant requires only a
//! new enum arm — no other match arms change.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::{
    error::AppError,
    events::{emit, EventEmitter, EventKind},
};

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

/// Severity level of a notification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    Info,
    Warning,
    Error,
    Success,
}

// ---------------------------------------------------------------------------
// NotificationCategory
// ---------------------------------------------------------------------------

/// Classification that drives frontend placement policy (panel-only vs
/// panel+toast vs panel+inline — consumed in task 22).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NotificationCategory {
    /// Notification originated from a direct user action.
    UserInitiated,
    /// Notification originated from a background operation.
    Background,
}

// ---------------------------------------------------------------------------
// Notification
// ---------------------------------------------------------------------------

/// A single immutable notification entry stored in the log.
///
/// All fields are `Clone` so callers can copy the value for broadcast payloads
/// without needing a reference into the log.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    /// UUID v4 string that uniquely identifies this notification.
    pub id: String,
    pub severity: Severity,
    pub category: NotificationCategory,
    pub title: String,
    pub message: String,
    /// S3 resource URI (`s3://bucket/key`) or other resource identifier.
    pub resource: Option<String>,
    /// Name of the operation that produced this notification (e.g. `"upload"`).
    pub operation: Option<String>,
    /// Unix timestamp in milliseconds.
    pub timestamp: i64,
    /// Copyable structured details (free-form JSON).
    pub details: Option<serde_json::Value>,
}

// ---------------------------------------------------------------------------
// NotificationLog
// ---------------------------------------------------------------------------

/// In-memory ring buffer for in-app notifications.
///
/// Entries are stored in insertion order.  When the buffer is full the oldest
/// entry is evicted before the new one is appended (ring semantics).
///
/// All public methods are `&mut self`; callers must hold the `RwLock` write
/// guard from `NotificationLogHandle` when mutating.
pub struct NotificationLog {
    capacity: usize,
    /// Entries stored in insertion order (oldest first).
    entries: std::collections::VecDeque<Notification>,
}

impl NotificationLog {
    /// Create a log with the default capacity of 500 entries.
    pub fn new() -> Self {
        Self::with_capacity(500)
    }

    /// Create a log with a custom capacity.  A capacity of 0 is clamped to 1.
    pub fn with_capacity(capacity: usize) -> Self {
        let cap = capacity.max(1);
        Self {
            capacity: cap,
            entries: std::collections::VecDeque::with_capacity(cap),
        }
    }

    /// Append a notification.  If the buffer is at capacity the oldest entry
    /// is dropped first.
    pub fn push(&mut self, notification: Notification) {
        if self.entries.len() == self.capacity {
            self.entries.pop_front();
        }
        self.entries.push_back(notification);
    }

    /// Append a notification **and** emit a `NotificationNew` event via
    /// `channel`.  Errors from the emit are returned but the notification is
    /// always stored (emit failure is non-fatal in the log itself).
    pub fn push_with_broadcast<E: EventEmitter>(
        &mut self,
        notification: Notification,
        channel: &E,
    ) -> Result<(), AppError> {
        let notif_clone = notification.clone();
        self.push(notification);
        emit(channel, EventKind::NotificationNew, &notif_clone)
    }

    /// Return all notifications with `timestamp >= since_ms`, or all entries
    /// when `since_ms` is `None`.
    pub fn list(&self, since: Option<i64>) -> Vec<Notification> {
        match since {
            None => self.entries.iter().cloned().collect(),
            Some(since_ms) => self
                .entries
                .iter()
                .filter(|n| n.timestamp >= since_ms)
                .cloned()
                .collect(),
        }
    }

    /// Dismiss a notification by id.  Returns `true` when found and removed,
    /// `false` otherwise.
    pub fn dismiss(&mut self, id: &str) -> bool {
        if let Some(pos) = self.entries.iter().position(|n| n.id == id) {
            self.entries.remove(pos);
            true
        } else {
            false
        }
    }

    /// Remove all notifications from the log.
    pub fn clear_all(&mut self) {
        self.entries.clear();
    }
}

impl Default for NotificationLog {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// NotificationLogHandle
// ---------------------------------------------------------------------------

/// Newtype around `Arc<RwLock<NotificationLog>>` used as Tauri managed state.
///
/// Commands receive `tauri::State<NotificationLogHandle>` and acquire the
/// inner lock for the duration of the read or write.
#[derive(Clone)]
pub struct NotificationLogHandle(pub Arc<RwLock<NotificationLog>>);

impl NotificationLogHandle {
    pub fn new(log: NotificationLog) -> Self {
        Self(Arc::new(RwLock::new(log)))
    }
}

impl Default for NotificationLogHandle {
    fn default() -> Self {
        Self::new(NotificationLog::new())
    }
}

// ---------------------------------------------------------------------------
// pub re-export for os module
// ---------------------------------------------------------------------------

pub mod os;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::MockChannel;

    fn make_notif(id: &str, ts: i64) -> Notification {
        Notification {
            id: id.to_string(),
            severity: Severity::Info,
            category: NotificationCategory::Background,
            title: "Test".to_string(),
            message: "msg".to_string(),
            resource: None,
            operation: None,
            timestamp: ts,
            details: None,
        }
    }

    // --- ring buffer tests ---

    #[test]
    fn push_501_evicts_first() {
        let mut log = NotificationLog::with_capacity(500);
        for i in 0..501u32 {
            log.push(make_notif(&i.to_string(), i as i64));
        }
        let entries = log.list(None);
        assert_eq!(entries.len(), 500, "should hold exactly 500 entries");
        // First entry should be id "1" (id "0" was evicted)
        assert_eq!(
            entries[0].id, "1",
            "oldest entry after eviction should be id=1"
        );
        assert_eq!(entries[499].id, "500", "newest entry should be id=500");
    }

    #[test]
    fn push_then_dismiss_omits_from_list() {
        let mut log = NotificationLog::new();
        log.push(make_notif("a", 1000));
        log.push(make_notif("b", 2000));
        let removed = log.dismiss("a");
        assert!(removed, "dismiss should return true");
        let entries = log.list(None);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "b");
    }

    #[test]
    fn dismiss_missing_returns_false() {
        let mut log = NotificationLog::new();
        assert!(!log.dismiss("no-such-id"));
    }

    #[test]
    fn list_with_since_filter() {
        let mut log = NotificationLog::new();
        log.push(make_notif("old", 1000));
        log.push(make_notif("mid", 5000));
        log.push(make_notif("new", 9000));

        let after = log.list(Some(5000));
        assert_eq!(after.len(), 2, "should include mid and new (>=5000)");
        assert_eq!(after[0].id, "mid");
        assert_eq!(after[1].id, "new");
    }

    #[test]
    fn clear_all_empties_log() {
        let mut log = NotificationLog::new();
        log.push(make_notif("x", 0));
        log.clear_all();
        assert!(log.list(None).is_empty());
    }

    // --- push_with_broadcast ---

    #[test]
    fn push_with_broadcast_emits_notification_new() {
        let mut log = NotificationLog::new();
        let channel = MockChannel::default();
        let notif = make_notif("broadcast-id", 12345);

        log.push_with_broadcast(notif, &channel)
            .expect("broadcast should succeed");

        let emitted = channel.emitted();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].0, EventKind::NotificationNew);
        let payload: Notification =
            serde_json::from_value(emitted[0].1.clone()).expect("payload should be Notification");
        assert_eq!(payload.id, "broadcast-id");
    }
}
