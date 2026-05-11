//! S3 client pool and per-(profile, region) client management.
//!
//! The canonical entry point for any module that needs to call S3 is
//! `ClientPool::get_or_build(profile_id, region)`.  All AWS SDK calls must go
//! through clients vended by this pool — never construct an `aws_sdk_s3::Client`
//! directly outside this module.

pub mod client;
pub mod cross_account;
pub mod inspector;
pub mod list;
pub mod metadata;
pub mod multipart;
pub mod object;
pub mod presign;
pub mod tags;

pub use client::{ClientPool, ProxyConfig};

use std::sync::Arc;

// ---------------------------------------------------------------------------
// S3ClientPoolHandle — Tauri managed state
// ---------------------------------------------------------------------------

/// Newtype around `Arc<ClientPool>` used as Tauri managed state.
///
/// Commands receive `tauri::State<S3ClientPoolHandle>`.
#[derive(Clone)]
pub struct S3ClientPoolHandle {
    pub inner: Arc<ClientPool>,
}

impl S3ClientPoolHandle {
    pub fn new(pool: ClientPool) -> Self {
        Self {
            inner: Arc::new(pool),
        }
    }
}
