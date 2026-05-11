//! Credential and path redaction for diagnostic bundles.
//!
//! `Redactor` compiles all patterns once at construction time and applies them
//! in `redact_text` / `redact_path`.  The trace_id field on `AppError::Internal`
//! is intentionally NOT redacted — it is the link between a user-visible error
//! and the corresponding log lines.

use regex::Regex;
use serde::{Deserialize, Serialize};

/// Controls how aggressively account IDs are redacted.
///
/// `Full` is the default and redacts everything.  `Partial` keeps 12-digit
/// account IDs visible (useful for multi-account diagnostic triage).  `None`
/// is a no-op that returns the input unchanged — useful in tests or when the
/// caller has already stripped sensitive data.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum RedactionLevel {
    /// Redact all patterns including AWS account IDs (default).
    #[default]
    Full,
    /// Redact credentials but keep 12-digit account IDs visible.
    Partial,
    /// No-op; return the input unchanged.
    None,
}

/// Compiled redaction patterns.
///
/// Construct once with `Redactor::new()` and reuse across many calls.
pub struct Redactor {
    level: RedactionLevel,
    /// `(AKIA|ASIA|AROA)[A-Z0-9]{16}` — AWS access key IDs.
    re_aws_key_id: Regex,
    /// `(?i)(aws_secret_access_key|secret_access_key|secret)\s*=\s*['"]?([A-Za-z0-9/+=]{40})['"]?`
    re_secret: Regex,
    /// `(?i)(aws_session_token|session_token)\s*=\s*['"]?([A-Za-z0-9/+=]{100,})['"]?`
    re_session: Regex,
    /// Presigned URLs — everything after `?` when `X-Amz-Signature` is present.
    re_presigned: Regex,
    /// 12-digit AWS account IDs (only applied at `RedactionLevel::Full`).
    re_account_id: Regex,
    /// Bearer token values.
    re_bearer: Regex,
    /// Actual home-dir prefix at runtime (e.g. `/Users/alice`).
    home_dir: Option<String>,
}

impl Redactor {
    /// Build a `Redactor` with the given `RedactionLevel`.
    pub fn with_level(level: RedactionLevel) -> Self {
        // These unwraps are intentional: all patterns are compile-time
        // constants.  A panic here is a programming error, not a runtime error.
        let re_aws_key_id = Regex::new(r"(AKIA|ASIA|AROA)[A-Z0-9]{16}").unwrap();
        let re_secret = Regex::new(
            r#"(?i)(aws_secret_access_key|secret_access_key|secret)\s*=\s*['"]?([A-Za-z0-9/+=]{40})['"]?"#,
        )
        .unwrap();
        let re_session = Regex::new(
            r#"(?i)(aws_session_token|session_token)\s*=\s*['"]?([A-Za-z0-9/+=]{100,})['"]?"#,
        )
        .unwrap();
        // Match https?://host/path? followed by any querystring containing X-Amz-Signature.
        // Capture group 1 is everything up to and including the `?`.
        let re_presigned =
            Regex::new(r"(https?://[^?\s]+\?)[^?\s]*X-Amz-Signature[^?\s]*").unwrap();
        // Match exactly 12 consecutive digits.  The replacement closure
        // (see `redact_text`) skips matches that are adjacent to a `-` or hex
        // letter, so UUID segments like `446655440000` are never clobbered.
        let re_account_id = Regex::new(r"\b\d{12}\b").unwrap();
        let re_bearer = Regex::new(r"Bearer [A-Za-z0-9\-._~+/]+=*").unwrap();

        let home_dir = dirs_home();

        Redactor {
            level,
            re_aws_key_id,
            re_secret,
            re_session,
            re_presigned,
            re_account_id,
            re_bearer,
            home_dir,
        }
    }

    /// Build a `Redactor` with the default `RedactionLevel::Full`.
    pub fn new() -> Self {
        Self::with_level(RedactionLevel::Full)
    }

