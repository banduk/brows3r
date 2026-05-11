//! Diagnostic bundle collection and ZIP export.
//!
//! `collect_bundle` gathers relevant files, applies redaction to every text
//! file, compresses them into a ZIP, and returns a `BundleRef` that the
//! caller can pass to `export_bundle` to move the ZIP to a user-chosen path.
//!
//! # OCP
//!
//! - `BundleConfig` is open for new fields (e.g. `include_perf_traces`).
//! - Bundle composition is one function — extending content sources is one
//!   new branch in `collect_bundle`.
//! - Redaction is applied once per file before zipping — no leak path.

use std::io::Write as _;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::diagnostics::redact::{RedactionLevel, Redactor};
use crate::error::AppError;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Which files / data categories to include in the bundle.
///
/// All `include_*` fields default to `true` so a zero-argument `Default::default()`
/// produces the most complete bundle.  The caller (UI) exposes per-toggle controls
/// mapped 1-to-1 to these fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleConfig {
    /// Include the recent-errors log buffer.
    pub include_recent_errors: bool,
    /// How aggressively to redact credentials and paths.
    pub redaction_level: RedactionLevel,
    /// Include the app notification log dump.
    pub include_logs: bool,
    /// Include `settings.json` (secrets are never in settings; safe to include).
    pub include_settings: bool,
    /// Include `profiles.json` metadata **without** secrets (enforced by serde
    /// skip annotations on the secret fields at the data-model layer).
    pub include_profiles_metadata: bool,
}

impl Default for BundleConfig {
    fn default() -> Self {
        Self {
            include_recent_errors: true,
            redaction_level: RedactionLevel::Full,
            include_logs: true,
            include_settings: true,
            include_profiles_metadata: true,
        }
    }
}

/// Reference to a collected (but not yet exported) bundle.
///
/// The frontend holds this value between the "Generate" and "Save" steps.
/// `path` points to the ZIP inside the app's cache dir.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleRef {
    /// Unique identifier for this collection run (UUID v4).
    pub id: String,
    /// Absolute path to the ZIP file on disk.
    pub path: PathBuf,
    /// Size of the ZIP in bytes.
    pub size_bytes: u64,
    /// Whether redaction was applied (i.e. `redaction_level != None`).
    pub redaction_applied: bool,
}

/// Resolved file-system paths used by the bundle collector.
///
/// Constructed from a Tauri `AppHandle` in the command handler so the
/// core collection logic stays testable without a Tauri runtime.
pub struct AppPaths {
    /// `${app_config_dir}` — contains `settings.json`, `profiles.json`.
    pub app_config_dir: PathBuf,
    /// `${app_log_dir}` — contains log files written by the app.
    pub app_log_dir: PathBuf,
    /// `${app_cache_dir}` — where temporary bundle directories are created.
    pub app_cache_dir: PathBuf,
}

// ---------------------------------------------------------------------------
// Bundle collection
// ---------------------------------------------------------------------------

