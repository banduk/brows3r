//! AWS credentials and config file parser.
//!
//! Parses `~/.aws/credentials` and `~/.aws/config` into a flat list of
//! [`AwsConfigEntry`] values without resolving or validating credentials.
//!
//! # Security contract
//!
//! `access_key_id`, `secret_access_key`, and `session_token` are:
//! - Declared `pub(crate)` — not accessible outside this crate.
//! - Annotated `#[serde(skip_serializing)]` — they can never be emitted
//!   through Tauri's IPC boundary, even by accident.
//!
//! # OCP contract
//!
//! - [`AwsConfigSource`] is open for new variants (`Sso`, `WebIdentity`,
//!   `EcsContainer`, …) without touching existing arms.
//! - [`parse_aws_config_files`] takes explicit `&Path` arguments so every
//!   parsing behavior is unit-testable against fixture files without hitting
//!   the real filesystem.
//! - [`discover_aws_profiles`] is the thin wrapper that resolves `~/.aws/*`
//!   and delegates to the pure function.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use ini::Ini;
use serde::{Deserialize, Serialize};

use crate::error::AppError;

// ---------------------------------------------------------------------------
// AwsConfigSource
// ---------------------------------------------------------------------------

/// Where a profile's configuration was read from.
///
/// Open for extension: new sources (`Sso`, `WebIdentity`, `EcsContainer`, …)
/// can be added as new variants without modifying existing arms.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AwsConfigSource {
    /// Profile read from `~/.aws/credentials`.
    Credentials,
    /// Profile read from `~/.aws/config`.
    Config,
    /// Synthetic profile built from environment variables (AWS_ACCESS_KEY_ID, etc.).
    Env,
}

// ---------------------------------------------------------------------------
// ProfileChainRef
// ---------------------------------------------------------------------------

/// Role-chaining metadata surfaced when `role_arn` is present on a profile.
///
/// Used by the profile-validation layer (task 12+) to decide whether
/// interactive MFA or SSO prompts are needed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileChainRef {
    /// The named profile whose credentials are used to assume the role.
    pub source_profile: String,
    /// ARN of the IAM role to assume.
    pub role_arn: String,
    /// ARN of the MFA device required before assuming the role, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mfa_serial: Option<String>,
    /// Name of the SSO session block in `~/.aws/config`, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sso_session: Option<String>,
}

// ---------------------------------------------------------------------------
// AwsConfigEntry
// ---------------------------------------------------------------------------

/// A single AWS profile as parsed from credentials / config files or env vars.
///
/// # IPC safety
///
/// The three secret fields (`access_key_id`, `secret_access_key`,
/// `session_token`) are intentionally:
/// - `pub(crate)` — not visible outside this crate.
/// - `#[serde(skip_serializing)]` — never emitted by `serde_json::to_*`.
///
/// This means tests may inspect the fields directly, but no Tauri command can
/// inadvertently leak credentials through the IPC boundary.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsConfigEntry {
    /// The profile name as it appears in the config files (e.g. `"default"`, `"dev"`).
    pub profile_name: String,

    /// Which file (or env) this entry originated from.
    pub source: AwsConfigSource,

    // ------------------------------------------------------------------
    // Secret fields — never serialized through IPC
    //
    // These fields are populated by the parser so tests can verify secrets
    // were *read correctly* from disk, but the production credential flow
    // ignores them entirely (the AWS SDK credential-provider chain is the
    // canonical path for real credentials, not these fields). Hence the
    // `#[allow(dead_code)]` — the lack of read sites is intentional.
    // ------------------------------------------------------------------
    /// AWS access key ID. Parsed internally; never emitted over IPC.
    #[serde(skip_serializing)]
    #[allow(dead_code)]
    pub(crate) access_key_id: Option<String>,

    /// AWS secret access key. Parsed internally; never emitted over IPC.
    #[serde(skip_serializing)]
    #[allow(dead_code)]
    pub(crate) secret_access_key: Option<String>,

    /// AWS session token (for temporary credentials). Never emitted over IPC.
    #[serde(skip_serializing)]
    #[allow(dead_code)]
    pub(crate) session_token: Option<String>,

    // ------------------------------------------------------------------
    // Non-secret metadata fields
    // ------------------------------------------------------------------
    /// AWS region (e.g. `"us-east-1"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,

    /// Named profile whose credentials are delegated to (role chaining).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_profile: Option<String>,

    /// IAM role ARN to assume.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role_arn: Option<String>,

    /// MFA device serial ARN required before assuming the role.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mfa_serial: Option<String>,

    /// SSO session block name in `~/.aws/config`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sso_session: Option<String>,

    /// Role-chaining reference, populated when `role_arn` is present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chain_ref: Option<ProfileChainRef>,
}

