//! Application settings: typed store with all v1 defaults.
//!
//! # Layout
//!
//! - `mod.rs`      — `Settings` struct, sub-structs, load/save, and `SettingsHandle`.
//! - `defaults.rs` — `Default for Settings` with every v1 default from the proposal.
//!
//! # Persistence
//!
//! `${app_config_dir}/settings.json` is the canonical backing file.  On save the
//! file is written atomically (temp file + rename) so a crash during write cannot
//! corrupt the stored settings.
//!
//! # Forward-compatibility
//!
//! The `unknown` field uses `#[serde(flatten)]` over a `BTreeMap<String, Value>`.
//! Any JSON key that does not map to a known field is round-tripped verbatim, so
//! settings written by a future app version are preserved when the user downgrades.
//!
//! # OCP
//!
//! Typed sub-structs (`NotificationSettings`, `TransferConfirmations`, …) make
//! adding a new sub-field a non-breaking change — serde simply deserialises new
//! keys into `unknown` on older builds and propagates them back on save.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;

use crate::error::AppError;

mod defaults;

// ---------------------------------------------------------------------------
// Sub-structs
// ---------------------------------------------------------------------------

/// Controls in-app and OS-level notification behaviour.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettings {
    /// Show notifications in the in-app notification area.
    pub in_app: bool,
    /// Trigger an OS notification when a background transfer completes.
    pub os_enabled: bool,
    /// Play a sound with OS notifications.
    pub sound: bool,
}

/// Confirmation thresholds for potentially destructive or billable operations.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferConfirmations {
    /// Ask before deleting objects.
    pub delete: bool,
    /// Ask before overwriting an existing object.
    pub overwrite: bool,
    /// Ask before uploading a file larger than this many MiB.
    pub large_upload_mb: u64,
}

/// A single S3-compatible endpoint entry in the endpoint registry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3CompatibleEndpoint {
    pub name: String,
    pub endpoint_url: String,
    pub default_region: String,
    /// Optional compat flags template for this endpoint.
    /// When `None` the app uses its built-in provider-detection heuristics.
    pub compat_flags_template: Option<crate::profiles::compat_flags::CompatFlags>,
}

/// Auto-update channel and behaviour.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoUpdateSettings {
    pub enabled: bool,
    /// `"stable"`, `"beta"`, or `"nightly"`.
    pub channel: String,
}

/// What the app does on startup.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupBehavior {
    /// Re-open the last session (last open profile + last navigated path).
    pub restore_session: bool,
    /// Override the initial navigation target (`"s3://bucket/prefix"` or a
    /// profile name).  `None` means "last location" when `restore_session` is
    /// true, or the bucket list when false.
    pub open_to: Option<String>,
}

/// HTTP proxy mode.
///
/// Matches the shape of `s3::client::ProxyConfig` so the two can be converted
/// without a full S3 client dependency cycle.  Task 7's `ProxyConfig` and this
/// enum are intentionally isomorphic — callers in `s3::client` convert via
/// `From<ProxyMode>`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum ProxyMode {
    /// Inherit proxy from environment variables (`HTTP_PROXY`, `HTTPS_PROXY`,
    /// `NO_PROXY`).  This is the v1 default.
    #[default]
    System,
    /// Route all traffic through the given URL.
    Explicit { url: String },
    /// Disable proxy entirely, ignoring environment variables.
    None,
}

// ---------------------------------------------------------------------------
// Settings root struct
// ---------------------------------------------------------------------------

/// All application settings, versioned and forward-compatible.
///
/// Defaults are in `defaults.rs`; this struct must never hard-code a default
/// inline — use `Settings::default()` as the canonical factory.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Schema version; currently always `1`.
    pub schema_version: u32,

    // --- storage / transfer ---
    /// Default download directory.  `None` means "resolve from
    /// `tauri::api::path::download_dir()` at runtime".
    pub download_dir: Option<PathBuf>,
    /// Maximum number of concurrent S3 object transfers.
    pub transfer_concurrency: u32,

    // --- cache ---
    /// Listing cache TTL in seconds.
    pub cache_ttl_secs: u64,
    /// Maximum in-memory cache size in MiB.
    pub cache_size_cap_mb: u64,

    // --- preview ---
    /// Files larger than this (MiB) show a warning before preview.
    pub preview_size_limit_mb: u64,

    // --- view ---
    /// Default view mode: `"Details"`, `"Icons"`, `"Gallery"`, `"Tree"`,
    /// `"FlatKey"`, `"Column"`, or `"DualPane"`.
    pub default_view_mode: String,

    // --- notifications ---
    pub notifications: NotificationSettings,

    // --- cross-account fallback ---
    /// Objects up to this size (MiB) auto-fall back on cross-account ops;
    /// larger objects require confirmation.
    pub fallback_threshold_mb: u64,

    // --- transfer confirmations ---
    pub transfer_confirmations: TransferConfirmations,

    // --- S3-compatible endpoint registry ---
    pub s3_compatible_endpoints: Vec<S3CompatibleEndpoint>,

    // --- auto-update ---
    pub auto_update: AutoUpdateSettings,

    // --- diagnostics ---
    /// Enable local log/exception collection.
    /// Collection is always user-initiated; nothing is ever auto-uploaded.
    pub diagnostics_enabled: bool,

    // --- startup ---
    pub startup_behavior: StartupBehavior,

    // --- proxy ---
    pub proxy: ProxyMode,

    // --- appearance ---
    /// `"light"`, `"dark"`, or `"system"`.
    pub theme: String,

    // --- keyboard shortcuts ---
    /// Sparse map of user-overridden shortcuts.  Keys are action identifiers
    /// (e.g. `"navigate.up"`); values are key-combo strings (e.g. `"Alt+Up"`).
    /// The frontend baseline shortcut map is canonical and is NOT stored here;
    /// only user overrides are persisted (per Decision D3).
    pub keyboard_shortcuts: BTreeMap<String, String>,

    // --- forward-compat ---
    /// Absorbs any JSON keys not known to this schema version.  Round-tripped
    /// verbatim on save so future-app settings survive a downgrade.
    #[serde(flatten)]
    pub unknown: BTreeMap<String, Value>,
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