    /// Apply all active patterns to `text` and return the redacted string.
    ///
    /// Patterns are applied in this order so that more-specific matches are
    /// replaced before generic ones (e.g. presigned URLs before account IDs):
    ///
    /// 1. Presigned URLs (full querystring)
    /// 2. AWS session tokens (longest values first, before secrets)
    /// 3. AWS secret access keys
    /// 4. Bearer tokens
    /// 5. AWS access key IDs
    /// 6. AWS account IDs (Full level only)
    pub fn redact_text(&self, text: &str) -> String {
        if self.level == RedactionLevel::None {
            return text.to_owned();
        }

        let mut out = self
            .re_presigned
            .replace_all(text, "${1}<REDACTED_QUERY>")
            .into_owned();

        // Session tokens first (they can be >100 chars and contain the same
        // character set as secrets, so match them before the shorter pattern).
        out = self
            .re_session
            .replace_all(&out, "${1}=<REDACTED:AWS_SESSION>")
            .into_owned();

        out = self
            .re_secret
            .replace_all(&out, "${1}=<REDACTED:AWS_SECRET>")
            .into_owned();

        out = self
            .re_bearer
            .replace_all(&out, "Bearer <REDACTED:BEARER>")
            .into_owned();

        out = self
            .re_aws_key_id
            .replace_all(&out, "<REDACTED:AWS_KEY_ID>")
            .into_owned();

        if self.level == RedactionLevel::Full {
            // Use a closure so we can skip 12-digit sequences that are part of
            // a UUID (preceded or followed by `-` or a hex letter a-f/A-F),
            // which would otherwise clobber `Internal::trace_id` values.
            let captured = out.clone();
            out = self
                .re_account_id
                .replace_all(&captured, |caps: &regex::Captures<'_>| {
                    let m = caps.get(0).unwrap();
                    let bytes = captured.as_bytes();
                    let before = if m.start() > 0 {
                        bytes[m.start() - 1]
                    } else {
                        b' '
                    };
                    let after = if m.end() < bytes.len() {
                        bytes[m.end()]
                    } else {
                        b' '
                    };
                    // If the digit block is glued to a UUID separator or hex
                    // letter, treat it as part of a UUID and leave it alone.
                    let is_uuid_context = before == b'-'
                        || after == b'-'
                        || before.is_ascii_hexdigit() && !before.is_ascii_digit()
                        || after.is_ascii_hexdigit() && !after.is_ascii_digit();
                    if is_uuid_context {
                        m.as_str().to_owned()
                    } else {
                        "<REDACTED:ACCOUNT_ID>".to_owned()
                    }
                })
                .into_owned();
        }

        out
    }

    /// Replace `$HOME/` and the literal home-dir path prefix with `~/`.
    ///
    /// If the home directory cannot be determined at runtime, the input is
    /// returned unchanged.
    pub fn redact_path(&self, path: &str) -> String {
        // Replace `$HOME` literal placeholder first.
        let mut out = path.replace("$HOME", "~");

        // Replace the real home-dir prefix if we detected it.
        if let Some(ref home) = self.home_dir {
            if out.starts_with(home.as_str()) {
                // e.g. /Users/alice/foo -> ~/foo
                out = format!("~{}", &out[home.len()..]);
            }
        }

        out
    }
}

impl Default for Redactor {
    fn default() -> Self {
        Self::new()
    }
}