// ---------------------------------------------------------------------------
// INI parsing helpers
// ---------------------------------------------------------------------------

/// Strip the `profile ` prefix that `~/.aws/config` uses for non-default sections.
///
/// ```text
/// [profile dev]  →  "dev"
/// [default]      →  "default"
/// ```
fn strip_config_prefix(section: &str) -> &str {
    section.strip_prefix("profile ").unwrap_or(section)
}

/// Parse an INI file at `path`, returning a `HashMap<section_name, key_values>`.
/// Returns an empty map (not an error) when the file does not exist.
fn parse_ini_file(path: &Path) -> Result<HashMap<String, HashMap<String, String>>, AppError> {
    if !path.exists() {
        return Ok(HashMap::new());
    }

    let ini = Ini::load_from_file(path).map_err(|e| AppError::Internal {
        trace_id: format!("parse_ini_file: {}: {}", path.display(), e),
    })?;

    let mut result: HashMap<String, HashMap<String, String>> = HashMap::new();

    for (section, props) in &ini {
        let name = match section {
            Some(s) => s.to_string(),
            // The `rust-ini` crate surfaces top-level (headerless) keys under
            // `None`. We skip them — AWS config files always use sections.
            None => continue,
        };

        let entry = result.entry(name).or_default();
        for (k, v) in props.iter() {
            entry.insert(k.to_string(), v.to_string());
        }
    }

    Ok(result)
}

// ---------------------------------------------------------------------------
// parse_aws_config_files — pure, testable
// ---------------------------------------------------------------------------

/// Parse explicit credentials and config file paths into a list of AWS profiles.
///
/// This is the pure, testable surface. Pass fixture paths in tests; use
/// [`discover_aws_profiles`] in production to resolve the real `~/.aws/*` paths.
///
/// Merge rules:
/// - Each unique profile name yields one `AwsConfigEntry`.
/// - Secret fields (`access_key_id`, `secret_access_key`, `session_token`)
///   always come from the credentials file.
/// - Non-secret fields (`region`, `role_arn`, `source_profile`, …) come from
///   the config file when present, falling back to the credentials file.
/// - `source` is `Credentials` when only the credentials file has the profile,
///   `Config` when only the config file has it, and `Credentials` (primary)
///   when both files contribute fields (secrets always come from credentials).
///
/// Environment variable injection is handled by [`discover_aws_profiles`] so
/// this function remains pure and does not read `std::env`.
pub fn parse_aws_config_files(
    creds_path: &Path,
    config_path: &Path,
) -> Result<Vec<AwsConfigEntry>, AppError> {
    let creds_sections = parse_ini_file(creds_path)?;
    let config_sections_raw = parse_ini_file(config_path)?;

    // Normalize config section names: strip the "profile " prefix.
    let config_sections: HashMap<String, HashMap<String, String>> = config_sections_raw
        .into_iter()
        .map(|(k, v)| (strip_config_prefix(&k).to_string(), v))
        .collect();

    // Collect all profile names from both files.
    let mut all_names: Vec<String> = {
        let mut names: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        for name in creds_sections.keys() {
            names.insert(name.clone());
        }
        for name in config_sections.keys() {
            names.insert(name.clone());
        }
        names.into_iter().collect()
    };
    // Ensure "default" is first if present.
    if let Some(pos) = all_names.iter().position(|n| n == "default") {
        all_names.remove(pos);
        all_names.insert(0, "default".to_string());
    }

    let mut entries: Vec<AwsConfigEntry> = Vec::with_capacity(all_names.len());

    for name in all_names {
        let creds = creds_sections.get(&name);
        let config = config_sections.get(&name);

        // Determine source: prefer Credentials when secrets are present.
        let source = if creds.is_some() {
            AwsConfigSource::Credentials
        } else {
            AwsConfigSource::Config
        };

        // Secret fields come exclusively from credentials file.
        let access_key_id = creds.and_then(|m| m.get("aws_access_key_id").cloned());
        let secret_access_key = creds.and_then(|m| m.get("aws_secret_access_key").cloned());
        let session_token = creds.and_then(|m| m.get("aws_session_token").cloned());

        // Non-secret fields: config file takes precedence.
        let region = config
            .and_then(|m| m.get("region").cloned())
            .or_else(|| creds.and_then(|m| m.get("region").cloned()));

        let source_profile = config
            .and_then(|m| m.get("source_profile").cloned())
            .or_else(|| creds.and_then(|m| m.get("source_profile").cloned()));

        let role_arn = config
            .and_then(|m| m.get("role_arn").cloned())
            .or_else(|| creds.and_then(|m| m.get("role_arn").cloned()));

        let mfa_serial = config
            .and_then(|m| m.get("mfa_serial").cloned())
            .or_else(|| creds.and_then(|m| m.get("mfa_serial").cloned()));

        let sso_session = config
            .and_then(|m| m.get("sso_session").cloned())
            .or_else(|| creds.and_then(|m| m.get("sso_session").cloned()));

        // Build chain_ref when role_arn and source_profile are both present.
        let chain_ref = match (&role_arn, &source_profile) {
            (Some(arn), Some(src)) => Some(ProfileChainRef {
                source_profile: src.clone(),
                role_arn: arn.clone(),
                mfa_serial: mfa_serial.clone(),
                sso_session: sso_session.clone(),
            }),
            _ => None,
        };

        entries.push(AwsConfigEntry {
            profile_name: name,
            source,
            access_key_id,
            secret_access_key,
            session_token,
            region,
            source_profile,
            role_arn,
            mfa_serial,
            sso_session,
            chain_ref,
        });
    }

    Ok(entries)
}