impl Settings {
    /// Load settings from `path`.
    ///
    /// Returns `Settings::default()` when the file does not exist.
    /// Returns an `AppError::Internal` if the file exists but cannot be read
    /// or parsed.
    pub async fn load(path: &Path) -> Result<Self, AppError> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let raw = tokio::fs::read_to_string(path)
            .await
            .map_err(|e| AppError::Internal {
                trace_id: format!("settings_load_read: {e}"),
            })?;
        serde_json::from_str(&raw).map_err(|e| AppError::Internal {
            trace_id: format!("settings_load_parse: {e}"),
        })
    }

    /// Synchronous variant of `load` for use in contexts where async is
    /// unavailable (e.g. the Tauri `setup` callback, which is synchronous).
    ///
    /// Returns `Settings::default()` when the file does not exist.
    pub fn load_sync(path: &Path) -> Self {
        if !path.exists() {
            return Self::default();
        }
        std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    /// Persist settings to `path` atomically (write to `<path>.tmp`, then
    /// rename), so a crash during write cannot corrupt the stored settings.
    pub async fn save(&self, path: &Path) -> Result<(), AppError> {
        let json = serde_json::to_string_pretty(self).map_err(|e| AppError::Internal {
            trace_id: format!("settings_save_serialize: {e}"),
        })?;

        // Ensure the parent directory exists.
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| AppError::Internal {
                    trace_id: format!("settings_save_mkdir: {e}"),
                })?;
        }

        let tmp_path = path.with_extension("json.tmp");
        tokio::fs::write(&tmp_path, json.as_bytes())
            .await
            .map_err(|e| AppError::Internal {
                trace_id: format!("settings_save_write: {e}"),
            })?;
        tokio::fs::rename(&tmp_path, path)
            .await
            .map_err(|e| AppError::Internal {
                trace_id: format!("settings_save_rename: {e}"),
            })?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// SettingsHandle — shared mutable state for Tauri managed state
// ---------------------------------------------------------------------------

/// Newtype around `Arc<Mutex<Settings>>` used as Tauri managed state.
///
/// Commands receive `tauri::State<SettingsHandle>` and lock the inner mutex
/// for the duration of the read or write.
#[derive(Clone)]
pub struct SettingsHandle {
    pub inner: Arc<Mutex<Settings>>,
    /// Path to `settings.json`; stored so commands can call `save()`.
    pub path: PathBuf,
}

impl SettingsHandle {
    pub fn new(settings: Settings, path: PathBuf) -> Self {
        Self {
            inner: Arc::new(Mutex::new(settings)),
            path,
        }
    }
}

// ---------------------------------------------------------------------------
// From<ProxyMode> for s3::client::ProxyConfig
// ---------------------------------------------------------------------------

impl From<ProxyMode> for crate::s3::client::ProxyConfig {
    fn from(mode: ProxyMode) -> Self {
        match mode {
            ProxyMode::System => crate::s3::client::ProxyConfig::System,
            ProxyMode::Explicit { url } => crate::s3::client::ProxyConfig::Explicit(url),
            ProxyMode::None => crate::s3::client::ProxyConfig::None,
        }
    }
}

// ---------------------------------------------------------------------------
// Patch validation — also used by settings_cmd
// ---------------------------------------------------------------------------

