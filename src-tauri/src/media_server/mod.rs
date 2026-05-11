//! Loopback media server — streams S3 objects over `http://127.0.0.1:<port>`.
//!
//! # Overview
//!
//! At app start, [`start_on_localhost`] spawns an `axum` HTTP server bound to
//! `127.0.0.1:0` (OS-assigned port).  The caller receives a
//! [`MediaServerHandle`] that carries the port, the shared
//! [`TokenRegistryHandle`], and a shutdown sender.
//!
//! The server exposes two routes:
//!
//! - `GET /m/:token` — validates the token, streams the S3 object (with
//!   optional byte-range support so video `<seek>` works).
//! - `GET /healthz` — returns `200 OK`; used by diagnostics and tests.
//!
//! # Range support
//!
//! The server forwards an `Range: bytes=START-END` header to the S3
//! `get_object` call and returns a `206 Partial Content` response with the
//! matching `Content-Range` header.
//!
//! # OCP
//!
//! - Adding a new route is one `.route(...)` call in `build_router`.
//! - The range parser ([`parse_range`]) is a pure function, independently
//!   testable, and reusable by other routes.
//! - [`TokenRegistry`] is decoupled from the server; swapping the storage
//!   backend requires only changing [`TokenRegistryHandle`].

pub mod tokens;

use std::sync::{Arc, Mutex};

use axum::{
    body::Body,
    extract::{Path, State as AxumState},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};

use tokio::{net::TcpListener, sync::oneshot};
use tokio_util::io::ReaderStream;

pub use tokens::{TokenRegistry, TokenRegistryHandle};

use crate::{error::AppError, s3::S3ClientPoolHandle};

// ---------------------------------------------------------------------------
// RangeSpec — parsed byte range
// ---------------------------------------------------------------------------

/// A parsed byte range from an HTTP `Range: bytes=…` header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RangeSpec {
    /// `bytes=START-END` (both bounds inclusive).
    Bounded { start: u64, end: u64 },
    /// `bytes=START-` (from START to end of file).
    From { start: u64 },
    /// `bytes=-SUFFIX` (last SUFFIX bytes).
    Suffix { last: u64 },
}

/// Parse `Range: bytes=<spec>` into a [`RangeSpec`].
///
/// Returns `None` for absent, malformed, or non-bytes range headers.
pub fn parse_range(header: &str) -> Option<RangeSpec> {
    let spec = header.strip_prefix("bytes=")?;
    if let Some(last_str) = spec.strip_prefix('-') {
        // bytes=-N  (suffix)
        let last: u64 = last_str.parse().ok()?;
        return Some(RangeSpec::Suffix { last });
    }
    let mut parts = spec.splitn(2, '-');
    let start_str = parts.next()?;
    let end_str = parts.next()?;
    let start: u64 = start_str.parse().ok()?;
    if end_str.is_empty() {
        // bytes=START-
        Some(RangeSpec::From { start })
    } else {
        // bytes=START-END
        let end: u64 = end_str.parse().ok()?;
        Some(RangeSpec::Bounded { start, end })
    }
}

/// Convert a [`RangeSpec`] into the `Range` header value forwarded to S3.
fn range_spec_to_s3(spec: &RangeSpec) -> String {
    match spec {
        RangeSpec::Bounded { start, end } => format!("bytes={start}-{end}"),
        RangeSpec::From { start } => format!("bytes={start}-"),
        RangeSpec::Suffix { last } => format!("bytes=-{last}"),
    }
}

// ---------------------------------------------------------------------------
// AppState — shared across all axum handlers
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct AppState {
    registry: TokenRegistryHandle,
    pool: S3ClientPoolHandle,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// `GET /healthz` — returns 200 OK for diagnostics.
async fn healthz() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

/// `GET /m/:token` — validate token and stream the S3 object.
async fn serve_media(
    Path(token): Path<String>,
    headers: HeaderMap,
    AxumState(state): AxumState<AppState>,
) -> Response {
    // 1. Token lookup — distinguish unknown (404) from expired (403).
    let record = match state.registry.lookup_with_status(&token) {
        Err(()) => {
            return (StatusCode::NOT_FOUND, "token not found").into_response();
        }
        Ok(None) => {
            return (StatusCode::FORBIDDEN, "token expired").into_response();
        }
        Ok(Some(r)) => r,
    };

    // 2. Parse optional Range header.
    let range_spec = headers
        .get(axum::http::header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_range);

    // 3. Build S3 client and call get_object.
    let client = match state
        .pool
        .inner
        .get_or_build(&record.profile_id, &record.region)
        .await
    {
        Some(c) => c,
        None => {
            eprintln!(
                "[media_server] no S3 client for profile {}",
                record.profile_id
            );
            return (StatusCode::INTERNAL_SERVER_ERROR, "s3 client unavailable").into_response();
        }
    };

    let mut req = client
        .get_object()
        .bucket(record.bucket.as_str())
        .key(&record.key);

    if let Some(ref spec) = range_spec {
        req = req.range(range_spec_to_s3(spec));
    }

    let output = match req.send().await {
        Ok(o) => o,
        Err(e) => {
            eprintln!("[media_server] get_object error: {e}");
            return (StatusCode::BAD_GATEWAY, "s3 error").into_response();
        }
    };

    // 4. Build response.
    let content_type = output
        .content_type()
        .unwrap_or("application/octet-stream")
        .to_owned();

    let content_length = output.content_length();
    let content_range = output.content_range().map(|s| s.to_owned());

    let stream = ReaderStream::new(output.body.into_async_read());
    let body = Body::from_stream(stream);

    let status = if range_spec.is_some() {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };

    // CORS: the loopback origin (127.0.0.1:<port>) is different from the
    // WebView origin (localhost:1420 in dev, tauri://localhost in release).
    // <img>/<video>/<audio>/<iframe> with crossorigin-less src bypass CORS,
    // but pdf.js uses fetch() under the hood and the browser rejects the
    // response without an explicit Access-Control-Allow-Origin header.
    //
    // We mint loopback URLs ourselves and the tokens are unguessable, so a
    // permissive `*` here doesn't expose anything an attacker couldn't get
    // by guessing the token first.
    let mut builder = axum::response::Response::builder()
        .status(status)
        .header(axum::http::header::CONTENT_TYPE, content_type)
        .header(axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");

    if let Some(len) = content_length {
        if len >= 0 {
            builder = builder.header(axum::http::header::CONTENT_LENGTH, len);
        }
    }
    if let Some(cr) = content_range {
        builder = builder.header("Content-Range", cr);
    }

    builder.body(body).unwrap_or_else(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, "response build error").into_response()
    })
}

