//! Integration tests for `inspect_bucket` against a real S3-compatible endpoint.
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
//!   --test bucket_inspect_integration
//! ```
//!
//! # What is tested
//!
//! - Happy path: region, versioning, and tags sections return `Value` after
//!   creating a bucket with versioning enabled and adding tags.
//! - `bucket_policy` is always `Deferred { reason: "Deferred from v1" }`.
//! - Sections LocalStack does not implement return `Unsupported`.

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

#[allow(dead_code)]
fn localstack_url() -> Option<String> {
    std::env::var("LOCALSTACK_URL").ok()
}

// ---------------------------------------------------------------------------
// Happy path: region + versioning + tags are Value; bucket_policy is Deferred
// ---------------------------------------------------------------------------

#[cfg_attr(not(feature = "integration"), ignore)]
#[tokio::test]
async fn localstack_bucket_inspect_happy_path() {
    let url = match localstack_url() {
        Some(u) => u,
        None => return,
    };

    use brows3r_lib::{
        cache::capability::CapabilityCache,
        ids::ProfileId,
        profiles::compat_flags::{AddressingStyle, CompatFlags},
        s3::{
            inspector::{inspect_bucket, SectionResult, VersioningStatus},
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
        "test-inspect-{}",
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

    // Enable versioning.
    use aws_sdk_s3::types::{BucketVersioningStatus, VersioningConfiguration};
    client
        .put_bucket_versioning()
        .bucket(&test_bucket)
        .versioning_configuration(
            VersioningConfiguration::builder()
                .status(BucketVersioningStatus::Enabled)
                .build(),
        )
        .send()
        .await
        .expect("put_bucket_versioning must succeed");

    // Add tags.
    use aws_sdk_s3::types::{Tag, Tagging};
    client
        .put_bucket_tagging()
        .bucket(&test_bucket)
        .tagging(
            Tagging::builder()
                .tag_set(
                    Tag::builder()
                        .key("env")
                        .value("test")
                        .build()
                        .expect("tag must build"),
                )
                .build()
                .expect("tagging must build"),
        )
        .send()
        .await
        .expect("put_bucket_tagging must succeed");

    let capability_cache = CapabilityCache::default();

    let report = inspect_bucket(&client, &test_bucket, &capability_cache, &profile_id)
        .await
        .expect("inspect_bucket must succeed");

    // Region must have a Value.
    assert!(
        matches!(report.region, SectionResult::Value { .. }),
        "region must be Value, got: {:?}",
        report.region
    );

    // Versioning must be Enabled.
    match &report.versioning {
        SectionResult::Value { value } => {
            assert_eq!(
                *value,
                VersioningStatus::Enabled,
                "versioning must be Enabled"
            );
        }
        other => panic!("versioning must be Value, got: {:?}", other),
    }

    // Tags must contain the "env=test" tag.
    match &report.tags {
        SectionResult::Value { value } => {
            assert_eq!(
                value.get("env").map(|s| s.as_str()),
                Some("test"),
                "tags must contain env=test"
            );
        }
        SectionResult::Unsupported { .. } => {
            // LocalStack free-tier may not support bucket tagging — acceptable.
        }
        other => panic!("tags must be Value or Unsupported, got: {:?}", other),
    }

    // bucket_policy is always Deferred.
    match &report.bucket_policy {
        SectionResult::Deferred { reason } => {
            assert_eq!(reason, "Deferred from v1");
        }
        other => panic!("bucket_policy must be Deferred, got: {:?}", other),
    }

    // Lifecycle should be Value (empty list) or Unsupported.
    assert!(
        matches!(
            &report.lifecycle,
            SectionResult::Value { .. } | SectionResult::Unsupported { .. }
        ),
        "lifecycle must be Value or Unsupported, got: {:?}",
        report.lifecycle
    );

    // Cleanup.
    let _ = client.delete_bucket().bucket(&test_bucket).send().await;
}

// ---------------------------------------------------------------------------
// Denied section: AccessDenied → SectionResult::Denied + capability cache
// ---------------------------------------------------------------------------

#[cfg_attr(not(feature = "integration"), ignore)]
#[tokio::test]
async fn localstack_bucket_inspect_denied_section_recorded_in_cache() {
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
            inspector::{inspect_bucket, SectionResult},
            ClientPool, ProxyConfig,
        },
    };

    // First create a bucket with the root creds so we have something to inspect.
    let root_profile_id = ProfileId::new_v4();
    let root_compat = CompatFlags {
        endpoint_url: Some(url.clone()),
        addressing_style: AddressingStyle::Path,
        ..Default::default()
    };
    let root_pool = brows3r_lib::s3::ClientPool::new(ProxyConfig::None);
    root_pool
        .register_profile(root_profile_id.clone(), root_compat.clone())
        .await;
    let root_client = root_pool
        .get_or_build(&root_profile_id, "us-east-1")
        .await
        .expect("root client must be built");

    let test_bucket = format!(
        "test-deny-{}",
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

    // Build a client with bad credentials so most calls return AccessDenied.
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

    // inspect_bucket should not return an Err here — AccessDenied is per-section.
    // It may return Err if the bucket doesn't exist from the denied client's
    // perspective; we accept both outcomes.
    let report = inspect_bucket(&denied_client, &test_bucket, &capability_cache, &profile_id).await;

    match report {
        Ok(report) => {
            // At least one section must be Denied or Unsupported (bad creds on LocalStack).
            let any_denied = [
                matches!(report.versioning, SectionResult::Denied { .. }),
                matches!(report.encryption, SectionResult::Denied { .. }),
                matches!(report.tags, SectionResult::Denied { .. }),
            ];
            assert!(
                any_denied.iter().any(|&d| d),
                "at least one section must be Denied with bad credentials"
            );

            // Any Denied section must be recorded in the capability cache.
            if matches!(report.versioning, SectionResult::Denied { .. }) {
                let bucket_id = BucketId::new(&test_bucket);
                let record =
                    capability_cache.get(&profile_id, Some(&bucket_id), "s3:GetBucketVersioning");
                assert!(
                    record.is_some(),
                    "Denied versioning must be recorded in capability cache"
                );
                assert!(
                    matches!(record.unwrap().class, CapabilityClass::Denied { .. }),
                    "capability class must be Denied"
                );
            }
        }
        Err(_) => {
            // Hard error is acceptable when the bucket is invisible to bad creds.
        }
    }

    // Cleanup with root creds.
    let _ = root_client
        .delete_bucket()
        .bucket(&test_bucket)
        .send()
        .await;
}