/// Collect diagnostic files, redact them, zip them, and return a `BundleRef`.
///
/// Creates a temp dir at `${app_cache_dir}/diagnostics/<uuid>/` and writes
/// `bundle.zip` there.  The caller is responsible for eventually cleaning up
/// the temp dir (via `export_bundle` or explicit cleanup).
pub fn collect_bundle(
    config: &BundleConfig,
    app_paths: &AppPaths,
    redactor: &Redactor,
) -> Result<BundleRef, AppError> {
    let bundle_id = uuid::Uuid::new_v4().to_string();

    // Create the per-run temp directory.
    let temp_dir = app_paths.app_cache_dir.join("diagnostics").join(&bundle_id);
    std::fs::create_dir_all(&temp_dir).map_err(|_| AppError::internal_new())?;

    let zip_path = temp_dir.join("bundle.zip");
    let zip_file = std::fs::File::create(&zip_path).map_err(|_| AppError::internal_new())?;
    let mut zip = zip::ZipWriter::new(zip_file);

    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    // ------------------------------------------------------------------
    // settings.json
    // ------------------------------------------------------------------
    if config.include_settings {
        let src = app_paths.app_config_dir.join("settings.json");
        add_text_file_to_zip(&mut zip, &src, "settings.json", options, redactor)?;
    }

    // ------------------------------------------------------------------
    // profiles.json (metadata only — secrets skipped by serde skip attrs)
    // ------------------------------------------------------------------
    if config.include_profiles_metadata {
        let src = app_paths.app_config_dir.join("profiles.json");
        add_text_file_to_zip(&mut zip, &src, "profiles.json", options, redactor)?;
    }

    // ------------------------------------------------------------------
    // Notification log dump (brows3r.log or similar in log dir)
    // ------------------------------------------------------------------
    if config.include_logs {
        // Include all *.log files found in app_log_dir (non-recursive).
        if let Ok(entries) = std::fs::read_dir(&app_paths.app_log_dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.extension().and_then(|e| e.to_str()) == Some("log") {
                    let name = p
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("app.log")
                        .to_owned();
                    add_text_file_to_zip(&mut zip, &p, &name, options, redactor)?;
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Recent-error buffer (a synthetic errors.json in the log dir)
    // ------------------------------------------------------------------
    if config.include_recent_errors {
        let src = app_paths.app_log_dir.join("errors.json");
        add_text_file_to_zip(&mut zip, &src, "errors.json", options, redactor)?;
    }

    zip.finish().map_err(|_| AppError::internal_new())?;

    let size_bytes = std::fs::metadata(&zip_path).map(|m| m.len()).unwrap_or(0);

    Ok(BundleRef {
        id: bundle_id,
        path: zip_path,
        size_bytes,
        redaction_applied: config.redaction_level != RedactionLevel::None,
    })
}

// ---------------------------------------------------------------------------
// Bundle export
// ---------------------------------------------------------------------------

/// Copy (and then clean up) the collected ZIP to a user-chosen destination.
///
/// After a successful copy the temp directory is removed.  On failure the
/// temp dir is left in place so the user can retry without re-collecting.
pub fn export_bundle(bundle_ref: &BundleRef, dest_path: &Path) -> Result<(), AppError> {
    // Verify the bundle still exists.
    if !bundle_ref.path.exists() {
        return Err(AppError::NotFound {
            resource: bundle_ref.path.display().to_string(),
        });
    }

    // Ensure destination parent directory exists.
    if let Some(parent) = dest_path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|_| AppError::internal_new())?;
        }
    }

    // Copy ZIP to the user destination.
    std::fs::copy(&bundle_ref.path, dest_path).map_err(|_| AppError::internal_new())?;

    // Clean up the temp dir (best-effort — failure is not an error for the user).
    if let Some(temp_dir) = bundle_ref.path.parent() {
        let _ = std::fs::remove_dir_all(temp_dir);
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/// Read a file as UTF-8 text, apply redaction, and write it into the ZIP.
///
/// If the source file does not exist the entry is silently skipped (the file
/// may be absent in a fresh install or on a sandboxed filesystem).
fn add_text_file_to_zip<W: std::io::Write + std::io::Seek>(
    zip: &mut zip::ZipWriter<W>,
    src: &Path,
    entry_name: &str,
    options: zip::write::SimpleFileOptions,
    redactor: &Redactor,
) -> Result<(), AppError> {
    let raw = match std::fs::read_to_string(src) {
        Ok(s) => s,
        Err(_) => return Ok(()), // file absent → silently skip
    };

    let redacted = redactor.redact_text(&raw);

    zip.start_file(entry_name, options)
        .map_err(|_| AppError::internal_new())?;
    zip.write_all(redacted.as_bytes())
        .map_err(|_| AppError::internal_new())?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn make_paths(root: &Path) -> AppPaths {
        AppPaths {
            app_config_dir: root.join("config"),
            app_log_dir: root.join("logs"),
            app_cache_dir: root.join("cache"),
        }
    }

    fn make_redactor() -> Redactor {
        Redactor::new()
    }

    // -------------------------------------------------------------------------
    // collect_bundle writes a ZIP with expected entries
    // -------------------------------------------------------------------------

    #[test]
    fn collect_bundle_produces_zip_with_expected_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        let config_dir = root.join("config");
        let log_dir = root.join("logs");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(&log_dir).unwrap();

        // Write synthetic source files.
        std::fs::write(config_dir.join("settings.json"), r#"{"schemaVersion":1}"#).unwrap();
        std::fs::write(config_dir.join("profiles.json"), r#"[]"#).unwrap();
        std::fs::write(log_dir.join("brows3r.log"), "info: app started\n").unwrap();
        std::fs::write(log_dir.join("errors.json"), "[]").unwrap();

        let paths = make_paths(root);
        let config = BundleConfig::default();
        let redactor = make_redactor();

        let bundle_ref = collect_bundle(&config, &paths, &redactor).unwrap();

        // Zip must exist and be non-empty.
        assert!(
            bundle_ref.path.exists(),
            "zip should exist at {:?}",
            bundle_ref.path
        );
        assert!(bundle_ref.size_bytes > 0, "zip should not be empty");
        assert!(
            bundle_ref.redaction_applied,
            "Full level → redaction_applied=true"
        );

        // Open the ZIP and verify all expected entry names are present.
        let zip_file = std::fs::File::open(&bundle_ref.path).unwrap();
        let mut archive = zip::ZipArchive::new(zip_file).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_owned())
            .collect();

        assert!(
            names.contains(&"settings.json".to_owned()),
            "zip must contain settings.json; got {names:?}"
        );
        assert!(
            names.contains(&"profiles.json".to_owned()),
            "zip must contain profiles.json; got {names:?}"
        );
        assert!(
            names.contains(&"brows3r.log".to_owned()),
            "zip must contain brows3r.log; got {names:?}"
        );
        assert!(
            names.contains(&"errors.json".to_owned()),
            "zip must contain errors.json; got {names:?}"
        );
    }

    // -------------------------------------------------------------------------
    // Integration: redaction applied to every included file
    // -------------------------------------------------------------------------

    #[test]
    fn collect_bundle_redacts_credential_in_log_file() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        let config_dir = root.join("config");
        let log_dir = root.join("logs");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(&log_dir).unwrap();

        // Place an AWS access key ID inside the log file (uses the
        // aws_key_id.positive.txt content from the task-59 fixture).
        let raw_key = "AKIAIOSFODNN7EXAMPLE";
        std::fs::write(
            log_dir.join("brows3r.log"),
            format!("Found {raw_key} in the logs\n"),
        )
        .unwrap();
        // Empty required files so collect_bundle doesn't bail on missing them.
        std::fs::write(config_dir.join("settings.json"), "{}").unwrap();
        std::fs::write(config_dir.join("profiles.json"), "[]").unwrap();
        std::fs::write(log_dir.join("errors.json"), "[]").unwrap();

        let paths = make_paths(root);
        let config = BundleConfig::default();
        let redactor = make_redactor();

        let bundle_ref = collect_bundle(&config, &paths, &redactor).unwrap();

        // Extract `brows3r.log` from the ZIP and assert the raw key is gone.
        let zip_file = std::fs::File::open(&bundle_ref.path).unwrap();
        let mut archive = zip::ZipArchive::new(zip_file).unwrap();
        let mut log_entry = archive.by_name("brows3r.log").unwrap();
        let mut content = String::new();
        std::io::Read::read_to_string(&mut log_entry, &mut content).unwrap();

        assert!(
            content.contains("<REDACTED:AWS_KEY_ID>"),
            "redacted marker must be present; got: {content}"
        );
        assert!(
            !content.contains(raw_key),
            "raw key must not appear in the zip entry; got: {content}"
        );
    }

    // -------------------------------------------------------------------------
    // export_bundle moves the ZIP to dest
    // -------------------------------------------------------------------------

    #[test]
    fn export_bundle_copies_zip_to_destination() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let config_dir = root.join("config");
        let log_dir = root.join("logs");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::write(config_dir.join("settings.json"), "{}").unwrap();
        std::fs::write(config_dir.join("profiles.json"), "[]").unwrap();

        let paths = make_paths(root);
        let config = BundleConfig::default();
        let redactor = make_redactor();

        let bundle_ref = collect_bundle(&config, &paths, &redactor).unwrap();
        let dest = root.join("output").join("my-bundle.zip");

        export_bundle(&bundle_ref, &dest).unwrap();

        assert!(dest.exists(), "zip should exist at destination");
    }

    // -------------------------------------------------------------------------
    // collect_bundle with RedactionLevel::None does not redact
    // -------------------------------------------------------------------------

    #[test]
    fn collect_bundle_with_none_level_does_not_redact() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let config_dir = root.join("config");
        let log_dir = root.join("logs");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(&log_dir).unwrap();

        let raw_key = "AKIAIOSFODNN7EXAMPLE";
        std::fs::write(log_dir.join("brows3r.log"), format!("key: {raw_key}\n")).unwrap();
        std::fs::write(config_dir.join("settings.json"), "{}").unwrap();
        std::fs::write(config_dir.join("profiles.json"), "[]").unwrap();

        let paths = make_paths(root);
        let config = BundleConfig {
            redaction_level: RedactionLevel::None,
            ..BundleConfig::default()
        };
        let redactor = Redactor::with_level(RedactionLevel::None);

        let bundle_ref = collect_bundle(&config, &paths, &redactor).unwrap();
        assert!(!bundle_ref.redaction_applied);

        let zip_file = std::fs::File::open(&bundle_ref.path).unwrap();
        let mut archive = zip::ZipArchive::new(zip_file).unwrap();
        let mut log_entry = archive.by_name("brows3r.log").unwrap();
        let mut content = String::new();
        std::io::Read::read_to_string(&mut log_entry, &mut content).unwrap();

        assert!(
            content.contains(raw_key),
            "None level must not redact; got: {content}"
        );
    }

    // -------------------------------------------------------------------------
    // collect_bundle respects include_settings=false
    // -------------------------------------------------------------------------

    #[test]
    fn collect_bundle_respects_include_settings_false() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let config_dir = root.join("config");
        let log_dir = root.join("logs");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::write(config_dir.join("settings.json"), "{}").unwrap();
        std::fs::write(config_dir.join("profiles.json"), "[]").unwrap();

        let paths = make_paths(root);
        let config = BundleConfig {
            include_settings: false,
            ..BundleConfig::default()
        };
        let redactor = make_redactor();

        let bundle_ref = collect_bundle(&config, &paths, &redactor).unwrap();

        let zip_file = std::fs::File::open(&bundle_ref.path).unwrap();
        let mut archive = zip::ZipArchive::new(zip_file).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_owned())
            .collect();
        assert!(
            !names.contains(&"settings.json".to_owned()),
            "settings.json must be absent when include_settings=false; got {names:?}"
        );
    }
}
