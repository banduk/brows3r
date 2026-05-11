//! Tauri commands for diagnostic bundle collection and export.
//!
//! # Commands
//!
//! - `diagnostics_collect` — build a redacted ZIP bundle from app files.
//! - `diagnostics_export`  — copy the ZIP to a user-chosen path and clean up.
//!
//! # OCP
//!
//! New diagnostic commands are additive — each is an independent
//! `#[tauri::command]` registered in `lib.rs`. `BundleConfig` is open for
//! new `include_*` fields without changing these handlers.

use std::path::PathBuf;

use tauri::{AppHandle, Manager, State};

use crate::{
    diagnostics::{
        bundle::{collect_bundle, export_bundle, AppPaths, BundleConfig, BundleRef},
        DiagnosticsRedactorHandle,
    },
    error::AppError,
};

// ---------------------------------------------------------------------------
// diagnostics_collect
// ---------------------------------------------------------------------------

/// Collect a diagnostic bundle according to `config`.
///
/// Resolves the app paths from the Tauri `AppHandle`, builds the bundle via
/// `collect_bundle`, and returns a `BundleRef` that the frontend holds
/// between the "Generate" and "Save" steps.
#[tauri::command]
pub async fn diagnostics_collect(
    config: BundleConfig,
    redactor: State<'_, DiagnosticsRedactorHandle>,
    app: AppHandle,
) -> Result<BundleRef, AppError> {
    let app_paths = resolve_app_paths(&app)?;
    collect_bundle(&config, &app_paths, &redactor)
}

// ---------------------------------------------------------------------------
// diagnostics_export
// ---------------------------------------------------------------------------

/// Copy the collected bundle ZIP to `dest_path` and clean up the temp dir.
///
/// `bundle_ref` must be the value returned by a preceding `diagnostics_collect`
/// call.  After a successful export the temp dir is removed automatically.
#[tauri::command]
pub async fn diagnostics_export(bundle_ref: BundleRef, dest_path: PathBuf) -> Result<(), AppError> {
    export_bundle(&bundle_ref, &dest_path)
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/// Build `AppPaths` from the Tauri `AppHandle`.
///
/// Falls back to temp-dir sub-directories when the Tauri resolver returns
/// an error (e.g. in sandboxed environments or tests).
fn resolve_app_paths(app: &AppHandle) -> Result<AppPaths, AppError> {
    let path_resolver = app.path();

    let app_config_dir = path_resolver
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("brows3r_config"));

    let app_log_dir = path_resolver
        .app_log_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("brows3r_logs"));

    let app_cache_dir = path_resolver
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("brows3r_cache"));

    Ok(AppPaths {
        app_config_dir,
        app_log_dir,
        app_cache_dir,
    })
}
