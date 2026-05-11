//! Auto-updater logic using `tauri-plugin-updater`.
//!
//! # Responsibilities
//!
//! - `UpdateStatus` — serializable state machine shared with the frontend.
//! - `check_for_update` — asks the updater endpoint whether a newer version is
//!   available.
//! - `install_update` — downloads and stages the pending update so Tauri can
//!   restart into it.
//!
//! # OCP
//!
//! `UpdateStatus` is open for new variants.  The frontend discriminates on the
//! `status` field (a `type` tag), so adding a variant here only requires a new
//! branch in the frontend switch.  Existing arms are unaffected.

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

use crate::error::AppError;

// ---------------------------------------------------------------------------
// UpdateStatus
// ---------------------------------------------------------------------------

/// Every state the updater can be in.
///
/// Serialises as `{ "status": "<variant>", ...fields }` via `#[serde(tag)]`.
///
/// # OCP note
/// New variants extend the enum without modifying existing arms.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
#[serde(rename_all_fields = "camelCase")]
pub enum UpdateStatus {
    /// No check in progress; nothing has happened yet.
    Idle,
    /// A version-check request is in flight.
    Checking,
    /// A newer version is available and has not yet been downloaded.
    Available {
        version: String,
        notes: Option<String>,
        download_url: Option<String>,
    },
    /// The update binary is being downloaded.
    Downloading {
        /// Progress fraction in `[0.0, 1.0]`.  `None` when total size is unknown.
        progress: Option<f32>,
    },
    /// Download complete; the app is ready to restart into the new version.
    Ready,
    /// Already on the latest version.
    UpToDate,
    /// Something went wrong.
    Error { message: String },
}

// ---------------------------------------------------------------------------
// check_for_update
// ---------------------------------------------------------------------------

/// Check the configured updater endpoint for a newer version.
///
/// Returns `UpdateStatus::Available { … }` when a newer release is published,
/// or `UpdateStatus::UpToDate` when the current version is current.
///
/// The caller is responsible for emitting `updater:status` events so the
/// frontend can track transitions.
pub async fn check_for_update(app: &AppHandle) -> Result<UpdateStatus, AppError> {
    let updater = app.updater().map_err(|e| AppError::Internal {
        trace_id: format!("updater_init: {e}"),
    })?;

    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            let notes = update.body.clone();
            // The download URL is not directly exposed by the plugin's public
            // API — the update handle carries it internally.  We surface
            // `None` here; the frontend only needs it for display purposes and
            // the actual download is triggered through `install_update`.
            Ok(UpdateStatus::Available {
                version,
                notes,
                download_url: None,
            })
        }
        Ok(None) => Ok(UpdateStatus::UpToDate),
        Err(e) => Ok(UpdateStatus::Error {
            message: e.to_string(),
        }),
    }
}

// ---------------------------------------------------------------------------
// install_update
// ---------------------------------------------------------------------------

/// Download and stage the pending update, then request an app restart.
///
/// Must only be called after `check_for_update` has returned
/// `UpdateStatus::Available`.  Calling this when no update is pending returns
/// `AppError::Validation`.
///
/// Progress events are emitted by the command layer (`updater_cmd`), which
/// wraps this function and emits `updater:status` transitions at each phase.
pub async fn install_update(app: &AppHandle) -> Result<(), AppError> {
    let updater = app.updater().map_err(|e| AppError::Internal {
        trace_id: format!("updater_init: {e}"),
    })?;

    let update = updater
        .check()
        .await
        .map_err(|e| AppError::Network {
            source: format!("updater check: {e}"),
        })?
        .ok_or_else(|| AppError::Validation {
            field: "update".to_string(),
            hint: "No pending update available".to_string(),
        })?;

    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| AppError::Network {
            source: format!("updater install: {e}"),
        })?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn ser(s: &UpdateStatus) -> Value {
        serde_json::to_value(s).expect("UpdateStatus must serialize")
    }

    #[test]
    fn idle_serializes() {
        let v = ser(&UpdateStatus::Idle);
        assert_eq!(v["status"], "idle");
    }

    #[test]
    fn checking_serializes() {
        let v = ser(&UpdateStatus::Checking);
        assert_eq!(v["status"], "checking");
    }

    #[test]
    fn available_serializes() {
        let v = ser(&UpdateStatus::Available {
            version: "1.2.3".to_string(),
            notes: Some("Bug fixes".to_string()),
            download_url: Some("https://example.com/release".to_string()),
        });
        assert_eq!(v["status"], "available");
        assert_eq!(v["version"], "1.2.3");
        assert_eq!(v["notes"], "Bug fixes");
        assert_eq!(v["downloadUrl"], "https://example.com/release");
    }

    #[test]
    fn available_optional_fields_null() {
        let v = ser(&UpdateStatus::Available {
            version: "0.2.0".to_string(),
            notes: None,
            download_url: None,
        });
        assert_eq!(v["status"], "available");
        assert_eq!(v["version"], "0.2.0");
        assert!(v["notes"].is_null());
        assert!(v["downloadUrl"].is_null());
    }

    #[test]
    fn downloading_with_progress_serializes() {
        let v = ser(&UpdateStatus::Downloading {
            progress: Some(0.42),
        });
        assert_eq!(v["status"], "downloading");
        let p = v["progress"].as_f64().expect("progress must be f64");
        assert!((p - 0.42_f64).abs() < 0.001);
    }

    #[test]
    fn downloading_unknown_progress_serializes() {
        let v = ser(&UpdateStatus::Downloading { progress: None });
        assert_eq!(v["status"], "downloading");
        assert!(v["progress"].is_null());
    }

    #[test]
    fn ready_serializes() {
        let v = ser(&UpdateStatus::Ready);
        assert_eq!(v["status"], "ready");
    }

    #[test]
    fn up_to_date_serializes() {
        let v = ser(&UpdateStatus::UpToDate);
        assert_eq!(v["status"], "upToDate");
    }

    #[test]
    fn error_serializes() {
        let v = ser(&UpdateStatus::Error {
            message: "network timeout".to_string(),
        });
        assert_eq!(v["status"], "error");
        assert_eq!(v["message"], "network timeout");
    }
}
