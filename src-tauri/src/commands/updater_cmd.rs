//! Tauri commands for auto-update operations.
//!
//! # Commands
//!
//! - `updater_check`   — checks the update endpoint; emits `updater:status`
//!                       transitions (`Checking` → `Available`/`UpToDate`/`Error`).
//! - `updater_install` — downloads and installs a pending update; emits
//!                       `Downloading { progress }` → `Ready` (or `Error`).
//!
//! # OCP
//!
//! New updater commands are additive — each is an independent `#[tauri::command]`
//! registered in `lib.rs`.  `UpdateStatus` variants in `updater/mod.rs` extend
//! without touching these handlers.

use tauri::AppHandle;

use crate::{
    error::AppError,
    events::{self, EventKind},
    updater::{self, UpdateStatus},
};

// ---------------------------------------------------------------------------
// updater_restart
// ---------------------------------------------------------------------------

/// Restart the application after a successful `updater_install`.
///
/// The frontend's "Restart now" button used to call
/// `window.location.reload()` which only reloaded the WebView inside the
/// still-running old binary — the staged update never took effect.
/// `app.restart()` exits and re-execs into the freshly-installed binary.
#[tauri::command]
pub fn updater_restart(app: AppHandle) {
    updater::restart(&app);
}

// ---------------------------------------------------------------------------
// updater_check
// ---------------------------------------------------------------------------

/// Check the configured update endpoint for a newer release.
///
/// Emits `updater:status` events:
///   1. `{ "status": "checking" }` — immediately on entry.
///   2. `{ "status": "available", "version": "…", "notes": "…" }` — when a
///       newer version is found.
///   3. `{ "status": "upToDate" }` — when already on latest.
///   4. `{ "status": "error", "message": "…" }` — on any failure.
///
/// Returns the final `UpdateStatus` for callers who prefer a synchronous result
/// (the frontend can use either the return value or the events).
#[tauri::command]
pub async fn updater_check(app: AppHandle) -> Result<UpdateStatus, AppError> {
    // Emit "checking" immediately so the UI can show a spinner.
    let _ = events::emit(&app, EventKind::UpdaterStatus, &UpdateStatus::Checking);

    let status = updater::check_for_update(&app).await?;

    // Emit the terminal state.
    let _ = events::emit(&app, EventKind::UpdaterStatus, &status);

    Ok(status)
}

// ---------------------------------------------------------------------------
// updater_install
// ---------------------------------------------------------------------------

/// Download and install the pending update.
///
/// Must be called after `updater_check` returned `Available`.
///
/// Emits `updater:status` events:
///   1. `{ "status": "downloading", "progress": null }` — download started.
///   2. `{ "status": "ready" }` — download + install complete; restart pending.
///   3. `{ "status": "error", "message": "…" }` — on any failure.
#[tauri::command]
pub async fn updater_install(app: AppHandle) -> Result<(), AppError> {
    let _ = events::emit(
        &app,
        EventKind::UpdaterStatus,
        &UpdateStatus::Downloading { progress: None },
    );

    match updater::install_update(&app).await {
        Ok(()) => {
            let _ = events::emit(&app, EventKind::UpdaterStatus, &UpdateStatus::Ready);
            Ok(())
        }
        Err(e) => {
            let status = UpdateStatus::Error {
                message: e.message(),
            };
            let _ = events::emit(&app, EventKind::UpdaterStatus, &status);
            Err(e)
        }
    }
}