/// Validate a JSON patch object before applying it to `Settings`.
///
/// Returns `AppError::Validation` if the patch violates any constraint.
/// This is the single validation gate; `settings_update` calls it before
/// merging and persisting.
pub fn validate_patch(patch: &Value) -> Result<(), AppError> {
    if let Some(tc) = patch.get("transferConcurrency") {
        let v = tc.as_u64().unwrap_or(0);
        if v == 0 {
            return Err(AppError::Validation {
                field: "transferConcurrency".to_string(),
                hint: "must be at least 1".to_string(),
            });
        }
    }
    if let Some(ttl) = patch.get("cacheTtlSecs") {
        if ttl.as_u64().is_none() {
            return Err(AppError::Validation {
                field: "cacheTtlSecs".to_string(),
                hint: "must be a non-negative integer".to_string(),
            });
        }
    }
    if let Some(lim) = patch.get("previewSizeLimitMb") {
        if lim.as_u64().is_none() {
            return Err(AppError::Validation {
                field: "previewSizeLimitMb".to_string(),
                hint: "must be a non-negative integer".to_string(),
            });
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // (1) Every v1 default from proposal lines 190-206 is codified correctly.
    #[test]
    fn defaults_match_proposal() {
        let s = Settings::default();

        assert_eq!(s.schema_version, 1, "schema_version");
        assert_eq!(s.download_dir, None, "download_dir");
        assert_eq!(s.transfer_concurrency, 4, "transfer_concurrency");
        assert_eq!(s.cache_ttl_secs, 30, "cache_ttl_secs");
        assert_eq!(s.cache_size_cap_mb, 256, "cache_size_cap_mb");
        assert_eq!(s.preview_size_limit_mb, 50, "preview_size_limit_mb");
        assert_eq!(s.default_view_mode, "Details", "default_view_mode");

        assert!(s.notifications.in_app, "notifications.in_app");
        assert!(s.notifications.os_enabled, "notifications.os_enabled");
        assert!(!s.notifications.sound, "notifications.sound");

        assert_eq!(s.fallback_threshold_mb, 100, "fallback_threshold_mb");

        assert!(
            s.transfer_confirmations.delete,
            "transfer_confirmations.delete"
        );
        assert!(
            s.transfer_confirmations.overwrite,
            "transfer_confirmations.overwrite"
        );
        assert_eq!(
            s.transfer_confirmations.large_upload_mb, 500,
            "transfer_confirmations.large_upload_mb"
        );

        assert!(
            s.s3_compatible_endpoints.is_empty(),
            "s3_compatible_endpoints"
        );

        assert!(s.auto_update.enabled, "auto_update.enabled");
        assert_eq!(s.auto_update.channel, "stable", "auto_update.channel");

        assert!(s.diagnostics_enabled, "diagnostics_enabled");

        assert!(
            s.startup_behavior.restore_session,
            "startup_behavior.restore_session"
        );
        assert_eq!(s.startup_behavior.open_to, None, "startup_behavior.open_to");

        assert_eq!(s.proxy, ProxyMode::System, "proxy");
        assert_eq!(s.theme, "system", "theme");
        assert!(s.keyboard_shortcuts.is_empty(), "keyboard_shortcuts");
    }

    // (2) Round-trip: serialize → parse → assert equality.
    #[test]
    fn round_trip_defaults() {
        let original = Settings::default();
        let json = serde_json::to_string(&original).expect("serialize");
        let restored: Settings = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(
            original, restored,
            "round-trip must produce identical Settings"
        );
    }

    // (3) Unknown keys are preserved on round-trip.
    #[test]
    fn unknown_keys_preserved() {
        let input = json!({
            "schemaVersion": 1,
            "transferConcurrency": 4,
            "cacheTtlSecs": 30,
            "cacheSizeCapMb": 256,
            "previewSizeLimitMb": 50,
            "defaultViewMode": "Details",
            "notifications": {
                "inApp": true,
                "osEnabled": true,
                "sound": false
            },
            "fallbackThresholdMb": 100,
            "transferConfirmations": {
                "delete": true,
                "overwrite": true,
                "largeUploadMb": 500
            },
            "s3CompatibleEndpoints": [],
            "autoUpdate": {
                "enabled": true,
                "channel": "stable"
            },
            "diagnosticsEnabled": true,
            "startupBehavior": {
                "restoreSession": true,
                "openTo": null
            },
            "proxy": { "mode": "system" },
            "theme": "system",
            "keyboardShortcuts": {},
            // future key unknown to this schema version
            "futureFlag": true,
            "experimentalBatch": { "size": 100 }
        });

        let settings: Settings =
            serde_json::from_value(input).expect("deserialize with unknown keys");

        // The unknown keys must survive serialization.
        let out = serde_json::to_value(&settings).expect("serialize");

        assert_eq!(
            out["futureFlag"],
            json!(true),
            "futureFlag must be preserved"
        );
        assert_eq!(
            out["experimentalBatch"]["size"],
            json!(100),
            "experimentalBatch must be preserved"
        );
    }

    // (4) settings_update validation: transfer_concurrency = 0 is rejected.
    // This tests the validation helper used by the command.
    #[test]
    fn validate_transfer_concurrency_zero() {
        let patch = json!({ "transferConcurrency": 0 });
        let result = validate_patch(&patch);
        assert!(
            result.is_err(),
            "transferConcurrency=0 must produce a validation error"
        );
        if let Err(AppError::Validation { field, .. }) = result {
            assert_eq!(field, "transferConcurrency");
        } else {
            panic!("expected AppError::Validation");
        }
    }

    // (5) Valid patch passes validation.
    #[test]
    fn validate_patch_valid() {
        let patch = json!({ "transferConcurrency": 8 });
        assert!(validate_patch(&patch).is_ok());
    }
}
