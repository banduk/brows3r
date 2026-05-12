//! Token registry for the loopback media server.
//!
//! # Overview
//!
//! Each call to [`TokenRegistry::mint`] produces a cryptographically random,
//! URL-safe base64 token (48 raw bytes → 64 base64 chars) that maps to a
//! [`TokenRecord`] containing the S3 coordinates, TTL, and the session that
//! owns it.
//!
//! # OCP
//!
//! - The registry is decoupled from the HTTP server so it can be swapped for a
//!   more durable store (e.g. `redb`) if cross-restart tokens ever become
//!   necessary.  In v1 tokens are session-scoped and in-memory is sufficient.
//! - `revoke_session` is the single sweep point for session-end cleanup.

use std::{
    collections::HashMap,
    sync::{Arc, RwLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
// rand 0.10 moved `RngCore` to the `rand_core` crate; importing `Rng` brings
// the `fill_bytes` extension method into scope without an extra dependency.
use rand::Rng;

use crate::ids::{BucketId, ProfileId};

// ---------------------------------------------------------------------------
// TokenRecord
// ---------------------------------------------------------------------------

/// Everything the server needs to serve a single media token.
#[derive(Debug, Clone)]
pub struct TokenRecord {
    /// Profile whose credentials are used to fetch the object.
    pub profile_id: ProfileId,
    /// S3 bucket containing the object.
    pub bucket: BucketId,
    /// Full S3 object key.
    pub key: String,
    /// AWS region for the bucket (needed to route the get_object call).
    pub region: String,
    /// Unix epoch seconds at which this token expires.
    pub expires_at: i64,
    /// Session that minted this token; used by [`TokenRegistry::revoke_session`].
    pub session_id: String,
}

impl TokenRecord {
    /// Returns `true` when the token has passed its expiry time.
    pub fn is_expired(&self) -> bool {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::ZERO)
            .as_secs() as i64;
        now >= self.expires_at
    }
}

// ---------------------------------------------------------------------------
// TokenRegistry
// ---------------------------------------------------------------------------

/// Thread-safe, in-memory store of live token records.
///
/// Wrapped in `Arc` so it can be cloned cheaply into the axum app state and
/// the Tauri-managed [`super::MediaServerHandle`].
#[derive(Default)]
pub struct TokenRegistry {
    map: RwLock<HashMap<String, TokenRecord>>,
}

impl TokenRegistry {
    /// Create an empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Mint a fresh token for the given S3 object.
    ///
    /// Returns `(token, expires_at)` where `token` is the URL-safe base64
    /// string (64 chars, 48 random bytes) and `expires_at` is a Unix epoch
    /// seconds timestamp.
    ///
    /// # Arguments
    ///
    /// - `profile_id` — profile whose credentials service the request.
    /// - `bucket` / `key` — S3 coordinates.
    /// - `region` — AWS region for the bucket (used to route get_object).
    /// - `ttl_secs` — seconds until expiry (1-hour default → pass `3600`).
    /// - `session_id` — calling session; used by `revoke_session`.
    pub fn mint(
        &self,
        profile_id: ProfileId,
        bucket: BucketId,
        key: String,
        region: String,
        ttl_secs: u64,
        session_id: String,
    ) -> (String, i64) {
        let mut bytes = [0u8; 48];
        rand::rng().fill_bytes(&mut bytes);
        let token = URL_SAFE_NO_PAD.encode(bytes);

        let expires_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::ZERO)
            .as_secs() as i64
            + ttl_secs as i64;

        let record = TokenRecord {
            profile_id,
            bucket,
            key,
            region,
            expires_at,
            session_id,
        };

        self.map
            .write()
            .expect("token registry lock poisoned")
            .insert(token.clone(), record);

        (token, expires_at)
    }

    /// Look up a token.  Returns `None` when unknown **or** expired.
    pub fn lookup(&self, token: &str) -> Option<TokenRecord> {
        let guard = self.map.read().expect("token registry lock poisoned");
        let record = guard.get(token)?;
        if record.is_expired() {
            return None;
        }
        Some(record.clone())
    }

    /// Variant of `lookup` that distinguishes "token unknown" from "token expired".
    ///
    /// - `Ok(Some(record))` — token is known and live.
    /// - `Ok(None)` — token is known but expired → 403.
    /// - `Err(())` — token does not exist → 404.
    pub fn lookup_with_status(&self, token: &str) -> Result<Option<TokenRecord>, ()> {
        let guard = self.map.read().expect("token registry lock poisoned");
        match guard.get(token) {
            None => Err(()),
            Some(record) if record.is_expired() => Ok(None),
            Some(record) => Ok(Some(record.clone())),
        }
    }

    /// Revoke a single token by removing it from the registry.
    pub fn revoke(&self, token: &str) {
        self.map
            .write()
            .expect("token registry lock poisoned")
            .remove(token);
    }

    /// Remove all tokens belonging to `session_id`.
    ///
    /// Called on session end so no token outlives its session.
    pub fn revoke_session(&self, session_id: &str) {
        self.map
            .write()
            .expect("token registry lock poisoned")
            .retain(|_, record| record.session_id != session_id);
    }

    /// Remove all expired tokens.  Call periodically to avoid unbounded growth.
    pub fn gc(&self) {
        self.map
            .write()
            .expect("token registry lock poisoned")
            .retain(|_, record| !record.is_expired());
    }
}

