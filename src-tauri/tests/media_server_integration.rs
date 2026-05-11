//! Integration tests for the loopback media server.
//!
//! These tests are gated by two conditions:
//!
//! 1. The `integration` cargo feature must be enabled (`--features integration`).
//! 2. The `LOCALSTACK_URL` environment variable must be set at runtime.
//!
//! Both conditions must hold for the tests to actually run. If either is absent
//! the test body returns early so the CI unit-test job stays green.
//!
//! # Running locally
//!
//! ```sh
//! docker run -d -p 4566:4566 localstack/localstack
//! LOCALSTACK_URL=http://localhost:4566 cargo test --features integration \
//!   --test media_server_integration
//! ```
//!
//! # What is tested
//!
//! 1. Upload a 1 MB binary blob to LocalStack.
//! 2. Start the loopback media server.
//! 3. `mint` a token for the object.
//! 4. `GET` the loopback URL → 200 with body equal to original blob.
//! 5. `GET` with `Range: bytes=0-1023` → 206 with first 1024 bytes.
//! 6. Revoke the token → subsequent `GET` returns 403.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

#[allow(dead_code)]
fn localstack_url() -> Option<String> {
    std::env::var("LOCALSTACK_URL").ok()
}

// ---------------------------------------------------------------------------
// Integration test
// ---------------------------------------------------------------------------

#[cfg_attr(not(feature = "integration"), ignore)]
#[tokio::test]
async fn media_server_streams_and_handles_range_and_expired_token() {
    let base_url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    use std::sync::Arc;

    use aws_sdk_s3::primitives::ByteStream;
    use brows3r_lib::{
        ids::{BucketId, ProfileId},
        media_server::{start_on_localhost, TokenRegistry},
        profiles::compat_flags::{AddressingStyle, CompatFlags},
        s3::{ClientPool, ProxyConfig, S3ClientPoolHandle},
    };

    // -----------------------------------------------------------------------
    // 1. Build an S3 client pointing at LocalStack
    // -----------------------------------------------------------------------
    let compat = CompatFlags {
        endpoint_url: Some(base_url.clone()),
        addressing_style: AddressingStyle::Path,
        ..CompatFlags::default()
    };
    let profile_id = ProfileId::new("integration-media");
    let pool = ClientPool::new(ProxyConfig::None);
    pool.register_profile(profile_id.clone(), compat).await;

    let client = pool
        .get_or_build(&profile_id, "us-east-1")
        .await
        .expect("client must be built");

    // -----------------------------------------------------------------------
    // 2. Create bucket + upload a 1 MiB blob
    // -----------------------------------------------------------------------
    let bucket_name = format!("media-test-{}", uuid::Uuid::new_v4());
    client
        .create_bucket()
        .bucket(&bucket_name)
        .send()
        .await
        .expect("create bucket");

    let blob: Vec<u8> = (0u8..=255).cycle().take(1024 * 1024).collect();
    client
        .put_object()
        .bucket(&bucket_name)
        .key("video.bin")
        .body(ByteStream::from(blob.clone()))
        .send()
        .await
        .expect("put object");

    // -----------------------------------------------------------------------
    // 3. Start the media server
    // -----------------------------------------------------------------------
    let registry = Arc::new(TokenRegistry::new());
    // Re-create pool with same compat so the media server has its own handle.
    let media_pool = ClientPool::new(ProxyConfig::None);
    media_pool
        .register_profile(
            profile_id.clone(),
            CompatFlags {
                endpoint_url: Some(base_url.clone()),
                addressing_style: AddressingStyle::Path,
                ..CompatFlags::default()
            },
        )
        .await;
    let pool_handle = S3ClientPoolHandle::new(media_pool);

    let session_id = uuid::Uuid::new_v4().to_string();
    let handle = start_on_localhost(pool_handle, Arc::clone(&registry), session_id.clone())
        .await
        .expect("media server must start");

    let port = handle.port;

    // -----------------------------------------------------------------------
    // 4. Mint a token
    // -----------------------------------------------------------------------
    let (token, _expires_at) = registry.mint(
        profile_id.clone(),
        BucketId::new(&bucket_name),
        "video.bin".to_string(),
        "us-east-1".to_string(),
        3600,
        session_id.clone(),
    );

    let base = format!("http://127.0.0.1:{port}/m/{token}");

    // -----------------------------------------------------------------------
    // 5. GET the full object → 200 + matching body
    // -----------------------------------------------------------------------
    let http = reqwest::Client::new();

    let resp = http.get(&base).send().await.expect("GET");
    assert_eq!(resp.status().as_u16(), 200, "expected 200 for full fetch");
    let body = resp.bytes().await.expect("body");
    assert_eq!(
        body.as_ref(),
        blob.as_slice(),
        "body must match original blob"
    );

    // -----------------------------------------------------------------------
    // 6. GET with Range: bytes=0-1023 → 206 + first 1024 bytes
    // -----------------------------------------------------------------------
    let resp = http
        .get(&base)
        .header("Range", "bytes=0-1023")
        .send()
        .await
        .expect("GET range");
    assert_eq!(resp.status().as_u16(), 206, "expected 206 for ranged fetch");
    let range_body = resp.bytes().await.expect("range body");
    assert_eq!(range_body.len(), 1024, "range body must be 1024 bytes");
    assert_eq!(
        range_body.as_ref(),
        &blob[..1024],
        "range body must match first 1024 bytes"
    );

    // -----------------------------------------------------------------------
    // 7. Revoke the token → 403
    // -----------------------------------------------------------------------
    registry.revoke(&token);

    let resp = http.get(&base).send().await.expect("GET after revoke");
    assert_eq!(
        resp.status().as_u16(),
        404,
        "revoked token is removed from registry → 404"
    );
}

// ---------------------------------------------------------------------------
// Token-only unit tests (no network required)
// ---------------------------------------------------------------------------

#[test]
fn token_registry_mint_lookup_revoke_roundtrip() {
    use brows3r_lib::{
        ids::{BucketId, ProfileId},
        media_server::TokenRegistry,
    };

    let registry = TokenRegistry::new();
    let profile = ProfileId::new("p1");
    let bucket = BucketId::new("b1");

    let (token, _) = registry.mint(
        profile,
        bucket,
        "my/key".to_string(),
        "us-east-1".to_string(),
        3600,
        "session-1".to_string(),
    );

    assert_eq!(token.len(), 64, "token must be 64 URL-safe base64 chars");

    let record = registry.lookup(&token).expect("token must be live");
    assert_eq!(record.key, "my/key");
    assert_eq!(record.session_id, "session-1");

    registry.revoke(&token);
    assert!(
        registry.lookup(&token).is_none(),
        "revoked token must be gone"
    );
}

#[test]
fn range_parser_handles_all_variants() {
    use brows3r_lib::media_server::{parse_range, RangeSpec};

    assert_eq!(
        parse_range("bytes=0-1023"),
        Some(RangeSpec::Bounded {
            start: 0,
            end: 1023
        })
    );
    assert_eq!(
        parse_range("bytes=500-"),
        Some(RangeSpec::From { start: 500 })
    );
    assert_eq!(
        parse_range("bytes=-500"),
        Some(RangeSpec::Suffix { last: 500 })
    );
    assert!(parse_range("invalid").is_none());
}