// ---------------------------------------------------------------------------
// Router builder
// ---------------------------------------------------------------------------

fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        // axum 0.8 changed path-param syntax: ":token" → "{token}".
        .route("/m/{token}", get(serve_media))
        .with_state(state)
}

// ---------------------------------------------------------------------------
// MediaServerHandle — returned to the caller after startup
// ---------------------------------------------------------------------------

/// Handle to the running loopback media server.
///
/// Tauri manages this as app state so commands can read `port` and access the
/// `registry` to mint / revoke tokens.
///
/// The `shutdown` sender is wrapped in a `Mutex<Option<_>>` so that:
/// 1. `MediaServerHandle` is `Sync` (required by Tauri managed state).
/// 2. Shutdown can be triggered exactly once by taking the sender.
pub struct MediaServerHandle {
    /// The OS-assigned port the server is bound to.
    pub port: u16,
    /// Shared token registry — commands mint and revoke tokens here.
    pub registry: TokenRegistryHandle,
    /// Session identifier minted at app start; all tokens are tagged with this.
    /// `revoke_session` is called with this on app exit.
    pub session_id: String,
    /// Send `()` to trigger graceful shutdown (consume with `.lock().take()`).
    pub shutdown: Mutex<Option<oneshot::Sender<()>>>,
}

// ---------------------------------------------------------------------------
// start_on_localhost
// ---------------------------------------------------------------------------

/// Start the loopback media server and return a [`MediaServerHandle`].
///
/// Binds to `127.0.0.1:0` (OS-assigned port), spawns the server on the
/// current Tokio runtime, and returns immediately.
///
/// The caller is responsible for calling `handle.shutdown.send(())` on app
/// exit to stop the server, and calling `registry.revoke_session(session_id)`
/// to sweep all live tokens.
///
/// # Arguments
///
/// - `pool` — S3 client pool passed through to each request handler.
/// - `registry` — shared token registry.
/// - `session_id` — UUID v4 string minted at app start; tags all tokens.
pub async fn start_on_localhost(
    pool: S3ClientPoolHandle,
    registry: TokenRegistryHandle,
    session_id: String,
) -> Result<MediaServerHandle, AppError> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| AppError::Internal {
            trace_id: format!("media server bind: {e}"),
        })?;

    let port = listener
        .local_addr()
        .map_err(|e| AppError::Internal {
            trace_id: format!("media server local_addr: {e}"),
        })?
        .port();

    let state = AppState {
        registry: Arc::clone(&registry),
        pool,
    };

    let router = build_router(state);

    let (tx, rx) = oneshot::channel::<()>();

    tokio::spawn(async move {
        let server = axum::serve(listener, router).with_graceful_shutdown(async move {
            let _ = rx.await;
        });
        if let Err(e) = server.await {
            eprintln!("[media_server] exited with error: {e}");
        }
    });

    eprintln!("[media_server] listening on 127.0.0.1:{port}");

    Ok(MediaServerHandle {
        port,
        registry,
        session_id,
        shutdown: Mutex::new(Some(tx)),
    })
}

// ---------------------------------------------------------------------------
// Tests — range parser
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_range_bounded() {
        let spec = parse_range("bytes=0-1023").unwrap();
        assert_eq!(
            spec,
            RangeSpec::Bounded {
                start: 0,
                end: 1023
            }
        );
    }

    #[test]
    fn parse_range_open_ended() {
        let spec = parse_range("bytes=500-").unwrap();
        assert_eq!(spec, RangeSpec::From { start: 500 });
    }

    #[test]
    fn parse_range_suffix() {
        let spec = parse_range("bytes=-500").unwrap();
        assert_eq!(spec, RangeSpec::Suffix { last: 500 });
    }

    #[test]
    fn parse_range_missing_prefix_returns_none() {
        assert!(parse_range("0-1023").is_none());
    }

    #[test]
    fn parse_range_malformed_returns_none() {
        assert!(parse_range("bytes=abc-def").is_none());
    }

    #[test]
    fn parse_range_non_bytes_unit_returns_none() {
        assert!(parse_range("items=0-10").is_none());
    }

    #[test]
    fn range_spec_to_s3_bounded() {
        assert_eq!(
            range_spec_to_s3(&RangeSpec::Bounded {
                start: 0,
                end: 1023
            }),
            "bytes=0-1023"
        );
    }

    #[test]
    fn range_spec_to_s3_from() {
        assert_eq!(
            range_spec_to_s3(&RangeSpec::From { start: 500 }),
            "bytes=500-"
        );
    }

    #[test]
    fn range_spec_to_s3_suffix() {
        assert_eq!(
            range_spec_to_s3(&RangeSpec::Suffix { last: 500 }),
            "bytes=-500"
        );
    }
}
