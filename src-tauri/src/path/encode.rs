//! Encoding and decoding between `S3Location` and its various string forms.
//!
//! Three distinct output forms:
//! - **Canonical URI** (`brows3r://<profile_id>/<bucket>/<key>`) — used for
//!   Copy Path, navigation state, and any IPC surface that must be
//!   unambiguous even when two profiles share a display name.
//! - **Display path** — `DisplayPath` for the breadcrumb UI. Human-readable,
//!   not URL-encoded.
//! - **Clipboard string** (`s3://<bucket>/<key>`) — the aws-cli-compatible
//!   form users paste into a terminal.
//!
//! # Percent-encoding rules
//! The canonical URI encodes bucket names and the full key/prefix string using
//! `percent-encoding`'s `NON_ALPHANUMERIC` set (encodes everything except
//! `[A-Za-z0-9]`), then un-encodes `/` back to a literal `/` in the key
//! segment only. This preserves the S3 hierarchy-separator semantics while
//! ensuring that `?`, `#`, `%`, and other special characters are always
//! escaped.
//!
//! Bucket names are encoded without slash restoration (S3 bucket names cannot
//! contain `/`).

use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};

use crate::{
    error::AppError,
    ids::{BucketId, ObjectKey, ProfileId},
};

use super::{DisplayPath, S3Location};

// ---------------------------------------------------------------------------
// Canonical URI — brows3r://<profile_id>/<bucket>/<key>
// ---------------------------------------------------------------------------

/// Encode an `S3Location` into its canonical `brows3r://` URI.
///
/// The canonical form uses the stable `profile_id` (not the display name) so
/// two profiles with identical display names produce different URIs (AC-2).
///
/// Key path separators (`/`) are preserved for readability; all other
/// non-alphanumeric characters (including `?`, `#`, `%`, unicode) are
/// percent-encoded.
pub fn to_canonical_uri(loc: &S3Location) -> String {
    // Bucket encoding — no slash restoration; bucket names never contain `/`.
    let encoded_bucket = encode_no_slash(loc.bucket.as_str());

    // Key or prefix encoding — slashes are preserved as hierarchy separators.
    let key_str = loc
        .key
        .as_ref()
        .map(|k| k.as_str())
        .unwrap_or(loc.prefix.as_str());
    let encoded_key = encode_preserve_slash(key_str);

    format!(
        "brows3r://{}/{}/{}",
        loc.profile_id.as_str(),
        encoded_bucket,
        encoded_key
    )
}

/// Parse a `brows3r://` URI back into an `S3Location`.
///
/// Returns `AppError::Validation` when the URI is malformed (wrong scheme,
/// missing profile id, missing bucket, etc.). The resulting `S3Location` uses
/// an empty `prefix` and sets `key` to `Some` with the decoded key/prefix
/// string (callers that need a directory prefix can normalise accordingly).
pub fn from_canonical_uri(uri: &str) -> Result<S3Location, AppError> {
    // Scheme check.
    let rest = uri
        .strip_prefix("brows3r://")
        .ok_or_else(|| AppError::Validation {
            field: "uri".to_string(),
            hint: "URI must begin with brows3r://".to_string(),
        })?;

    // Split into at most 3 parts: profile_id / bucket / key
    let mut parts = rest.splitn(3, '/');

    let profile_id_raw = parts.next().unwrap_or(""); // always Some from splitn
    if profile_id_raw.is_empty() {
        return Err(AppError::Validation {
            field: "uri".to_string(),
            hint: "profile_id must not be empty".to_string(),
        });
    }

    let bucket_raw = parts.next().unwrap_or("");
    if bucket_raw.is_empty() {
        return Err(AppError::Validation {
            field: "uri".to_string(),
            hint: "bucket must not be empty".to_string(),
        });
    }

    // Key may be empty (bucket root).
    let key_raw = parts.next().unwrap_or("");

    // Percent-decode each component.
    let bucket_decoded = decode_component(bucket_raw).map_err(|_| AppError::Validation {
        field: "uri".to_string(),
        hint: "bucket segment contains invalid percent-encoding".to_string(),
    })?;

    let key_decoded = decode_component(key_raw).map_err(|_| AppError::Validation {
        field: "uri".to_string(),
        hint: "key segment contains invalid percent-encoding".to_string(),
    })?;

    let key = if key_decoded.is_empty() {
        None
    } else {
        Some(ObjectKey::new(key_decoded))
    };

    Ok(S3Location {
        profile_id: ProfileId::new(profile_id_raw),
        bucket: BucketId::new(bucket_decoded),
        prefix: String::new(),
        key,
    })
}

// ---------------------------------------------------------------------------
// Display path — for the breadcrumb UI
// ---------------------------------------------------------------------------

