//! Opaque identity newtypes used throughout the application.
//!
//! Using distinct types for `ProfileId`, `BucketId`, and `ObjectKey` prevents
//! accidental substitution (e.g. passing a bucket name where an object key is
//! expected) at the type level.
//!
//! # Design choices
//! - Backed by `String` rather than a parsed `Uuid` so that compat providers
//!   with non-UUID profile identifiers work without special-casing.
//! - `ProfileId::new_v4()` is the *default* mint strategy, not a constraint.
//! - `From<&str>` and `From<String>` for ergonomic construction.
//! - `Deref<Target=str>` is intentionally NOT implemented — auto-coercion
//!   would mask type-level bugs.

use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Macro to reduce boilerplate across the three newtypes
// ---------------------------------------------------------------------------

macro_rules! string_id_newtype {
    ($(#[$meta:meta])* $vis:vis struct $name:ident;) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        $vis struct $name(String);

        impl $name {
            /// Create a new instance from any `Into<String>` value.
            pub fn new(s: impl Into<String>) -> Self {
                Self(s.into())
            }

            /// Borrow the inner string slice.
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl From<&str> for $name {
            fn from(s: &str) -> Self {
                Self(s.to_owned())
            }
        }

        impl From<String> for $name {
            fn from(s: String) -> Self {
                Self(s)
            }
        }
    };
}

// ---------------------------------------------------------------------------
// ProfileId
// ---------------------------------------------------------------------------

string_id_newtype! {
    /// Stable internal identifier for an AWS credential profile.
    ///
    /// Minted as a UUID v4 (`ProfileId::new_v4()`) on first registration and
    /// persisted in the local settings store. Two profiles may share a display
    /// name but never share a `ProfileId`.
    pub struct ProfileId;
}

impl ProfileId {
    /// Mint a new `ProfileId` backed by a UUID v4.
    pub fn new_v4() -> Self {
        Self(Uuid::new_v4().to_string())
    }
}

// ---------------------------------------------------------------------------
// BucketId
// ---------------------------------------------------------------------------

string_id_newtype! {
    /// Identifies an S3 bucket by its canonical name.
    pub struct BucketId;
}

// ---------------------------------------------------------------------------
// ObjectKey
// ---------------------------------------------------------------------------

string_id_newtype! {
    /// Identifies an object within a bucket by its full S3 key path.
    pub struct ObjectKey;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    // --- ProfileId ---

    #[test]
    fn profile_id_new_v4_produces_valid_uuid() {
        let id = ProfileId::new_v4();
        let parsed =
            Uuid::parse_str(id.as_str()).expect("ProfileId::new_v4 must yield a valid UUID");
        assert_eq!(parsed.get_version_num(), 4, "must be a v4 UUID");
    }

    #[test]
    fn profile_id_new_v4_produces_unique_values() {
        let a = ProfileId::new_v4();
        let b = ProfileId::new_v4();
        assert_ne!(a, b, "two consecutive new_v4() calls must not collide");
    }

    #[test]
    fn profile_id_from_str_round_trips() {
        let raw = "my-profile";
        let id = ProfileId::from(raw);
        assert_eq!(id.as_str(), raw);
    }

    #[test]
    fn profile_id_from_string_round_trips() {
        let raw = String::from("my-profile");
        let id = ProfileId::from(raw.clone());
        assert_eq!(id.as_str(), &raw);
    }

    #[test]
    fn profile_id_display_prints_inner() {
        let id = ProfileId::new("display-test");
        assert_eq!(id.to_string(), "display-test");
    }

    #[test]
    fn profile_id_hash_works_in_hashset() {
        let mut set: HashSet<ProfileId> = HashSet::new();
        let id = ProfileId::new("abc");
        set.insert(id.clone());
        assert!(set.contains(&id));
        assert_eq!(set.len(), 1);
        // Inserting the same value again must not grow the set.
        set.insert(ProfileId::new("abc"));
        assert_eq!(set.len(), 1);
    }

    // --- BucketId ---

    #[test]
    fn bucket_id_from_and_as_str() {
        let id = BucketId::from("my-bucket");
        assert_eq!(id.as_str(), "my-bucket");
    }

    #[test]
    fn bucket_id_display() {
        let id = BucketId::new("my-bucket");
        assert_eq!(id.to_string(), "my-bucket");
    }

    #[test]
    fn bucket_id_hash_works_in_hashset() {
        let mut set: HashSet<BucketId> = HashSet::new();
        set.insert(BucketId::new("bucket-a"));
        set.insert(BucketId::new("bucket-b"));
        assert_eq!(set.len(), 2);
        set.insert(BucketId::new("bucket-a"));
        assert_eq!(set.len(), 2);
    }

    // --- ObjectKey ---

    #[test]
    fn object_key_from_and_as_str() {
        let key = ObjectKey::from("path/to/object.txt");
        assert_eq!(key.as_str(), "path/to/object.txt");
    }

    #[test]
    fn object_key_display() {
        let key = ObjectKey::new("folder/file.bin");
        assert_eq!(key.to_string(), "folder/file.bin");
    }

    #[test]
    fn object_key_hash_works_in_hashset() {
        let mut set: HashSet<ObjectKey> = HashSet::new();
        set.insert(ObjectKey::new("key1"));
        set.insert(ObjectKey::new("key2"));
        set.insert(ObjectKey::new("key1")); // duplicate
        assert_eq!(set.len(), 2);
    }

    // --- Serde round-trips ---

    #[test]
    fn profile_id_serde_transparent() {
        let id = ProfileId::new("serde-test");
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, r#""serde-test""#);
        let back: ProfileId = serde_json::from_str(&json).unwrap();
        assert_eq!(back, id);
    }

    #[test]
    fn bucket_id_serde_transparent() {
        let id = BucketId::new("my-bucket");
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, r#""my-bucket""#);
        let back: BucketId = serde_json::from_str(&json).unwrap();
        assert_eq!(back, id);
    }

    #[test]
    fn object_key_serde_transparent() {
        let key = ObjectKey::new("a/b/c.txt");
        let json = serde_json::to_string(&key).unwrap();
        assert_eq!(json, r#""a/b/c.txt""#);
        let back: ObjectKey = serde_json::from_str(&json).unwrap();
        assert_eq!(back, key);
    }
}
