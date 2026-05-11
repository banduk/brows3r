//! `Default` implementation for `Settings`.
//!
//! This file is the single source of truth for every v1 default from the
//! proposal (lines 190-206).  Other modules that need a default value must
//! read it from `Settings::default()` — never hard-code it inline.

use std::collections::BTreeMap;

use super::{
    AutoUpdateSettings, NotificationSettings, ProxyMode, Settings, StartupBehavior,
    TransferConfirmations,
};

impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: 1,
            // --- storage / transfer ---
            download_dir: None, // resolved at runtime via tauri::api::path::download_dir()
            transfer_concurrency: 4,
            // --- cache ---
            cache_ttl_secs: 30,
            cache_size_cap_mb: 256,
            // --- preview ---
            preview_size_limit_mb: 50,
            // --- view ---
            default_view_mode: "Details".to_string(),
            // --- notifications ---
            notifications: NotificationSettings {
                in_app: true,
                os_enabled: true,
                sound: false,
            },
            // --- cross-account fallback ---
            fallback_threshold_mb: 100,
            // --- transfer confirmations ---
            transfer_confirmations: TransferConfirmations {
                delete: true,
                overwrite: true,
                large_upload_mb: 500,
            },
            // --- S3-compatible endpoints registry ---
            s3_compatible_endpoints: Vec::new(),
            // --- auto-update ---
            auto_update: AutoUpdateSettings {
                enabled: true,
                channel: "stable".to_string(),
            },
            // --- diagnostics ---
            // Collection is on; export is always user-triggered (never auto-uploaded).
            diagnostics_enabled: true,
            // --- startup ---
            startup_behavior: StartupBehavior {
                restore_session: true,
                open_to: None,
            },
            // --- proxy ---
            proxy: ProxyMode::System,
            // --- appearance ---
            theme: "system".to_string(),
            // --- keyboard shortcuts ---
            // Backend stores user overrides only (sparse delta); the frontend
            // baseline is canonical and ships with the app (task 16 fixture).
            keyboard_shortcuts: BTreeMap::new(),
            // --- forward-compat ---
            unknown: BTreeMap::new(),
        }
    }
}
