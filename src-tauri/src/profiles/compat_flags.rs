//! Provider compatibility flags.
//!
//! `CompatFlags` controls per-profile S3 compatibility knobs for providers
//! such as MinIO, Cloudflare R2, Wasabi, and LocalStack.
//!
//! # OCP contract
//! Adding a new flag means adding one field here. The `flags_schema` version
//! field is the contract: existing consumers are forward-compat via the
//! `unknown` passthrough map.  Removing or renaming a field is a breaking
//! change that requires a schema version bump.
//!
//! # Versioning
//! `flags_schema = 1` covers all v1 flags. Unknown fields written by a newer
//! version of the app are preserved in `unknown` so a downgrade does not lose
//! custom configuration.

use std::collections::BTreeMap;

use aws_sdk_s3::config::{Builder as S3ConfigBuilder, RequestChecksumCalculation};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/// S3 bucket addressing style applied to every request for this profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AddressingStyle {
    /// `bucket.s3.amazonaws.com` — default for AWS.
    Virtual,
    /// `s3.amazonaws.com/bucket` — required for MinIO, LocalStack, Ceph.
    Path,
    /// Let the SDK choose based on the bucket name validity rules.
    Auto,
}

impl Default for AddressingStyle {
    fn default() -> Self {
        Self::Auto
    }
}

/// Signature algorithm used to sign requests for this profile.
///
/// `V2` is supported as a degraded fallback only for ancient providers
/// that have not yet adopted SigV4. Using V2 against AWS will fail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignatureVersion {
    V4,
    /// Legacy — accepted for ancient compat providers only.
    V2,
}

impl Default for SignatureVersion {
    fn default() -> Self {
        Self::V4
    }
}

/// Whether the SDK should compute and send payload checksums.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChecksumMode {
    /// Let the SDK decide (CRC-32 for SDKv2+).
    Auto,
    /// Disable payload checksums — required for some older compat providers.
    Disabled,
}

impl Default for ChecksumMode {
    fn default() -> Self {
        Self::Auto
    }
}

/// Whether bucket names must follow strict AWS naming rules or a relaxed set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BucketNameValidation {
    /// AWS rules: 3-63 chars, lowercase letters/numbers/hyphens, no IP-style names.
    Strict,
    /// Lax: accept any non-empty string (needed for some on-prem deployments).
    Lax,
}

impl Default for BucketNameValidation {
    fn default() -> Self {
        Self::Strict
    }
}

// ---------------------------------------------------------------------------
// CompatFlags struct
// ---------------------------------------------------------------------------

/// Per-profile compatibility flags for S3-compatible storage providers.
///
/// All fields have sane defaults that work with AWS S3. Override only the
/// fields that your provider requires.
///
/// Serialization uses `camelCase` for JSON round-trips with the frontend.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatFlags {
    // ------------------------------------------------------------------
    // Schema version — increment on breaking changes, not on additions.
    // ------------------------------------------------------------------
    /// Schema version that emitted these flags. Used for forward-compat
    /// migration. Always write `1` for v1 flags; a future bump to `2`
    /// signals a format change.
    #[serde(default = "default_flags_schema")]
    pub flags_schema: u32,

    // ------------------------------------------------------------------
    // Endpoint / addressing
    // ------------------------------------------------------------------
    /// Custom base URL for the S3 endpoint, e.g. `http://localhost:9000`.
    /// `None` means use the AWS regional endpoint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint_url: Option<String>,

    /// Pin all requests for this profile to a fixed region, ignoring any
    /// region the SDK would otherwise auto-detect.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region_override: Option<String>,

    /// How to form the S3 endpoint URL for bucket operations.
    #[serde(default)]
    pub addressing_style: AddressingStyle,

    // ------------------------------------------------------------------
    // Auth / signing
    // ------------------------------------------------------------------
    /// Signature algorithm. Default V4; V2 is a degraded-compat escape hatch.
    #[serde(default)]
    pub signature_version: SignatureVersion,

    // ------------------------------------------------------------------
    // Request behavior
    // ------------------------------------------------------------------
    /// Whether to send payload checksums on uploads.
    #[serde(default)]
    pub checksum_mode: ChecksumMode,

    /// Accept TLS certificates that fail validation (self-signed, expired).
    /// **Security risk** — only use for development / private networks.
    #[serde(default)]
    pub accept_invalid_tls: bool,

    /// Send `Expect: 100-continue` on PUT requests. Some proxies and older
    /// providers reject the header; set to `false` to suppress it.
    #[serde(default = "default_true")]
    pub expect_continue: bool,

    /// Use chunked upload encoding (`Transfer-Encoding: chunked`) instead of
    /// setting `Content-Length` upfront. Required for streaming uploads where
    /// the total size is unknown at request start.
    #[serde(default)]
    pub chunked_upload: bool,

    // ------------------------------------------------------------------
    // Validation
    // ------------------------------------------------------------------
    /// How strictly to validate bucket names before sending requests.
    #[serde(default)]
    pub bucket_name_validation: BucketNameValidation,

    // ------------------------------------------------------------------
    // Forward-compat passthrough
    // ------------------------------------------------------------------
    /// Unknown flags written by a newer schema version. Preserved verbatim
    /// on read and re-serialized on write so a downgrade does not lose them.
    #[serde(default, flatten)]
    pub unknown: BTreeMap<String, serde_json::Value>,
}