// ---------------------------------------------------------------------------
// discover_aws_profiles — production entry point
// ---------------------------------------------------------------------------

/// Discover AWS profiles from the real `~/.aws/credentials` and `~/.aws/config`.
///
/// Adds a synthetic `env` profile when `AWS_ACCESS_KEY_ID` is set in the
/// environment (e.g. CI, container environments).  The env profile has
/// `source: AwsConfigSource::Env` and carries no persistent metadata.
pub async fn discover_aws_profiles() -> Result<Vec<AwsConfigEntry>, AppError> {
    let home = home_dir().ok_or_else(|| AppError::Internal {
        trace_id: "discover_aws_profiles: cannot resolve home directory".to_string(),
    })?;

    let creds_path = home.join(".aws").join("credentials");
    let config_path = home.join(".aws").join("config");

    let mut entries = parse_aws_config_files(&creds_path, &config_path)?;

    // Inject a synthetic env profile when AWS_ACCESS_KEY_ID is set.
    if let Ok(key_id) = std::env::var("AWS_ACCESS_KEY_ID") {
        let secret = std::env::var("AWS_SECRET_ACCESS_KEY").ok();
        let token = std::env::var("AWS_SESSION_TOKEN").ok();
        let region = std::env::var("AWS_DEFAULT_REGION")
            .ok()
            .or_else(|| std::env::var("AWS_REGION").ok());

        entries.insert(
            0,
            AwsConfigEntry {
                profile_name: "env".to_string(),
                source: AwsConfigSource::Env,
                access_key_id: Some(key_id),
                secret_access_key: secret,
                session_token: token,
                region,
                source_profile: None,
                role_arn: None,
                mfa_serial: None,
                sso_session: None,
                chain_ref: None,
            },
        );
    }

    Ok(entries)
}

