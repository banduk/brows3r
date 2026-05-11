//! Tauri commands for the loopback media server.
//!
//! # Commands
//!
//! - [`media_register`] — mint a signed token and return a loopback URL.
//! - [`media_revoke`]   — immediately revoke a single token.
//!
//! # Design
//!
//! The media server is an `axum` HTTP server bound to `127.0.0.1:0`.  The
//! frontend embeds the returned URL directly as a `<video>` or `<audio>` `src`
//! attribute; the browser's byte-range requests are proxied by the server to S3.
//!
//! Token security: tokens are 48 random bytes encoded as URL-safe base64 (64
//! chars). They are session-scoped — `revoke_session` sweeps all tokens when
//! the session ends.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    error::AppError,
    events::{self, EventKind},
    ids::{BucketId, ProfileId},
    media_server::MediaServerHandle,
    profiles::ProfileStoreHandle,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Response from [`media_register`].
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaRegisterResponse {
    /// Full loopback URL, e.g. `http://127.0.0.1:49231/m/<token>`.
    pub url: String,
    /// Unix epoch seconds at which the token expires.
    pub expires_at: i64,
}

// ---------------------------------------------------------------------------
// media_register
// ---------------------------------------------------------------------------

/// Mint a signed token for the given S3 object and return a loopback URL.
///
/// The returned URL can be set as the `src` of a `<video>` or `<audio>` element.
/// The server validates the token, enforces expiry, and streams the S3 object
/// with byte-range support.
///
/// # Parameters
///
/// - `profile_id` — profile whose credentials service the stream.
/// - `bucket` / `key` — S3 coordinates.
/// - `server` — managed [`MediaServerHandle`] (port + registry).
/// - `store` — profile store used to resolve the bucket region.
///
/// # Token TTL
///
/// Default: 3 600 seconds (1 hour).  Tokens also expire when the session ends
/// via `revoke_session`.
///
/// # Errors
///
/// Returns `AppError::NotFound` when `profile_id` does not exist.
/// Returns `AppError::Auth` when the profile has not been validated.
#[tauri::command]
pub async fn media_register(
    profile_id: ProfileId,
    bucket: BucketId,
    key: String,
    server: State<'_, MediaServerHandle>,
    store: State<'_, ProfileStoreHandle>,
) -> Result<MediaRegisterResponse, AppError> {
    // Resolve profile to get region and validate the session is authenticated.
    let profile = {
        let store_guard = store.inner.lock().await;
        store_guard
            .get(&profile_id)
            .ok_or_else(|| AppError::NotFound {
                resource: format!("profile:{}", profile_id.as_str()),
            })?
    };

    if profile.validated_at.is_none() {
        return Err(AppError::Auth {
            reason: "profile_not_validated_in_session".to_string(),
        });
    }

    let region = profile
        .default_region
        .clone()
        .unwrap_or_else(|| "us-east-1".to_string());

    let session_id = server.session_id.clone();
    let (token, expires_at) = server
        .registry
        .mint(profile_id, bucket, key, region, 3600, session_id);

    let url = format!("http://127.0.0.1:{}/m/{}", server.port, token);

    Ok(MediaRegisterResponse { url, expires_at })
}

// ---------------------------------------------------------------------------
// media_revoke
// ---------------------------------------------------------------------------

/// Immediately revoke a single media token.
///
/// After revocation, any in-flight request using the token will receive a 403
/// response on the next check (or 404 after GC).  The `media:revoked` event is
/// emitted so the frontend can react (e.g. show an expired-token message).
///
/// # Errors
///
/// This command is idempotent — revoking an already-revoked or unknown token
/// is not an error.
#[tauri::command]
pub async fn media_revoke(
    token: String,
    server: State<'_, MediaServerHandle>,
    channel: tauri::AppHandle,
) -> Result<(), AppError> {
    server.registry.revoke(&token);

    // Emit media:revoked so the frontend can react.
    events::emit(
        &channel,
        EventKind::MediaRevoked,
        serde_json::json!({ "token": token }),
    )?;

    Ok(())
}