/// Build a `DisplayPath` from an `S3Location`.
///
/// The profile display name is passed in as a `&str` because it lives in the
/// profile store, not in `S3Location`. Segments are split on `/` and empty
/// strings are filtered out so trailing slashes and double-slashes do not
/// produce empty breadcrumb items.
pub fn to_display_path(loc: &S3Location, profile_display_name: &str) -> DisplayPath {
    let raw = loc
        .key
        .as_ref()
        .map(|k| k.as_str())
        .unwrap_or(loc.prefix.as_str());

    let segments: Vec<String> = raw
        .split('/')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();

    DisplayPath {
        profile_display_name: profile_display_name.to_owned(),
        bucket: loc.bucket.as_str().to_owned(),
        segments,
    }
}

/// Reconstruct an `S3Location` from breadcrumb segments.
///
/// The resulting location has an empty `prefix` and the joined segments as the
/// `key` (or `None` when `segments` is empty, indicating the bucket root).
pub fn from_display_path(
    profile_id: ProfileId,
    bucket: BucketId,
    segments: &[String],
) -> S3Location {
    let key = if segments.is_empty() {
        None
    } else {
        Some(ObjectKey::new(segments.join("/")))
    };

    S3Location {
        profile_id,
        bucket,
        prefix: String::new(),
        key,
    }
}

// ---------------------------------------------------------------------------
// Clipboard string — s3://<bucket>/<key>
// ---------------------------------------------------------------------------