/// Resolve the home directory.
///
/// Prefers `HOME` env var; falls back to `USERPROFILE` (Windows).
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(name: &str) -> PathBuf {
        // Cargo sets CARGO_MANIFEST_DIR to src-tauri/ during tests.
        let manifest = std::env::var("CARGO_MANIFEST_DIR")
            .expect("CARGO_MANIFEST_DIR must be set during cargo test");
        PathBuf::from(manifest)
            .join("tests")
            .join("fixtures")
            .join("aws_config")
            .join(name)
    }

    // ------------------------------------------------------------------
    // Basic fixture: one default + one named profile
    // ------------------------------------------------------------------

    #[test]
    fn basic_parses_two_profiles() {
        let entries =
            parse_aws_config_files(&fixture("basic.credentials"), &fixture("basic.config"))
                .expect("basic fixtures must parse");

        assert_eq!(entries.len(), 2, "expected default + dev");

        let default = entries
            .iter()
            .find(|e| e.profile_name == "default")
            .unwrap();
        assert_eq!(default.source, AwsConfigSource::Credentials);
        assert_eq!(default.region.as_deref(), Some("us-east-1"));
        // Secrets parsed but not serializable.
        assert_eq!(default.access_key_id.as_deref(), Some("AKIADEFAULTEXAMPLE"));

        let dev = entries.iter().find(|e| e.profile_name == "dev").unwrap();
        assert_eq!(dev.source, AwsConfigSource::Credentials);
        assert_eq!(dev.region.as_deref(), Some("eu-west-1"));
        assert_eq!(dev.access_key_id.as_deref(), Some("AKIADEVEXAMPLE00000"));
    }

    #[test]
    fn basic_default_is_first() {
        let entries =
            parse_aws_config_files(&fixture("basic.credentials"), &fixture("basic.config"))
                .expect("basic fixtures must parse");

        assert_eq!(entries[0].profile_name, "default");
    }

    // ------------------------------------------------------------------
    // Chained fixture: role_arn + source_profile + mfa_serial
    // ------------------------------------------------------------------

    #[test]
    fn chained_parses_assume_role_profile() {
        let entries =
            parse_aws_config_files(&fixture("chained.credentials"), &fixture("chained.config"))
                .expect("chained fixtures must parse");

        let role = entries
            .iter()
            .find(|e| e.profile_name == "assume-role")
            .expect("assume-role profile must be present");

        assert_eq!(
            role.source_profile.as_deref(),
            Some("base-user"),
            "source_profile must be base-user"
        );
        assert_eq!(
            role.role_arn.as_deref(),
            Some("arn:aws:iam::123456789012:role/MyRole"),
            "role_arn must be populated"
        );
        assert_eq!(
            role.mfa_serial.as_deref(),
            Some("arn:aws:iam::123456789012:mfa/my-user"),
            "mfa_serial must be populated"
        );
        assert_eq!(role.region.as_deref(), Some("us-west-2"));
    }

    #[test]
    fn chained_chain_ref_populated() {
        let entries =
            parse_aws_config_files(&fixture("chained.credentials"), &fixture("chained.config"))
                .expect("chained fixtures must parse");

        let role = entries
            .iter()
            .find(|e| e.profile_name == "assume-role")
            .unwrap();

        let chain = role.chain_ref.as_ref().expect("chain_ref must be present");
        assert_eq!(chain.source_profile, "base-user");
        assert_eq!(chain.role_arn, "arn:aws:iam::123456789012:role/MyRole");
        assert_eq!(
            chain.mfa_serial.as_deref(),
            Some("arn:aws:iam::123456789012:mfa/my-user")
        );
    }

    #[test]
    fn profile_without_role_arn_has_no_chain_ref() {
        let entries =
            parse_aws_config_files(&fixture("chained.credentials"), &fixture("chained.config"))
                .expect("chained fixtures must parse");

        let base = entries
            .iter()
            .find(|e| e.profile_name == "base-user")
            .unwrap();
        assert!(
            base.chain_ref.is_none(),
            "base-user has no role_arn so chain_ref must be None"
        );
    }

    // ------------------------------------------------------------------
    // Secrets-don't-leak: access_key_id not in JSON output
    // ------------------------------------------------------------------

    #[test]
    fn secret_fields_are_not_serialized() {
        let entries =
            parse_aws_config_files(&fixture("basic.credentials"), &fixture("basic.config"))
                .expect("basic fixtures must parse");

        let default = entries
            .iter()
            .find(|e| e.profile_name == "default")
            .unwrap();

        // access_key_id must be readable internally ...
        assert!(
            default.access_key_id.is_some(),
            "access_key_id must be parsed"
        );

        // ... but must NOT appear in the JSON output.
        let json = serde_json::to_value(default).expect("AwsConfigEntry must serialize");
        assert!(
            json.get("accessKeyId").is_none(),
            "accessKeyId must NOT appear in IPC JSON"
        );
        assert!(
            json.get("secretAccessKey").is_none(),
            "secretAccessKey must NOT appear in IPC JSON"
        );
        assert!(
            json.get("sessionToken").is_none(),
            "sessionToken must NOT appear in IPC JSON"
        );
    }

    // ------------------------------------------------------------------
    // Empty credentials file — config-only profiles
    // ------------------------------------------------------------------

    #[test]
    fn config_only_profile_source_is_config() {
        // Use env_only.credentials (empty) + chained.config to verify
        // that a profile only in the config file gets source = Config.
        let entries =
            parse_aws_config_files(&fixture("env_only.credentials"), &fixture("chained.config"))
                .expect("must parse");

        // All profiles come from config; none have secrets.
        for entry in &entries {
            assert_eq!(entry.source, AwsConfigSource::Config);
            assert!(entry.access_key_id.is_none());
        }
    }

    // ------------------------------------------------------------------
    // Missing files are treated as empty (not an error)
    // ------------------------------------------------------------------

    #[test]
    fn missing_credentials_file_is_ok() {
        let missing = PathBuf::from("/nonexistent/path/.aws/credentials");
        let result = parse_aws_config_files(&missing, &fixture("basic.config"));
        assert!(result.is_ok(), "missing credentials file must not error");
        let entries = result.unwrap();
        // Profiles from config come through; none have secrets.
        assert!(!entries.is_empty());
        for e in &entries {
            assert!(e.access_key_id.is_none());
        }
    }

    #[test]
    fn both_files_missing_returns_empty_vec() {
        let result = parse_aws_config_files(
            &PathBuf::from("/no/such/creds"),
            &PathBuf::from("/no/such/config"),
        );
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }
}
