//! Typed event emission helper.
//!
//! # OCP contract
//!
//! - `EventKind::as_str()` is the **single canonical name source** for all
//!   server→client event names.  Adding an event means adding one variant plus
//!   one match arm — no other site changes.
//! - The `EventEmitter` trait + `MockChannel` ensure the same code path runs
//!   in tests and production.  Tests never reach the Tauri runtime.
//!
//! # Usage
//!
//! ```rust,ignore
//! events::emit(&app_handle, EventKind::ObjectsUpdated, payload)?;
//! ```

use serde::Serialize;

use crate::error::AppError;

// ---------------------------------------------------------------------------
// EventKind
// ---------------------------------------------------------------------------

/// Every event that the backend can emit to the frontend.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventKind {
    BucketsUpdated,
    ObjectsUpdated,
    TransferProgress,
    TransferState,
    LockAcquired,
    LockReleased,
    NotificationNew,
    SearchPage,
    MediaRevoked,
    UpdaterStatus,
    /// Emitted when the OS keychain is unavailable and the FileBackend
    /// requires a passphrase to unlock. The Credential Manager UI shows
    /// the fallback prompt exactly once per session in response.
    KeychainFallbackRequired,
}

impl EventKind {
    /// The canonical event name string used on the IPC channel.
    ///
    /// This is the single source of truth — frontend listeners subscribe to
    /// exactly these strings.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::BucketsUpdated => "buckets:updated",
            Self::ObjectsUpdated => "objects:updated",
            Self::TransferProgress => "transfer:progress",
            Self::TransferState => "transfer:state",
            Self::LockAcquired => "lock:acquired",
            Self::LockReleased => "lock:released",
            Self::NotificationNew => "notification:new",
            Self::SearchPage => "search:page",
            Self::MediaRevoked => "media:revoked",
            Self::UpdaterStatus => "updater:status",
            Self::KeychainFallbackRequired => "keychain:fallback-required",
        }
    }
}

// ---------------------------------------------------------------------------
// EventEmitter trait
// ---------------------------------------------------------------------------

/// Abstraction over anything that can emit Tauri-style events.
///
/// `tauri::AppHandle` implements this via the real Tauri runtime.
/// `MockChannel` implements it for tests.
pub trait EventEmitter {
    fn emit<P: Serialize + Clone>(&self, kind: EventKind, payload: P) -> Result<(), AppError>;
}

// ---------------------------------------------------------------------------
// AppHandle impl
// ---------------------------------------------------------------------------

impl EventEmitter for tauri::AppHandle {
    fn emit<P: Serialize + Clone>(&self, kind: EventKind, payload: P) -> Result<(), AppError> {
        tauri::Emitter::emit(self, kind.as_str(), payload).map_err(|e| AppError::Network {
            source: format!("tauri emit error: {e}"),
        })
    }
}

// ---------------------------------------------------------------------------
// Free convenience function
// ---------------------------------------------------------------------------

/// Emit an event through any `EventEmitter` channel.
///
/// This thin wrapper lets call sites omit the `.emit(…)` method chain and
/// keeps the signature uniform across production and test code.
pub fn emit<P, E>(channel: &E, kind: EventKind, payload: P) -> Result<(), AppError>
where
    P: Serialize + Clone,
    E: EventEmitter,
{
    channel.emit(kind, payload)
}

// ---------------------------------------------------------------------------
// MockChannel — for tests only
// ---------------------------------------------------------------------------

/// In-memory event recorder used in tests.
///
/// Records every `(EventKind, serde_json::Value)` pair in insertion order so
/// test assertions can check both *what* was emitted and *what payload* it
/// carried.
#[cfg(test)]
#[derive(Default)]
pub struct MockChannel {
    recorded: std::sync::Mutex<Vec<(EventKind, serde_json::Value)>>,
}

#[cfg(test)]
impl MockChannel {
    /// Drain all recorded emissions as a `Vec`.
    pub fn emitted(&self) -> Vec<(EventKind, serde_json::Value)> {
        self.recorded.lock().expect("lock poisoned").clone()
    }
}

#[cfg(test)]
impl EventEmitter for MockChannel {
    fn emit<P: Serialize>(&self, kind: EventKind, payload: P) -> Result<(), AppError> {
        let value = serde_json::to_value(payload).expect("MockChannel: payload must serialize");
        self.recorded
            .lock()
            .expect("lock poisoned")
            .push((kind, value));
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn all_event_kind_strings_are_unique() {
        let kinds = [
            EventKind::BucketsUpdated,
            EventKind::ObjectsUpdated,
            EventKind::TransferProgress,
            EventKind::TransferState,
            EventKind::LockAcquired,
            EventKind::LockReleased,
            EventKind::NotificationNew,
            EventKind::SearchPage,
            EventKind::MediaRevoked,
            EventKind::UpdaterStatus,
            EventKind::KeychainFallbackRequired,
        ];
        let mut seen = std::collections::HashSet::new();
        for k in &kinds {
            let s = k.as_str();
            assert!(seen.insert(s), "duplicate event name: {s}");
        }
    }

    #[test]
    fn event_kind_as_str_values() {
        assert_eq!(EventKind::BucketsUpdated.as_str(), "buckets:updated");
        assert_eq!(EventKind::ObjectsUpdated.as_str(), "objects:updated");
        assert_eq!(EventKind::TransferProgress.as_str(), "transfer:progress");
        assert_eq!(EventKind::TransferState.as_str(), "transfer:state");
        assert_eq!(EventKind::LockAcquired.as_str(), "lock:acquired");
        assert_eq!(EventKind::LockReleased.as_str(), "lock:released");
        assert_eq!(EventKind::NotificationNew.as_str(), "notification:new");
        assert_eq!(EventKind::SearchPage.as_str(), "search:page");
        assert_eq!(EventKind::MediaRevoked.as_str(), "media:revoked");
        assert_eq!(EventKind::UpdaterStatus.as_str(), "updater:status");
        assert_eq!(
            EventKind::KeychainFallbackRequired.as_str(),
            "keychain:fallback-required"
        );
    }

    #[test]
    fn mock_channel_records_emission() {
        let channel = MockChannel::default();
        let payload = json!({
            "profileId": "my-profile",
            "bucket": "my-bucket",
            "prefix": "folder/"
        });
        emit(&channel, EventKind::ObjectsUpdated, &payload).expect("emit should succeed");

        let emitted = channel.emitted();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].0, EventKind::ObjectsUpdated);
        assert_eq!(emitted[0].1["profileId"], "my-profile");
        assert_eq!(emitted[0].1["bucket"], "my-bucket");
        assert_eq!(emitted[0].1["prefix"], "folder/");
    }

    #[test]
    fn mock_channel_records_multiple_emissions() {
        let channel = MockChannel::default();
        emit(
            &channel,
            EventKind::BucketsUpdated,
            json!({"profileId": "p1"}),
        )
        .expect("first emit");
        emit(
            &channel,
            EventKind::TransferState,
            json!({"requestId": "r1", "state": "done"}),
        )
        .expect("second emit");

        let emitted = channel.emitted();
        assert_eq!(emitted.len(), 2);
        assert_eq!(emitted[0].0, EventKind::BucketsUpdated);
        assert_eq!(emitted[1].0, EventKind::TransferState);
    }
}
