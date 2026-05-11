//! Path domain types: `S3Location` and `DisplayPath`.
//!
//! `S3Location` is the canonical "where am I" domain type consumed by every
//! other module. `DisplayPath` is the breadcrumb-friendly view shown in the
//! UI. Encoding between these forms and external URI/clipboard strings lives
//! in `encode`.
//!
//! # OCP contract
//! - `S3Location` is the stable domain type — adding a field (e.g. `version_id`)
//!   is non-breaking.
//! - No other module should percent-encode keys; all encoding is centralised in
//!   `path::encode`.
//! - Three explicit views: canonical (`brows3r://`), display, and clipboard
//!   (`s3://`). Future views (presigned URL, CloudFront URL) are new functions
//!   in `encode`.

pub mod encode;

use serde::{Deserialize, Serialize};

use crate::ids::{BucketId, ObjectKey, ProfileId};

// ---------------------------------------------------------------------------
// S3Location
// ---------------------------------------------------------------------------

/// The canonical domain type for "where am I in S3".
///
/// `profile_id` is the stable internal identifier (UUID v4); it is used in
/// canonical URIs so that two profiles with the same display name remain
/// unambiguous (AC-2).
///
/// `prefix` is the current directory prefix (empty string = bucket root).
/// `key` is `Some` when a specific object is referenced, `None` for a prefix
/// (directory) location.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct S3Location {
    pub profile_id: ProfileId,
    pub bucket: BucketId,
    /// Current prefix (virtual directory). Empty string means bucket root.
    pub prefix: String,
    /// Specific object key. `None` when the location refers to a prefix.
    pub key: Option<ObjectKey>,
}

// ---------------------------------------------------------------------------
// DisplayPath
// ---------------------------------------------------------------------------

/// Breadcrumb-friendly view of an `S3Location`.
///
/// `profile_display_name` is the human-readable profile label shown as the
/// root breadcrumb segment. `bucket` is the raw bucket name. `segments` are
/// the individual prefix/key path components, split on `/` with empty strings
/// removed, suitable for rendering as clickable breadcrumb items.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DisplayPath {
    pub profile_display_name: String,
    pub bucket: String,
    pub segments: Vec<String>,
}