fn default_flags_schema() -> u32 {
    1
}

fn default_true() -> bool {
    true
}

impl Default for CompatFlags {
    fn default() -> Self {
        Self {
            flags_schema: 1,
            endpoint_url: None,
            region_override: None,
            addressing_style: AddressingStyle::default(),
            signature_version: SignatureVersion::default(),
            checksum_mode: ChecksumMode::default(),
            accept_invalid_tls: false,
            expect_continue: true,
            chunked_upload: false,
            bucket_name_validation: BucketNameValidation::default(),
            unknown: BTreeMap::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// CompatFlagApply — return type of apply_to_s3_config_builder
// ---------------------------------------------------------------------------

/// The current schema version understood by this build.
///
/// When a stored `CompatFlags::flags_schema` differs from this value the apply
/// function emits a warning and applies only the known subset.
pub const CURRENT_FLAGS_SCHEMA: u32 = 1;

/// Result of applying `CompatFlags` onto an `S3ConfigBuilder`.
///
/// `builder` is the mutated builder ready for `.build()`.
/// `warnings` is the list of human-readable degradation or forward-compat
/// messages that should be surfaced to the user (e.g. via the notification log).
pub struct CompatFlagApply {
    pub builder: S3ConfigBuilder,
    pub warnings: Vec<String>,
}

/// Apply all v1 compat flags from `flags` onto `builder` and return the
/// updated builder together with any warnings.
///
/// # Forward-compat contract
///
/// - If `flags.flags_schema != CURRENT_FLAGS_SCHEMA`, a warning is added but
///   the known fields are still applied — the function always returns `Ok`.
/// - Each key in `flags.unknown` (written by a newer schema version) produces
///   a single "ignored" warning rather than an error.
///
/// # Flags wiring summary
///
/// | Flag | Wiring |
/// |---|---|
/// | `endpoint_url` | SDK loader (applied before `S3ConfigBuilder`) — caller must handle |
/// | `region_override` | SDK loader — caller must handle |
/// | `addressing_style` | `force_path_style(true/false/unset)` |
/// | `signature_version` | V4 always (V2 unsupported by aws-sdk-s3 v1; emits warning) |
/// | `checksum_mode` | `request_checksum_calculation(WhenRequired)` when Disabled |
/// | `accept_invalid_tls` | feature-gated; caller injects a custom HTTP connector |
/// | `expect_continue` | caller injects a custom HTTP connector |
/// | `chunked_upload` | stored; not yet wired to SDK (open-ended, see comment) |
/// | `bucket_name_validation` | Lax noted in warning (no SDK-level hook in v1) |
pub fn apply_to_s3_config_builder(
    flags: &CompatFlags,
    builder: S3ConfigBuilder,
) -> CompatFlagApply {
    let mut builder = builder;
    let mut warnings: Vec<String> = Vec::new();

    // ------------------------------------------------------------------
    // Schema version check — warn but continue with the known subset.
    // ------------------------------------------------------------------
    if flags.flags_schema != CURRENT_FLAGS_SCHEMA {
        warnings.push(format!(
            "Compat flags schema mismatch (file={} expected={}); \
             applying known subset only",
            flags.flags_schema, CURRENT_FLAGS_SCHEMA
        ));
    }

    // ------------------------------------------------------------------
    // addressing_style → force_path_style
    //
    // Path  → force_path_style(true)
    // Virtual → force_path_style(false)
    // Auto  → leave unset (SDK default: choose based on bucket name)
    // ------------------------------------------------------------------
    match flags.addressing_style {
        AddressingStyle::Path => {
            builder = builder.force_path_style(true);
        }
        AddressingStyle::Virtual => {
            builder = builder.force_path_style(false);
        }
        AddressingStyle::Auto => {
            // Leave unset — SDK decides.
        }
    }

    // ------------------------------------------------------------------
    // signature_version — V2 is not supported by aws-sdk-s3 v1.
    // We log a warning and fall back to V4 (the SDK's only signing impl).
    // ------------------------------------------------------------------
    if matches!(flags.signature_version, SignatureVersion::V2) {
        warnings.push(
            "Signature V2 is unsupported by aws-sdk-s3 v1; using V4 instead. \
             Requests to providers that require V2 will fail."
                .to_string(),
        );
        // No builder mutation needed — V4 is the SDK default.
    }

    // ------------------------------------------------------------------
    // checksum_mode → request_checksum_calculation
    //
    // Disabled → WhenRequired (suppress checksums except where mandatory)
    // Auto     → leave unset (SDK default: CRC-32 for SDKv2+)
    //
    // Response checksum validation (ResponseChecksumValidation) is not
    // available as a top-level builder setter in aws-sdk-s3 v1.x; it is
    // controlled at the operation level.  We set request-side only and
    // document the gap.
    // ------------------------------------------------------------------
    if matches!(flags.checksum_mode, ChecksumMode::Disabled) {
        builder = builder.request_checksum_calculation(RequestChecksumCalculation::WhenRequired);
        // Note: response_checksum_validation is an operation-level concern in
        // aws-sdk-s3 v1 and cannot be set globally on the config builder.
        // The intent (disable response-side checksum verification) is noted
        // here for future wiring when the SDK exposes a config-level setter.
    }

    // ------------------------------------------------------------------
    // accept_invalid_tls — gated behind the `compat_invalid_tls` feature.
    //
    // The actual connector replacement (dangerous TLS bypass) is injected
    // by the caller (ClientBuilder::build) which must detect this flag and
    // provide a custom http_client with cert verification disabled.
    // Here we emit a prominent warning when the flag is set so it is
    // visible in the notification log regardless of feature status.
    // ------------------------------------------------------------------
    if flags.accept_invalid_tls {
        warnings.push(
            "accept_invalid_tls is enabled: TLS certificate validation is \
             disabled. Only use this in trusted private networks."
                .to_string(),
        );
        // The feature gate and connector replacement live in the HTTP
        // client layer (see ClientBuilder::build and the `compat_invalid_tls`
        // feature in Cargo.toml). This function only records the warning.
    }

    // ------------------------------------------------------------------
    // expect_continue — controls the `Expect: 100-continue` header on PUTs.
    //
    // The aws-sdk-s3 v1 SDK manages this via the HTTP connector layer rather
    // than via a config-builder setter. The caller (ClientBuilder) must
    // inspect `flags.expect_continue` and configure the connector accordingly.
    // We document the gap here; no builder mutation is possible in v1.
    // ------------------------------------------------------------------
    // No builder mutation. Caller is responsible for connector-level wiring.

    // ------------------------------------------------------------------
    // chunked_upload — controls Transfer-Encoding: chunked on PUTs.
    //
    // aws-sdk-s3 v1 does not expose a global config toggle for chunked
    // transfer encoding; it is an operation-level option set per-request
    // (e.g. via `put_object().send()` with a streaming body). The flag is
    // stored on `CompatFlags` for future wiring. We record the intent in a
    // warning so the user knows it is not yet active at the SDK level.
    // ------------------------------------------------------------------
    if flags.chunked_upload {
        warnings.push(
            "chunked_upload is set but is not yet wired to the SDK config in v1; \
             PUTs will use Content-Length mode. This flag is reserved for future use."
                .to_string(),
        );
    }

    // ------------------------------------------------------------------
    // bucket_name_validation — Strict is the SDK default.
    //
    // Lax mode (accept any non-empty bucket name) cannot be expressed via
    // a top-level S3ConfigBuilder setter in aws-sdk-s3 v1. It would require
    // a custom operation interceptor. We record the intent in a warning.
    // ------------------------------------------------------------------
    if matches!(flags.bucket_name_validation, BucketNameValidation::Lax) {
        warnings.push(
            "bucket_name_validation=Lax is noted but cannot be enforced \
             via the S3 config builder in aws-sdk-s3 v1; SDK-level bucket name \
             validation (strict) remains active."
                .to_string(),
        );
    }

    // ------------------------------------------------------------------
    // Forward-compat: unknown flags from a newer schema version.
    // Each unknown key surfaces as a single ignored-flag warning.
    // ------------------------------------------------------------------
    for key in flags.unknown.keys() {
        warnings.push(format!(
            "Unknown compat flag '{}' ignored (schema_version mismatch?)",
            key
        ));
    }

    CompatFlagApply { builder, warnings }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_flags_have_expected_values() {
        let f = CompatFlags::default();
        assert_eq!(f.flags_schema, 1);
        assert!(f.endpoint_url.is_none());
        assert!(f.region_override.is_none());
        assert_eq!(f.addressing_style, AddressingStyle::Auto);
        assert_eq!(f.signature_version, SignatureVersion::V4);
        assert_eq!(f.checksum_mode, ChecksumMode::Auto);
        assert!(!f.accept_invalid_tls);
        assert!(f.expect_continue);
        assert!(!f.chunked_upload);
        assert_eq!(f.bucket_name_validation, BucketNameValidation::Strict);
        assert!(f.unknown.is_empty());
    }

    #[test]
    fn serializes_and_deserializes_round_trip() {
        let f = CompatFlags {
            endpoint_url: Some("http://localhost:9000".to_string()),
            addressing_style: AddressingStyle::Path,
            accept_invalid_tls: true,
            ..Default::default()
        };

        let json = serde_json::to_string(&f).unwrap();
        let back: CompatFlags = serde_json::from_str(&json).unwrap();

        assert_eq!(back.endpoint_url, f.endpoint_url);
        assert_eq!(back.addressing_style, f.addressing_style);
        assert_eq!(back.accept_invalid_tls, f.accept_invalid_tls);
        assert_eq!(back.flags_schema, 1);
    }

    #[test]
    fn unknown_fields_preserved_on_round_trip() {
        // Simulate a JSON blob with an unknown future field.
        let json = r#"{
            "flagsSchema": 2,
            "endpointUrl": "http://minio:9000",
            "addressingStyle": "path",
            "signatureVersion": "v4",
            "checksumMode": "auto",
            "acceptInvalidTls": false,
            "expectContinue": true,
            "chunkedUpload": false,
            "bucketNameValidation": "strict",
            "futureField": "preserved"
        }"#;

        let f: CompatFlags = serde_json::from_str(json).unwrap();
        assert_eq!(f.flags_schema, 2);
        assert_eq!(
            f.unknown.get("futureField").and_then(|v| v.as_str()),
            Some("preserved")
        );

        // Re-serializing must keep the unknown field.
        let reser = serde_json::to_string(&f).unwrap();
        assert!(
            reser.contains("futureField"),
            "unknown field lost after round-trip"
        );
    }

    #[test]
    fn camel_case_keys_in_json_output() {
        let f = CompatFlags {
            endpoint_url: Some("http://example.com".to_string()),
            addressing_style: AddressingStyle::Path,
            ..Default::default()
        };
        let json = serde_json::to_string(&f).unwrap();
        assert!(
            json.contains("endpointUrl"),
            "expected camelCase key endpointUrl"
        );
        assert!(
            json.contains("addressingStyle"),
            "expected camelCase key addressingStyle"
        );
    }

    #[test]
    fn addressing_style_enum_serializes_to_snake_case() {
        assert_eq!(
            serde_json::to_string(&AddressingStyle::Virtual).unwrap(),
            r#""virtual""#
        );
        assert_eq!(
            serde_json::to_string(&AddressingStyle::Path).unwrap(),
            r#""path""#
        );
        assert_eq!(
            serde_json::to_string(&AddressingStyle::Auto).unwrap(),
            r#""auto""#
        );
    }

    #[test]
    fn signature_version_enum_serializes() {
        assert_eq!(
            serde_json::to_string(&SignatureVersion::V4).unwrap(),
            r#""v4""#
        );
        assert_eq!(
            serde_json::to_string(&SignatureVersion::V2).unwrap(),
            r#""v2""#
        );
    }

    #[test]
    fn checksum_mode_enum_serializes() {
        assert_eq!(
            serde_json::to_string(&ChecksumMode::Auto).unwrap(),
            r#""auto""#
        );
        assert_eq!(
            serde_json::to_string(&ChecksumMode::Disabled).unwrap(),
            r#""disabled""#
        );
    }

    #[test]
    fn bucket_name_validation_enum_serializes() {
        assert_eq!(
            serde_json::to_string(&BucketNameValidation::Strict).unwrap(),
            r#""strict""#
        );
        assert_eq!(
            serde_json::to_string(&BucketNameValidation::Lax).unwrap(),
            r#""lax""#
        );
    }

    // -----------------------------------------------------------------------
    // apply_to_s3_config_builder tests
    // -----------------------------------------------------------------------

    /// Build a minimal S3ConfigBuilder suitable for testing flag application.
    ///
    /// Region is left unset because `apply_to_s3_config_builder` does not
    /// touch region (it is applied at the SDK loader level by the caller).
    /// No network calls are made when building the resulting config.
    fn base_builder() -> S3ConfigBuilder {
        S3ConfigBuilder::new()
    }

    /// aws-sdk-s3 v1 doesn't expose getters on `Config` — only setters on
    /// the Builder. We assert side-effects by Debug-formatting the resulting
    /// Config and string-matching, which is the canonical pattern shown in
    /// the SDK's own integration tests.
    fn config_debug(config: &aws_sdk_s3::Config) -> String {
        format!("{:?}", config)
    }

    #[test]
    fn addressing_style_path_sets_force_path_style_true() {
        let flags = CompatFlags {
            addressing_style: AddressingStyle::Path,
            ..Default::default()
        };
        let result = apply_to_s3_config_builder(&flags, base_builder());
        let config = result.builder.build();
        let dump = config_debug(&config);
        assert!(
            dump.contains("ForcePathStyle(true)"),
            "Path addressing style must set force_path_style=true; got: {dump}"
        );
        assert!(
            result.warnings.is_empty(),
            "No warnings expected for path style"
        );
    }

    #[test]
    fn addressing_style_virtual_sets_force_path_style_false() {
        let flags = CompatFlags {
            addressing_style: AddressingStyle::Virtual,
            ..Default::default()
        };
        let result = apply_to_s3_config_builder(&flags, base_builder());
        let config = result.builder.build();
        let dump = config_debug(&config);
        assert!(
            dump.contains("ForcePathStyle(false)"),
            "Virtual addressing style must set force_path_style=false; got: {dump}"
        );
    }

    #[test]
    fn addressing_style_auto_leaves_force_path_style_unset() {
        let flags = CompatFlags {
            addressing_style: AddressingStyle::Auto,
            ..Default::default()
        };
        let result = apply_to_s3_config_builder(&flags, base_builder());
        let config = result.builder.build();
        let dump = config_debug(&config);
        // Auto means the SDK chooses; we must not set the flag.
        assert!(
            !dump.contains("ForcePathStyle"),
            "Auto addressing style must leave force_path_style unset; got: {dump}"
        );
    }

    #[test]
    fn signature_version_v2_emits_warning_and_falls_back_to_v4() {
        let flags = CompatFlags {
            signature_version: SignatureVersion::V2,
            ..Default::default()
        };
        let result = apply_to_s3_config_builder(&flags, base_builder());
        assert!(
            result.warnings.iter().any(|w| w.contains("V2")),
            "Expected a warning containing 'V2'; got: {:?}",
            result.warnings
        );
        // The builder itself does not need inspection — the warning is the
        // observable signal and the SDK uses V4 by default.
    }

    #[test]
    fn checksum_mode_disabled_sets_when_required() {
        let flags = CompatFlags {
            checksum_mode: ChecksumMode::Disabled,
            ..Default::default()
        };
        let result = apply_to_s3_config_builder(&flags, base_builder());
        let config = result.builder.build();
        let dump = config_debug(&config);
        assert!(
            dump.contains("request_checksum_calculation: WhenRequired")
                || dump.contains("WhenRequired"),
            "Disabled checksum mode must set request_checksum_calculation=WhenRequired; got: {dump}"
        );
        assert!(
            result.warnings.is_empty(),
            "No warnings expected for checksum_mode=disabled"
        );
    }

    #[test]
    fn checksum_mode_auto_leaves_calculation_unset() {
        let flags = CompatFlags {
            checksum_mode: ChecksumMode::Auto,
            ..Default::default()
        };
        let result = apply_to_s3_config_builder(&flags, base_builder());
        let config = result.builder.build();
        // Auto means SDK default; we must not override it.
        assert!(
            config.request_checksum_calculation().is_none(),
            "Auto checksum mode must leave request_checksum_calculation unset"
        );
    }

    #[test]
    fn bucket_name_validation_lax_emits_warning() {
        let flags = CompatFlags {
            bucket_name_validation: BucketNameValidation::Lax,
            ..Default::default()
        };
        let result = apply_to_s3_config_builder(&flags, base_builder());
        // The flag is stored; the warning documents that SDK-level enforcement
        // is not yet possible in aws-sdk-s3 v1.
        assert!(
            result
                .warnings
                .iter()
                .any(|w| w.to_lowercase().contains("lax") || w.contains("bucket_name_validation")),
            "Expected a warning about Lax bucket validation; got: {:?}",
            result.warnings
        );
    }

    #[test]
    fn chunked_upload_true_emits_warning() {
        let flags = CompatFlags {
            chunked_upload: true,
            ..Default::default()
        };
        let result = apply_to_s3_config_builder(&flags, base_builder());
        assert!(
            result.warnings.iter().any(|w| w.contains("chunked_upload")),
            "Expected a warning about chunked_upload; got: {:?}",
            result.warnings
        );
    }

    // -----------------------------------------------------------------------
    // Forward-compat tests
    // -----------------------------------------------------------------------

    /// (a) Unknown flags in `CompatFlags::unknown` must emit one warning per
    /// key and must NOT cause an error.
    #[test]
    fn unknown_flags_emit_per_key_warning_and_do_not_error() {
        let json = r#"{
            "flagsSchema": 1,
            "endpointUrl": "http://minio:9000",
            "addressingStyle": "path",
            "signatureVersion": "v4",
            "checksumMode": "auto",
            "acceptInvalidTls": false,
            "expectContinue": true,
            "chunkedUpload": false,
            "bucketNameValidation": "strict",
            "futureFlag1": "value1",
            "futureFlag2": 42
        }"#;
        let flags: CompatFlags = serde_json::from_str(json).unwrap();
        assert_eq!(flags.unknown.len(), 2, "should have 2 unknown keys");

        let result = apply_to_s3_config_builder(&flags, base_builder());

        // Must return Ok (function signature is infallible — no Err path).
        // Assert one warning per unknown key.
        let unknown_warnings: Vec<_> = result
            .warnings
            .iter()
            .filter(|w| w.contains("Unknown compat flag"))
            .collect();
        assert_eq!(
            unknown_warnings.len(),
            2,
            "Expected one warning per unknown flag; got: {:?}",
            result.warnings
        );
        assert!(
            unknown_warnings.iter().any(|w| w.contains("futureFlag1")),
            "Warning must name the unknown key 'futureFlag1'"
        );
        assert!(
            unknown_warnings.iter().any(|w| w.contains("futureFlag2")),
            "Warning must name the unknown key 'futureFlag2'"
        );
    }

    /// (b) `flags_schema != 1` must emit a schema-mismatch warning but still
    /// apply the known fields.  We verify via `endpoint_url` + path style.
    #[test]
    fn schema_mismatch_emits_warning_and_still_applies_known_flags() {
        // Simulate a flags struct written by schema v99.
        let flags = CompatFlags {
            flags_schema: 99,
            endpoint_url: Some("http://minio:9000".to_string()),
            addressing_style: AddressingStyle::Path,
            ..Default::default()
        };

        let result = apply_to_s3_config_builder(&flags, base_builder());

        // Must emit a schema-mismatch warning.
        assert!(
            result
                .warnings
                .iter()
                .any(|w| w.contains("schema mismatch")),
            "Expected a 'schema mismatch' warning; got: {:?}",
            result.warnings
        );

        // Known flags (addressing_style=Path) must still be applied.
        let config = result.builder.build();
        let dump = config_debug(&config);
        assert!(
            dump.contains("ForcePathStyle(true)"),
            "addressing_style=Path must still be applied despite schema mismatch; got: {dump}"
        );
        // endpoint_url is applied by the caller (SDK loader), not by this
        // function — no assertion needed on config.endpoint_url() here.
    }
}
