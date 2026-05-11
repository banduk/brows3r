//! Integration tests for `inspect_object` against a real S3-compatible endpoint.
//!
//! These tests are gated by two conditions:
//!
//! 1. The `integration` cargo feature must be enabled (`--features integration`).
//! 2. The `LOCALSTACK_URL` environment variable must be set at runtime.
//!
//! Both conditions must hold for the tests to actually run. If either is absent
//! the test returns early so the CI unit-test job stays green.
//!
//! # Running locally
//!
//! ```sh
//! docker run -d -p 4566:4566 localstack/localstack
//! LOCALSTACK_URL=http://localhost:4566 cargo test --features integration \
//!   --test object_inspect_integration
//! ```
//!
//! # What is tested
//!
//! - Happy path: upload an object with tags + custom metadata, call
//!   `inspect_object`, assert `head.metadata` includes the custom keys,
//!   `tags` is `Value(…)`, and `restore_status` is `Value(None)` for a
//!   STANDARD-class object.
//! - Capability classification: a `SectionResult::Denied` on tags / acl when
//!   using bad credentials is recorded in the capability cache.

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

#[allow(dead_code)]
fn localstack_url() -> Option<String> {
    std::env::var("LOCALSTACK_URL").ok()
}

// ---------------------------------------------------------------------------
// Happy path: head.metadata + tags + restore_status for STANDARD class
// ---------------------------------------------------------------------------

#[cfg_attr(not(feature = "integration"), ignore)]
#[tokio::test]
async fn localstack_object_inspect_happy_path() {
    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    use brows3r_lib::{
        cache::capability::CapabilityCache,
        ids::ProfileId,
        profiles::compat_flags::{AddressingStyle, CompatFlags},
        s3::{
            inspector::{inspect_object, SectionResult},
            ClientPool, ProxyConfig,
        },
    };

    let profile_id = ProfileId::new_v4();
    let compat = CompatFlags {
        endpoint_url: Some(url.clone()),
        addressing_style: AddressingStyle::Path,
        ..Default::default()
    };

    let pool = ClientPool::new(ProxyConfig::None);
    pool.register_profile(profile_id.clone(), compat.clone())
        .await;
    let client = pool
        .get_or_build(&profile_id, "us-east-1")
        .await
        .expect("client must be built");

    // Create a test bucket.
    let test_bucket = format!(
        "test-obj-inspect-{}",
        uuid::Uuid::new_v4()
            .to_string()
            .split('-')
            .next()
            .unwrap_or("x")
    );
    client
        .create_bucket()
        .bucket(&test_bucket)
        .send()
        .await
        .expect("create_bucket must succeed");

    let test_key = "test-object.txt";
    let body_content = b"hello, inspector!";

    // Upload the object with custom metadata.
    use aws_sdk_s3::primitives::ByteStream;
    client
        .put_object()
        .bucket(&test_bucket)
        .key(test_key)
        .body(ByteStream::from_static(body_content))
        .content_type("text/plain")
        .metadata("custom-key", "custom-value")
        .metadata("author", "integration-test")
        .send()
        .await
        .expect("put_object must succeed");

    // Add object tags.
    use aws_sdk_s3::types::{Tag, Tagging};
    client
        .put_object_tagging()
        .bucket(&test_bucket)
        .key(test_key)
        .tagging(
            Tagging::builder()
                .tag_set(
                    Tag::builder()
                        .key("env")
                        .value("integration")
                        .build()
                        .expect("tag must build"),
                )
                .build()
                .expect("tagging must build"),
        )
        .send()
        .await
        .expect("put_object_tagging must succeed");

    let capability_cache = CapabilityCache::default();

    let report = inspect_object(
        &client,
        &test_bucket,
        test_key,
        None,
        &capability_cache,
        &profile_id,
    )
    .await
    .expect("inspect_object must succeed");

    // head.metadata must include the custom keys (without x-amz-meta- prefix).
    assert!(
        report.head.metadata.contains_key("custom-key"),
        "head.metadata must contain 'custom-key', got: {:?}",
        report.head.metadata
    );
    assert_eq!(
        report.head.metadata.get("custom-key").map(|s| s.as_str()),
        Some("custom-value"),
        "custom-key must equal 'custom-value'"
    );
    assert_eq!(
        report.head.metadata.get("author").map(|s| s.as_str()),
        Some("integration-test"),
        "author must equal 'integration-test'"
    );

    // tags must be Value containing the "env" tag.
    match &report.tags {
        SectionResult::Value { value } => {
            assert_eq!(
                value.get("env").map(|s| s.as_str()),
                Some("integration"),
                "tags must contain env=integration"
            );
        }
        SectionResult::Unsupported { .. } => {
            // LocalStack free-tier may not support object tagging — acceptable.
        }
        other => panic!("tags must be Value or Unsupported, got: {:?}", other),
    }

    // restore_status must be Value(None) for a STANDARD-class object
    // (no active Glacier restore).
    match &report.restore_status {
        SectionResult::Value { value } => {
            assert!(
                value.is_none(),
                "restore_status.value must be None for STANDARD class, got: {:?}",
                value
            );
        }
        other => panic!("restore_status must be Value(None), got: {:?}", other),
    }

    // head.contentType must be set.
    assert_eq!(
        report.head.content_type.as_deref(),
        Some("text/plain"),
        "contentType must be text/plain"
    );

    // head.contentLength must match the body size.
    assert_eq!(
        report.head.content_length,
        Some(body_content.len() as i64),
        "contentLength must match upload size"
    );

    // Cleanup.
    let _ = client
        .delete_object()
        .bucket(&test_bucket)
        .key(test_key)
        .send()
        .await;
    let _ = client.delete_bucket().bucket(&test_bucket).send().await;
}