/// Return the current user's home directory as a string, without a trailing
/// slash.  Returns `None` when the home directory cannot be determined.
fn dirs_home() -> Option<String> {
    // `HOME` on Unix, `USERPROFILE` on Windows. Probing both keeps us off the
    // `dirs` crate while still working on every CI runner platform.
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .map(|h| h.trim_end_matches(['/', '\\']).to_owned())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    // -------------------------------------------------------------------------
    // Fixture helpers
    // -------------------------------------------------------------------------

    /// Load a fixture file from `tests/fixtures/diagnostics/<name>`.
    fn fixture(name: &str) -> String {
        let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        p.push("tests/fixtures/diagnostics");
        p.push(name);
        std::fs::read_to_string(&p)
            .unwrap_or_else(|e| panic!("failed to read fixture {}: {}", p.display(), e))
            .trim_end_matches('\n')
            .to_owned()
    }

    // -------------------------------------------------------------------------
    // AWS access key ID
    // -------------------------------------------------------------------------

    #[test]
    fn aws_key_id_positive() {
        let r = Redactor::new();
        let input = fixture("aws_key_id.positive.txt");
        let got = r.redact_text(&input);
        assert!(
            got.contains("<REDACTED:AWS_KEY_ID>"),
            "expected AWS key ID to be redacted; got: {got}"
        );
        assert!(
            !got.contains("AKIAIOSFODNN7EXAMPLE"),
            "raw key must not appear in output"
        );
    }

    #[test]
    fn aws_key_id_negative() {
        let r = Redactor::new();
        let input = fixture("aws_key_id.negative.txt");
        let got = r.redact_text(&input);
        assert_eq!(input, got, "non-matching input must pass through unchanged");
    }

    // -------------------------------------------------------------------------
    // Secret access key
    // -------------------------------------------------------------------------

    #[test]
    fn secret_positive() {
        let r = Redactor::new();
        let input = fixture("secret.positive.txt");
        let got = r.redact_text(&input);
        assert!(
            got.contains("<REDACTED:AWS_SECRET>"),
            "expected secret to be redacted; got: {got}"
        );
        assert!(
            !got.contains("wJalrXUtnFEMI"),
            "raw secret must not appear in output"
        );
    }

    #[test]
    fn secret_negative() {
        let r = Redactor::new();
        let input = fixture("secret.negative.txt");
        let got = r.redact_text(&input);
        assert_eq!(input, got, "short secret-like value must not be redacted");
    }

    // -------------------------------------------------------------------------
    // Presigned URLs
    // -------------------------------------------------------------------------

    #[test]
    fn presigned_positive() {
        let r = Redactor::new();
        let input = fixture("presigned.positive.txt");
        let got = r.redact_text(&input);
        assert!(
            got.contains("<REDACTED_QUERY>"),
            "expected presigned querystring to be redacted; got: {got}"
        );
        assert!(
            !got.contains("X-Amz-Signature"),
            "signature must not appear after redaction"
        );
    }

    #[test]
    fn presigned_negative() {
        let r = Redactor::new();
        let input = fixture("presigned.negative.txt");
        let got = r.redact_text(&input);
        assert_eq!(input, got, "normal URL must not be changed");
    }

    // -------------------------------------------------------------------------
    // Account ID
    // -------------------------------------------------------------------------

    #[test]
    fn account_id_full_level() {
        let r = Redactor::new(); // Full
        let input = fixture("account_id.positive.txt");
        let got = r.redact_text(&input);
        assert!(
            got.contains("<REDACTED:ACCOUNT_ID>"),
            "Full level must redact account IDs; got: {got}"
        );
    }

    #[test]
    fn account_id_partial_level_keeps_visible() {
        let r = Redactor::with_level(RedactionLevel::Partial);
        let input = fixture("account_id.positive.txt");
        let got = r.redact_text(&input);
        assert!(
            !got.contains("<REDACTED:ACCOUNT_ID>"),
            "Partial level must NOT redact account IDs; got: {got}"
        );
        assert!(
            got.contains("123456789012"),
            "account ID must remain visible in Partial mode"
        );
    }

    #[test]
    fn account_id_negative() {
        let r = Redactor::new();
        let input = fixture("account_id.negative.txt");
        let got = r.redact_text(&input);
        assert_eq!(
            input, got,
            "11-digit number must not be treated as account ID"
        );
    }

    // -------------------------------------------------------------------------
    // Home path
    // -------------------------------------------------------------------------

    #[test]
    fn home_path_positive_dollar_home() {
        let r = Redactor::new();
        let input = "$HOME/projects/brows3r/data.log";
        let got = r.redact_path(input);
        assert_eq!("~/projects/brows3r/data.log", got);
    }

    #[test]
    fn home_path_positive_literal() {
        let r = Redactor::new();
        let input = fixture("home_path.positive.txt");
        // Resolve the home directory in a cross-platform way: $HOME on
        // Unix, %USERPROFILE% on Windows. The previous std::env::var("HOME")
        // returned an empty string on the CI Windows runner and the
        // fixture-with-empty-prefix doesn't trip the redactor's path
        // pattern, so the assertion below failed.
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_default();
        assert!(
            !home.is_empty(),
            "test setup error: neither HOME nor USERPROFILE is set",
        );
        let input = input.replace("__HOME__", &home);
        let got = r.redact_path(&input);
        assert!(
            got.starts_with("~/"),
            "home prefix should be replaced with ~/; got: {got}"
        );
    }

    #[test]
    fn home_path_negative() {
        let r = Redactor::new();
        let input = fixture("home_path.negative.txt");
        let got = r.redact_path(&input);
        // Non-home-prefixed path should remain unchanged.
        assert_eq!(input, got, "non-home path must pass through unchanged");
    }

    // -------------------------------------------------------------------------
    // trace_id preservation
    // -------------------------------------------------------------------------

    #[test]
    fn trace_id_is_not_redacted() {
        let r = Redactor::new();
        let input = fixture("trace_id.preserve.txt");
        let got = r.redact_text(&input);
        // The UUID trace_id must survive the redactor unchanged.
        assert!(
            got.contains("trace_id"),
            "trace_id field must be preserved; got: {got}"
        );
        // Verify the UUID value itself is still present.
        assert!(
            got.contains("550e8400-e29b-41d4-a716-446655440000"),
            "trace_id UUID must not be clobbered; got: {got}"
        );
    }

    // -------------------------------------------------------------------------
    // RedactionLevel::None
    // -------------------------------------------------------------------------

    #[test]
    fn none_level_is_no_op() {
        let r = Redactor::with_level(RedactionLevel::None);
        let input = "AKIAIOSFODNN7EXAMPLE is a key and aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
        let got = r.redact_text(input);
        assert_eq!(input, got, "None level must return input unchanged");
    }

    // -------------------------------------------------------------------------
    // Bearer token
    // -------------------------------------------------------------------------

    #[test]
    fn bearer_token_redacted() {
        let r = Redactor::new();
        let input = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig";
        let got = r.redact_text(input);
        assert!(
            got.contains("Bearer <REDACTED:BEARER>"),
            "Bearer token must be redacted; got: {got}"
        );
        assert!(
            !got.contains("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"),
            "Raw bearer value must not appear"
        );
    }

    // -------------------------------------------------------------------------
    // proptest fuzzer for AWS key ID format
    // -------------------------------------------------------------------------

    #[cfg(test)]
    mod proptests {
        use super::*;
        use proptest::prelude::*;

        fn aws_key_id_strategy() -> impl Strategy<Value = String> {
            let prefix = prop_oneof![
                Just("AKIA".to_owned()),
                Just("ASIA".to_owned()),
                Just("AROA".to_owned()),
            ];
            let suffix = "[A-Z0-9]{16}";
            (prefix, suffix).prop_map(|(p, s)| format!("{p}{s}"))
        }

        proptest! {
            #[test]
            fn valid_aws_key_ids_are_always_redacted(key in aws_key_id_strategy()) {
                let r = Redactor::new();
                let input = format!("Found {key} in the logs");
                let got = r.redact_text(&input);
                prop_assert!(
                    got.contains("<REDACTED:AWS_KEY_ID>"),
                    "key {key:?} was not redacted; output: {got:?}"
                );
                prop_assert!(
                    !got.contains(&key),
                    "raw key {key:?} still present in output: {got:?}"
                );
            }

            /// Strings of similar length that do NOT start with AKIA/ASIA/AROA
            /// must not be falsely redacted.
            #[test]
            fn non_matching_strings_pass_through(s in "[B-Z][A-Z0-9]{19}") {
                let r = Redactor::new();
                let input = format!("data: {s}");
                let got = r.redact_text(&input);
                prop_assert!(
                    !got.contains("<REDACTED:AWS_KEY_ID>"),
                    "false positive on {s:?}; output: {got:?}"
                );
            }
        }
    }
}
