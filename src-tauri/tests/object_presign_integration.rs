//! Integration tests for `object_presign` against a real S3-compatible endpoint.
//!
//! # Gate
//!
//! These tests are gated by two conditions:
//!
//! 1. The `integration` cargo feature must be enabled (`--features integration`).
//! 2. The `LOCALSTACK_URL` environment variable must be set at runtime.
//!
//! Both conditions must hold for the tests to actually run.  If either is
//! absent the test body returns early so the normal CI unit-test job stays
//! green.
//!
//! # Running locally
//!
//! ```sh
//! docker run -d -p 4566:4566 localstack/localstack
//! LOCALSTACK_URL=http://localhost:4566 cargo test --features integration \
//!   --test object_presign_integration
//! ```

#[allow(dead_code)]
fn localstack_url() -> Option<String> {
    std::env::var("LOCALSTACK_URL").ok()
}

// ---------------------------------------------------------------------------
// Helper: build a LocalStack S3 client
// ---------------------------------------------------------------------------

#[cfg(feature = "integration")]
async fn make_client(url: &str) -> aws_sdk_s3::Client {
    use brows3r_lib::{
        ids::ProfileId,
        profiles::compat_flags::{AddressingStyle, CompatFlags},
        s3::{ClientPool, ProxyConfig},
    };
    use std::sync::Arc;

    let profile_id = ProfileId::new_v4();
    let compat = CompatFlags {
        endpoint_url: Some(url.to_string()),
        addressing_style: AddressingStyle::Path,
        ..Default::default()
    };

    let pool = ClientPool::new(ProxyConfig::None);
    pool.register_profile(profile_id.clone(), compat).await;
    let arc = pool
        .get_or_build(&profile_id, "us-east-1")
        .await
        .expect("client must be built for registered profile");
    Arc::unwrap_or_clone(arc)
}

// ---------------------------------------------------------------------------
// Helper: create bucket + upload a small object
// ---------------------------------------------------------------------------

#[cfg(feature = "integration")]
async fn create_bucket_and_object(client: &aws_sdk_s3::Client, bucket: &str, key: &str) {
    // us-east-1 is the AWS S3 default region — no LocationConstraint must be
    // sent (recent aws-sdk-s3 even removed the `UsEast1` variant). Omitting
    // `create_bucket_configuration` keeps the bucket created in us-east-1.
    let _ = client.create_bucket().bucket(bucket).send().await;

    client
        .put_object()
        .bucket(bucket)
        .key(key)
        .body(aws_sdk_s3::primitives::ByteStream::from_static(
            b"hello presigned",
        ))
        .send()
        .await
        .expect("put_object must succeed");
}

// ---------------------------------------------------------------------------
// Test: presigned URL contains X-Amz-Signature
// ---------------------------------------------------------------------------

#[tokio::test]
async fn presigned_url_contains_amz_signature() {
    let url = match localstack_url() {
        Some(u) => u,
        None => return, // skip — LocalStack not running
    };

    #[cfg(feature = "integration")]
    {
        use brows3r_lib::s3::presign::presign_get_object;

        let client = make_client(&url).await;
        let bucket = "presign-sig-test";
        let key = "sample.txt";

        create_bucket_and_object(&client, bucket, key).await;

        let result = presign_get_object(&client, bucket, key, 3_600)
            .await
            .expect("presign must succeed");

        assert!(
            result.url.contains("X-Amz-Signature"),
            "presigned URL must contain X-Amz-Signature query param: {}",
            result.url
        );

        // expires_at must be in the future.
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        assert!(
            result.expires_at > now_ms,
            "expires_at must be in the future"
        );
    }

    #[cfg(not(feature = "integration"))]
    let _ = url; // silence unused-variable warning
}

// ---------------------------------------------------------------------------
// Test: presigned URL is fetchable (URL resolves the object)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn presigned_url_fetches_object_successfully() {
    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    #[cfg(feature = "integration")]
    {
        use brows3r_lib::s3::presign::presign_get_object;

        let client = make_client(&url).await;
        let bucket = "presign-fetch-test";
        let key = "fetch-me.txt";

        create_bucket_and_object(&client, bucket, key).await;

        let result = presign_get_object(&client, bucket, key, 3_600)
            .await
            .expect("presign must succeed");

        // Fetch via reqwest — should return HTTP 200 with the object body.
        let resp = reqwest::get(&result.url)
            .await
            .expect("reqwest::get must not fail at the transport level");

        assert!(
            resp.status().is_success(),
            "presigned URL must return 2xx; got {}",
            resp.status()
        );

        let body = resp.text().await.expect("body must be readable");
        assert_eq!(body, "hello presigned");
    }

    #[cfg(not(feature = "integration"))]
    let _ = url;
}

// ---------------------------------------------------------------------------
// Test: validation — expiry below minimum
// ---------------------------------------------------------------------------

#[test]
fn presign_expiry_below_minimum_is_rejected() {
    // This test exercises the pure validation path — no network needed.
    use brows3r_lib::s3::presign::{presign_get_object_validate_only, MIN_EXPIRES_SECS};

    let err = presign_get_object_validate_only(1).expect_err("expiry of 1 s must fail validation");
    let v = serde_json::to_value(&err).unwrap();
    assert_eq!(v["kind"], "Validation");
    assert_eq!(v["details"]["field"], "expires_secs");

    // Minimum boundary must be valid.
    presign_get_object_validate_only(MIN_EXPIRES_SECS)
        .expect("minimum expiry must pass validation");
}

// ---------------------------------------------------------------------------
// Test: validation — expiry above maximum
// ---------------------------------------------------------------------------

#[test]
fn presign_expiry_above_maximum_is_rejected() {
    use brows3r_lib::s3::presign::{presign_get_object_validate_only, MAX_EXPIRES_SECS};

    let err = presign_get_object_validate_only(MAX_EXPIRES_SECS + 1)
        .expect_err("expiry above 7 days must fail validation");
    let v = serde_json::to_value(&err).unwrap();
    assert_eq!(v["kind"], "Validation");
    assert_eq!(v["details"]["field"], "expires_secs");

    // Maximum boundary must be valid.
    presign_get_object_validate_only(MAX_EXPIRES_SECS)
        .expect("maximum expiry must pass validation");
}

// ---------------------------------------------------------------------------
// Note on "URL fails after expiry" test
// ---------------------------------------------------------------------------
//
// Testing that a presigned URL returns 403 after expiry would require either:
//   a) Waiting 60+ seconds for a short-expiry URL — impractical in CI.
//   b) A LocalStack time-travel API — not universally available.
//
// The expiry enforcement is ultimately a property of the AWS SigV4 protocol
// and is tested by the `expires_at` timestamp assertion above plus the
// boundary validation tests.  If LocalStack gains a reliable time-skew API in
// a future task, a 60-second expiry + sleep + re-fetch test can be added here.