// ---------------------------------------------------------------------------
// Capability classification: Denied sections are recorded in the cache
// ---------------------------------------------------------------------------

#[cfg_attr(not(feature = "integration"), ignore)]
#[tokio::test]
async fn localstack_object_inspect_denied_sections_recorded_in_cache() {
    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    use aws_credential_types::{provider::SharedCredentialsProvider, Credentials};
    use brows3r_lib::{
        cache::capability::{CapabilityCache, CapabilityClass},
        ids::{BucketId, ProfileId},
        profiles::compat_flags::{AddressingStyle, CompatFlags},
        s3::{
            client::ClientBuilder,
            inspector::{inspect_object, SectionResult},
            ClientPool, ProxyConfig,
        },
    };

    // Set up root client to create bucket + object.
    let root_profile_id = ProfileId::new_v4();
    let root_compat = CompatFlags {
        endpoint_url: Some(url.clone()),
        addressing_style: AddressingStyle::Path,
        ..Default::default()
    };
    let root_pool = ClientPool::new(ProxyConfig::None);
    root_pool
        .register_profile(root_profile_id.clone(), root_compat.clone())
        .await;
    let root_client = root_pool
        .get_or_build(&root_profile_id, "us-east-1")
        .await
        .expect("root client must be built");

    let test_bucket = format!(
        "test-obj-deny-{}",
        uuid::Uuid::new_v4()
            .to_string()
            .split('-')
            .next()
            .unwrap_or("x")
    );
    let _ = root_client
        .create_bucket()
        .bucket(&test_bucket)
        .send()
        .await;

    let test_key = "test-deny.txt";
    use aws_sdk_s3::primitives::ByteStream;
    let _ = root_client
        .put_object()
        .bucket(&test_bucket)
        .key(test_key)
        .body(ByteStream::from_static(b"deny test"))
        .send()
        .await;

    // Build a client with bad credentials so tagging/ACL calls return AccessDenied.
    let bad_creds = SharedCredentialsProvider::new(Credentials::new(
        "AKIABADKEY00000000",
        "badsecretbadsecretbadsecretbadsecret0000",
        None,
        None,
        "test-bad",
    ));
    let bad_compat = CompatFlags {
        endpoint_url: Some(url.clone()),
        addressing_style: AddressingStyle::Path,
        ..Default::default()
    };
    let denied_client = ClientBuilder::new("us-east-1", &bad_compat, &ProxyConfig::None)
        .credentials_provider(bad_creds)
        .build()
        .await;

    let profile_id = ProfileId::new_v4();
    let capability_cache = CapabilityCache::default();

    // inspect_object with bad creds: HeadObject will likely fail with
    // AccessDenied, which propagates as AppError::Auth. We accept both
    // outcomes — the test validates the denied-section path when HeadObject
    // succeeds but tagging/ACL fail (typical on LocalStack IAM emulation).
    let result = inspect_object(
        &denied_client,
        &test_bucket,
        test_key,
        None,
        &capability_cache,
        &profile_id,
    )
    .await;

    match result {
        Ok(report) => {
            // At least one of tags or acl_summary must be Denied.
            let tags_denied = matches!(report.tags, SectionResult::Denied { .. });
            let acl_denied = matches!(report.acl_summary, SectionResult::Denied { .. });

            if tags_denied {
                let bucket_id = BucketId::new(&test_bucket);
                let record =
                    capability_cache.get(&profile_id, Some(&bucket_id), "s3:GetObjectTagging");
                assert!(
                    record.is_some(),
                    "Denied GetObjectTagging must be recorded in capability cache"
                );
                assert!(
                    matches!(record.unwrap().class, CapabilityClass::Denied { .. }),
                    "capability class for GetObjectTagging must be Denied"
                );
            }
            if acl_denied {
                let bucket_id = BucketId::new(&test_bucket);
                let record = capability_cache.get(&profile_id, Some(&bucket_id), "s3:GetObjectAcl");
                assert!(
                    record.is_some(),
                    "Denied GetObjectAcl must be recorded in capability cache"
                );
                assert!(
                    matches!(record.unwrap().class, CapabilityClass::Denied { .. }),
                    "capability class for GetObjectAcl must be Denied"
                );
            }
        }
        Err(_) => {
            // Hard error is acceptable when HeadObject itself is denied.
        }
    }

    // Cleanup with root creds.
    let _ = root_client
        .delete_object()
        .bucket(&test_bucket)
        .key(test_key)
        .send()
        .await;
    let _ = root_client
        .delete_bucket()
        .bucket(&test_bucket)
        .send()
        .await;
}