/// Produce the aws-cli-compatible `s3://` string for clipboard use.
///
/// Uses the raw (un-encoded) bucket name and key/prefix so users can paste
/// directly into a terminal command (`aws s3 cp s3://bucket/key ./`).
pub fn to_clipboard_string(loc: &S3Location, _profile_display_name: &str) -> String {
    let key_str = loc
        .key
        .as_ref()
        .map(|k| k.as_str())
        .unwrap_or(loc.prefix.as_str());

    if key_str.is_empty() {
        format!("s3://{}/", loc.bucket.as_str())
    } else {
        format!("s3://{}/{}", loc.bucket.as_str(), key_str)
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Percent-encode a string, encoding ALL non-alphanumeric characters
/// (including `/`). Used for bucket names.
fn encode_no_slash(input: &str) -> String {
    utf8_percent_encode(input, NON_ALPHANUMERIC).to_string()
}

/// Percent-encode a string, encoding all non-alphanumeric characters EXCEPT
/// `/`. Used for key/prefix segments.
fn encode_preserve_slash(input: &str) -> String {
    // Encode the full string with NON_ALPHANUMERIC (which encodes `/` as %2F),
    // then restore literal `/` by replacing `%2F` (case-insensitive match).
    let encoded = utf8_percent_encode(input, NON_ALPHANUMERIC).to_string();
    // Restore both lower-case (%2f) and upper-case (%2F) variants.
    encoded.replace("%2F", "/").replace("%2f", "/")
}

/// Percent-decode a URI component, returning a UTF-8 string.
fn decode_component(input: &str) -> Result<String, ()> {
    percent_decode_str(input)
        .decode_utf8()
        .map(|s| s.into_owned())
        .map_err(|_| ())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_loc(profile_id: &str, bucket: &str, prefix: &str, key: Option<&str>) -> S3Location {
        S3Location {
            profile_id: ProfileId::new(profile_id),
            bucket: BucketId::new(bucket),
            prefix: prefix.to_owned(),
            key: key.map(ObjectKey::new),
        }
    }

    // -----------------------------------------------------------------------
    // AC-2: duplicate display names → different canonical URIs via profile_id
    // -----------------------------------------------------------------------

    #[test]
    fn duplicate_display_names_produce_distinct_canonical_uris() {
        // Two profiles with the same display name "prod" but different profile_ids.
        let profile_id_a = "11111111-1111-1111-1111-111111111111";
        let profile_id_b = "22222222-2222-2222-2222-222222222222";

        let loc_a = make_loc(profile_id_a, "my-bucket", "", Some("data/file.csv"));
        let loc_b = make_loc(profile_id_b, "my-bucket", "", Some("data/file.csv"));

        let uri_a = to_canonical_uri(&loc_a);
        let uri_b = to_canonical_uri(&loc_b);

        assert_ne!(
            uri_a, uri_b,
            "duplicate display names must produce distinct URIs"
        );
        assert!(
            uri_a.contains(profile_id_a),
            "URI must embed the profile_id"
        );
        assert!(uri_b.contains(profile_id_b));
    }

    // -----------------------------------------------------------------------
    // Unicode key round-trip
    // -----------------------------------------------------------------------

    #[test]
    fn unicode_key_round_trips() {
        let loc = make_loc("prof-1", "bucket", "", Some("café/menu.pdf"));

        let uri = to_canonical_uri(&loc);
        let restored = from_canonical_uri(&uri).expect("must parse");

        assert_eq!(
            restored.key.as_ref().map(|k| k.as_str()),
            Some("café/menu.pdf"),
            "unicode key must survive round-trip"
        );
        // Slashes must be preserved as literals in the URI.
        assert!(
            uri.contains('/'),
            "URI must preserve path-separator slashes"
        );
    }

    // -----------------------------------------------------------------------
    // Special chars: ?, #, %, / (path sep preserved)
    // -----------------------------------------------------------------------

    #[test]
    fn special_chars_round_trip() {
        let key = "path/with?query#hash%percent/end";
        let loc = make_loc("prof-1", "my-bucket", "", Some(key));

        let uri = to_canonical_uri(&loc);

        // ? # % must be encoded.
        assert!(
            !uri.contains('?'),
            "? must be percent-encoded in canonical URI"
        );
        assert!(
            !uri.contains('#'),
            "# must be percent-encoded in canonical URI"
        );

        let restored = from_canonical_uri(&uri).expect("must parse");
        assert_eq!(
            restored.key.as_ref().map(|k| k.as_str()),
            Some(key),
            "special-char key must round-trip losslessly"
        );
    }

    #[test]
    fn slash_preserved_in_key_encoding() {
        let loc = make_loc("prof-1", "bucket", "", Some("a/b/c.txt"));
        let uri = to_canonical_uri(&loc);
        // Slashes must be preserved as literal `/` path separators. The `.` in
        // `c.txt` is encoded (%2E) by the strict NON_ALPHANUMERIC set, so the
        // URI does not literally end with "a/b/c.txt", but round-tripping gives
        // back the original key unchanged.
        let restored = from_canonical_uri(&uri).expect("must parse");
        assert_eq!(
            restored.key.as_ref().map(|k| k.as_str()),
            Some("a/b/c.txt"),
            "key must round-trip losslessly"
        );
        // The URI must contain literal slashes (not %2F) between a, b, and the filename.
        assert!(
            uri.contains("a/b/"),
            "path slashes must be preserved as literal '/': got {uri}"
        );
    }

    // -----------------------------------------------------------------------
    // to_clipboard_string
    // -----------------------------------------------------------------------

    #[test]
    fn clipboard_string_formats_s3_uri() {
        let loc = make_loc("prof-1", "my-bucket", "", Some("folder/file.txt"));
        let clip = to_clipboard_string(&loc, "prod");
        assert_eq!(clip, "s3://my-bucket/folder/file.txt");
    }

    #[test]
    fn clipboard_string_bucket_root() {
        let loc = make_loc("prof-1", "my-bucket", "", None);
        let clip = to_clipboard_string(&loc, "prod");
        assert_eq!(clip, "s3://my-bucket/");
    }

    // -----------------------------------------------------------------------
    // from_canonical_uri — malformed inputs
    // -----------------------------------------------------------------------

    #[test]
    fn rejects_wrong_scheme() {
        let result = from_canonical_uri("https://example.com/bucket/key");
        assert!(
            matches!(result, Err(AppError::Validation { .. })),
            "wrong scheme must return Validation error"
        );
    }

    #[test]
    fn rejects_empty_profile_id() {
        // brows3r:// with empty profile_id (the string after // before first /)
        let result = from_canonical_uri("brows3r:///bucket/key");
        assert!(
            matches!(result, Err(AppError::Validation { .. })),
            "empty profile_id must be rejected"
        );
    }

    #[test]
    fn rejects_missing_bucket() {
        // profile_id present but no bucket
        let result = from_canonical_uri("brows3r://prof-1");
        assert!(
            matches!(result, Err(AppError::Validation { .. })),
            "missing bucket must be rejected"
        );
    }

    #[test]
    fn rejects_empty_bucket() {
        let result = from_canonical_uri("brows3r://prof-1//key");
        assert!(
            matches!(result, Err(AppError::Validation { .. })),
            "empty bucket must be rejected"
        );
    }

    // -----------------------------------------------------------------------
    // Display path
    // -----------------------------------------------------------------------

    #[test]
    fn to_display_path_splits_segments() {
        let loc = make_loc("prof-1", "my-bucket", "", Some("folder/sub/file.txt"));
        let dp = to_display_path(&loc, "production");
        assert_eq!(dp.profile_display_name, "production");
        assert_eq!(dp.bucket, "my-bucket");
        assert_eq!(dp.segments, vec!["folder", "sub", "file.txt"]);
    }

    #[test]
    fn to_display_path_bucket_root() {
        let loc = make_loc("prof-1", "my-bucket", "", None);
        let dp = to_display_path(&loc, "prod");
        assert_eq!(dp.segments, Vec::<String>::new());
    }

    #[test]
    fn from_display_path_joins_segments() {
        let profile_id = ProfileId::new("prof-1");
        let bucket = BucketId::new("my-bucket");
        let segments = vec!["folder".to_owned(), "sub".to_owned(), "file.txt".to_owned()];
        let loc = from_display_path(profile_id.clone(), bucket.clone(), &segments);

        assert_eq!(loc.profile_id, profile_id);
        assert_eq!(loc.bucket, bucket);
        assert_eq!(
            loc.key.as_ref().map(|k| k.as_str()),
            Some("folder/sub/file.txt")
        );
    }

    #[test]
    fn from_display_path_empty_segments_is_bucket_root() {
        let loc = from_display_path(ProfileId::new("p"), BucketId::new("b"), &[]);
        assert!(loc.key.is_none());
    }
}