/// Shared, heap-allocated token registry.
pub type TokenRegistryHandle = Arc<TokenRegistry>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> ProfileId {
        ProfileId::new("test-profile")
    }

    fn bucket() -> BucketId {
        BucketId::new("test-bucket")
    }

    #[test]
    fn mint_produces_unique_64_char_tokens() {
        let registry = TokenRegistry::new();
        let (t1, _) = registry.mint(
            profile(),
            bucket(),
            "k1".into(),
            "us-east-1".into(),
            3600,
            "s1".into(),
        );
        let (t2, _) = registry.mint(
            profile(),
            bucket(),
            "k2".into(),
            "us-east-1".into(),
            3600,
            "s1".into(),
        );

        // 48 raw bytes → 64 URL-safe base64 chars (no padding).
        assert_eq!(t1.len(), 64, "token must be 64 chars");
        assert_eq!(t2.len(), 64, "token must be 64 chars");
        assert_ne!(t1, t2, "tokens must be unique");

        // Only URL-safe base64 alphabet characters.
        for ch in t1.chars() {
            assert!(
                ch.is_ascii_alphanumeric() || ch == '-' || ch == '_',
                "unexpected char: {ch}"
            );
        }
    }

    #[test]
    fn lookup_returns_record_for_live_token() {
        let registry = TokenRegistry::new();
        let (token, _) = registry.mint(
            profile(),
            bucket(),
            "my/key".into(),
            "us-east-1".into(),
            3600,
            "s1".into(),
        );
        let record = registry.lookup(&token).expect("live token must be found");
        assert_eq!(record.key, "my/key");
        assert_eq!(record.session_id, "s1");
    }

    #[test]
    fn lookup_returns_none_for_unknown_token() {
        let registry = TokenRegistry::new();
        assert!(registry.lookup("does-not-exist").is_none());
    }

    #[test]
    fn expired_token_returns_none_from_lookup() {
        let registry = TokenRegistry::new();
        // TTL = 0 → already expired.
        let (token, _) = registry.mint(
            profile(),
            bucket(),
            "k".into(),
            "us-east-1".into(),
            0,
            "s1".into(),
        );
        // Give `expires_at` exactly `now`; is_expired checks `now >= expires_at`.
        assert!(
            registry.lookup(&token).is_none(),
            "expired token must not be found"
        );
    }

    #[test]
    fn revoke_removes_token() {
        let registry = TokenRegistry::new();
        let (token, _) = registry.mint(
            profile(),
            bucket(),
            "k".into(),
            "us-east-1".into(),
            3600,
            "s1".into(),
        );
        registry.revoke(&token);
        assert!(
            registry.lookup(&token).is_none(),
            "revoked token must not be found"
        );
    }

    #[test]
    fn revoke_session_removes_all_tokens_for_session() {
        let registry = TokenRegistry::new();
        let (t1, _) = registry.mint(
            profile(),
            bucket(),
            "k1".into(),
            "us-east-1".into(),
            3600,
            "session-a".into(),
        );
        let (t2, _) = registry.mint(
            profile(),
            bucket(),
            "k2".into(),
            "us-east-1".into(),
            3600,
            "session-a".into(),
        );
        let (t3, _) = registry.mint(
            profile(),
            bucket(),
            "k3".into(),
            "us-east-1".into(),
            3600,
            "session-b".into(),
        );

        registry.revoke_session("session-a");

        assert!(
            registry.lookup(&t1).is_none(),
            "session-a token 1 must be gone"
        );
        assert!(
            registry.lookup(&t2).is_none(),
            "session-a token 2 must be gone"
        );
        assert!(
            registry.lookup(&t3).is_some(),
            "session-b token must survive"
        );
    }

    #[test]
    fn gc_removes_expired_tokens() {
        let registry = TokenRegistry::new();
        // Expired immediately (ttl=0).
        let (expired_tok, _) = registry.mint(
            profile(),
            bucket(),
            "expired".into(),
            "us-east-1".into(),
            0,
            "s".into(),
        );
        // Live token.
        let (live_tok, _) = registry.mint(
            profile(),
            bucket(),
            "live".into(),
            "us-east-1".into(),
            3600,
            "s".into(),
        );

        registry.gc();

        assert!(
            registry.lookup(&expired_tok).is_none(),
            "gc must remove expired tokens"
        );
        assert!(
            registry.lookup(&live_tok).is_some(),
            "gc must keep live tokens"
        );
    }
}
